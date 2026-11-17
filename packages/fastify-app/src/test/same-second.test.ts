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
   * Concurrent first-insert race: two webhook events for a NEW object in the
   * same second, processed in parallel. Writer A's INSERT commits between
   * writer B's prev snapshot (empty — A was still uncommitted) and B's
   * ON CONFLICT evaluation (which then skips on the equal timestamp). With
   * no row in prev, is_tie would be NULL and the write dropped without a
   * refetch — the same loss this patch exists to repair.
   *
   * Writer A is simulated as a plain uncommitted INSERT on a second
   * connection: the boundary being tested is only "a conflicting row
   * committed mid-statement", which an open transaction reproduces exactly.
   */
  test('f: concurrent insert commits between prev snapshot and conflict — still refetches', async () => {
    const id = `pi_same_second_f_${runId}`
    const created = 1700000600
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )
    const entity = succeededEvent.data.object as Stripe.PaymentIntent

    mockStripe.paymentIntents.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ ...entity, id })
    )

    const winner = await stripeSync.postgresClient.pool.connect()
    await winner.query('BEGIN')
    const {
      rows: [{ txid }],
    } = await winner.query<{ txid: string }>('select txid_current()::text as txid')
    await winner.query(
      `INSERT INTO stripe.payment_intents (id, status, last_synced_at)
       VALUES ($1, 'succeeded', to_timestamp($2))`,
      [id, created]
    )

    // This statement's prev snapshot is empty (A is uncommitted); its INSERT
    // then blocks on the speculative conflict until the winner commits.
    const blocked = stripeSync.upsertPaymentIntents(
      [entity],
      false,
      new Date(created * 1000).toISOString()
    )
    // Wait until B's statement is observably parked on A's uncommitted row:
    // a speculative-insertion conflict shows in pg_locks as a non-granted
    // transactionid lock on the winner's xid. Polling the database beats a
    // fixed sleep — a slow CI connection would otherwise let the winner
    // commit before B even arrives, silently skipping the prev-empty branch
    // under test.
    for (let i = 0; i < 100; i++) {
      const { rows } = await stripeSync.postgresClient.query(
        `select 1 from pg_locks
         where locktype = 'transactionid' and transactionid = $1::xid and not granted
         limit 1`,
        [txid]
      )
      if (rows.length) break
      if (i === 99) throw new Error('blocked upsert never waited on the winner transaction')
      await new Promise((r) => setTimeout(r, 20))
    }
    await winner.query('COMMIT')
    winner.release()
    await blocked

    expect(await paymentIntentStatus(id)).toEqual('succeeded')
    expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledTimes(1)
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

  /**
   * Wall-clock write then a same-second event: revalidated objects write
   * last_synced_at at millisecond precision (new Date()), so a same-second
   * event carrying event.created compares strictly-stale at ms resolution
   * even though the two cannot be ordered — the stored second IS the
   * attempted write's second. The repair path must still fire.
   *
   * Both events use the current wall-clock second because the revalidated
   * write is stamped at real now() — in production, events arrive promptly.
   */
  test('h: same-second event after a revalidated wall-clock write still refetches', async () => {
    const id = `pi_same_second_h_${runId}`
    const created = Math.floor(Date.now() / 1000)
    const createdEvent = await import(`./stripe/payment_intent_created.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'requires_payment_method')
    )
    const succeededEvent = await import(`./stripe/payment_intent_succeeded.json`).then(
      ({ default: d }) => cloneEvent(d as Stripe.Event, id, created, 'succeeded')
    )

    const config = getConfig()
    const revalidatingSync = new StripeSync({
      ...config,
      revalidateObjectsViaStripeApi: ['payment_intent'],
      poolConfig: {
        connectionString: config.databaseUrl,
      },
    })
    const stripe = Object.assign(revalidatingSync.stripe, mockStripe)
    vitest.spyOn(revalidatingSync, 'stripe', 'get').mockReturnValue(stripe)

    try {
      // The revalidating fetch observes the still-pre-terminal state Stripe
      // had at delivery time; the repair refetch sees canonical succeeded.
      mockStripe.paymentIntents.retrieve
        .mockResolvedValueOnce({ ...createdEvent.data.object })
        .mockResolvedValue({ ...succeededEvent.data.object })

      await revalidatingSync.processEvent(createdEvent)
      expect(await paymentIntentStatus(id)).toEqual('requires_payment_method')

      await revalidatingSync.processEvent(succeededEvent)
      expect(await paymentIntentStatus(id)).toEqual('succeeded')
      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledTimes(2)
    } finally {
      await revalidatingSync.postgresClient.close()
    }
  })
})
