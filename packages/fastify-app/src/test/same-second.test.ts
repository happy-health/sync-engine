import { StripeSync } from '@supabase/stripe-sync-engine'
import { vitest, beforeAll, describe, test, expect, afterEach } from 'vitest'
import { runMigrations } from '@supabase/stripe-sync-engine'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'
import type Stripe from 'stripe'

let stripeSync: StripeSync

beforeAll(async () => {
  const config = getConfig()
  await runMigrations({
    databaseUrl: config.databaseUrl,
    schema: config.schema,
    logger,
  })

  stripeSync = new StripeSync({
    ...config,
    poolConfig: {
      connectionString: config.databaseUrl,
    },
  })
  const stripe = Object.assign(stripeSync.stripe, mockStripe)
  vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)
})

afterEach(() => {
  vitest.clearAllMocks()
})

// Run-unique suffix: ids must not collide with rows left by earlier runs —
// repaired rows carry a wall-clock last_synced_at that stays newer than the
// historical event timestamps below and would mask every write as stale.
const runId = Math.random().toString(36).slice(2, 8)

/**
 * Clone a webhook fixture and normalize the fields the test controls:
 * a run-unique entity id (no cross-run row reuse), the event timestamp, and
 * the entity status carried by the webhook payload.
 */
function cloneEvent(
  eventBody: Stripe.Event,
  entityId: string,
  created: number,
  status: string
): Stripe.Event {
  const event = JSON.parse(JSON.stringify(eventBody)) as Stripe.Event
  event.created = created
  const object = event.data.object as { id: string; created: number; status: string }
  object.id = entityId
  object.created = created
  object.status = status
  return event
}

async function paymentIntentStatus(id: string): Promise<string> {
  const { rows } = await stripeSync.postgresClient.query(
    'select status from stripe.payment_intents where id = $1',
    [id]
  )
  return rows[0].status
}

async function setupIntentStatus(id: string): Promise<string> {
  const { rows } = await stripeSync.postgresClient.query(
    'select status from stripe.setup_intents where id = $1',
    [id]
  )
  return rows[0].status
}

describe('same-second upsert protection', () => {
  test('a: payment_intent.created then payment_intent.succeeded in the same second', async () => {
    const id = `pi_same_second_a_${runId}`
    const created = 1700000100
    const createdEvent = await import(`./stripe/payment_intent_created.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'requires_payment_method')
    )
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )

    mockStripe.paymentIntents.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ ...succeededEvent.data.object, id })
    )

    await stripeSync.processEvent(createdEvent)
    await stripeSync.processEvent(succeededEvent)

    expect(await paymentIntentStatus(id)).toEqual('succeeded')
    expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
  })

  test('b: payment_intent.created then payment_intent.succeeded one second later', async () => {
    const id = `pi_same_second_b_${runId}`
    const created = 1700000200
    const createdEvent = await import(`./stripe/payment_intent_created.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'requires_payment_method')
    )
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created + 1, 'succeeded')
    )

    await stripeSync.processEvent(createdEvent)
    await stripeSync.processEvent(succeededEvent)

    expect(await paymentIntentStatus(id)).toEqual('succeeded')
    // strictly newer timestamp applies directly, no refetch needed
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled()
  })

  test('c: payment_intent.succeeded then a stale payment_intent.created in the same second', async () => {
    const id = `pi_same_second_c_${runId}`
    const created = 1700000300
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )
    const staleCreatedEvent = await import(`./stripe/payment_intent_created.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'requires_payment_method')
    )

    mockStripe.paymentIntents.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ ...succeededEvent.data.object, id })
    )

    await stripeSync.processEvent(succeededEvent)
    await stripeSync.processEvent(staleCreatedEvent)

    expect(await paymentIntentStatus(id)).toEqual('succeeded')
    expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
  })

  test('d: payment_intent.succeeded replayed in the same second', async () => {
    const id = `pi_same_second_d_${runId}`
    const created = 1700000400
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )
    const replayedEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )

    mockStripe.paymentIntents.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ ...succeededEvent.data.object, id })
    )

    await stripeSync.processEvent(succeededEvent)
    await stripeSync.processEvent(replayedEvent)

    expect(await paymentIntentStatus(id)).toEqual('succeeded')
    expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
  })

  test('e: setup_intent.created then setup_intent.succeeded in the same second', async () => {
    const id = `seti_same_second_e_${runId}`
    const created = 1700000500
    const createdEvent = await import(`./stripe/setup_intent_created.json`).then(({ default: d }) =>
      cloneEvent(d as Stripe.Event, id, created, 'requires_payment_method')
    )
    const succeededEvent = await import(`./stripe/setup_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )

    mockStripe.setupIntents.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ ...succeededEvent.data.object, id })
    )

    await stripeSync.processEvent(createdEvent)
    await stripeSync.processEvent(succeededEvent)

    expect(await setupIntentStatus(id)).toEqual('succeeded')
    expect(mockStripe.setupIntents.retrieve).toHaveBeenCalledTimes(1)
  })

  /**
   * Strictly-stale control: a stored row written by a NEWER event must not
   * trigger a refetch at all — the guard is working as intended and the
   * repair path only fires on ties (or unknown-concurrent skips).
   */
  test('g: newer stored row beats a strictly-older event — no refetch', async () => {
    const id = `pi_same_second_g_${runId}`
    const created = 1700000700
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created + 1, 'succeeded')
    )
    const staleCreatedEvent = await import(`./stripe/payment_intent_created.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'requires_payment_method')
    )

    await stripeSync.processEvent(succeededEvent)
    await stripeSync.processEvent(staleCreatedEvent)

    expect(await paymentIntentStatus(id)).toEqual('succeeded')
    expect(mockStripe.paymentIntents.retrieve).not.toHaveBeenCalled()
  })
})
