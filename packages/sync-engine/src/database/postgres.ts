import pg, { PoolConfig, QueryResult } from 'pg'
import { pg as sql } from 'yesql'
import { EntitySchema } from '../schemas/types'

type PostgresConfig = {
  schema: string
  poolConfig: PoolConfig
}

export class PostgresClient {
  pool: pg.Pool

  constructor(private config: PostgresConfig) {
    this.pool = new pg.Pool(config.poolConfig)
  }

  async delete(table: string, id: string): Promise<boolean> {
    const prepared = sql(`
    delete from "${this.config.schema}"."${table}" 
    where id = :id
    returning id;
    `)({ id })
    const { rows } = await this.query(prepared.text, prepared.values)
    return rows.length > 0
  }

  async query(text: string, params?: string[]): Promise<QueryResult> {
    return this.pool.query(text, params)
  }

  async upsertMany<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(entries: T[], table: string, tableSchema: EntitySchema): Promise<T[]> {
    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: pg.QueryResult<T>[] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<pg.QueryResult<T>>[] = []
      chunk.forEach((entry) => {
        // Inject the values
        const cleansed = this.cleanseArrayField(entry)
        const upsertSql = this.constructUpsertSql(this.config.schema, table, tableSchema)

        const prepared = sql(upsertSql, {
          useNullForMissing: true,
        })(cleansed)

        queries.push(this.pool.query(prepared.text, prepared.values))
      })

      results.push(...(await Promise.all(queries)))
    }

    return results.flatMap((it) => it.rows)
  }

  async upsertManyWithTimestampProtection<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(
    entries: T[],
    table: string,
    tableSchema: EntitySchema,
    syncTimestamp?: string,
    refetchOnSkip?: (id: string) => Promise<T | undefined>
  ): Promise<T[]> {
    const timestamp = syncTimestamp || new Date().toISOString()

    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<pg.QueryResult>[] = []
      chunk.forEach((entry) => {
        // Inject the values
        const cleansed = this.cleanseArrayField(entry)
        // Add last_synced_at to the cleansed data for SQL parameter binding
        cleansed.last_synced_at = timestamp

        const upsertSql = this.constructUpsertWithTimestampProtectionSql(
          this.config.schema,
          table,
          tableSchema
        )

        const prepared = sql(upsertSql, {
          useNullForMissing: true,
        })(cleansed)

        queries.push(this.pool.query(prepared.text, prepared.values))
      })

      const chunkResults = await Promise.all(queries)

      // Repair is a webhook-path concern: callers pass a prebuilt callback (see
      // StripeSync.refetchCallbacks) for every entity that has a retrieve API,
      // but it only fires when a webhook syncTimestamp is present. Backfills
      // (no timestamp) already hold canonical data and must never fan out
      // per-row retrieves.
      if (!refetchOnSkip || syncTimestamp === undefined) continue

      for (let k = 0; k < chunkResults.length; k++) {
        // Each write reports {applied, is_tie} from a single statement
        // (writable CTE, one snapshot — see the builder below). A guard-skipped
        // UPDATE on an existing row (an INSERT always applies) is either a
        // same-second tie — webhook sync timestamps come from event.created at
        // integer-second resolution, so two events for one object inside the
        // same second produce equal last_synced_at values the strict `<` guard
        // cannot order — or a strictly-stale redelivery, which is the guard
        // working as intended and needs no repair.
        const verdict = chunkResults[k].rows[0] as { applied: boolean; is_tie: boolean | null }
        if (verdict.applied || !verdict.is_tie) continue

        // A tie is repaired by refetching canonical state from Stripe and
        // retrying the upsert once with a wall-clock timestamp: the refetched
        // content is authoritative, so it cannot regress the row, and
        // wall-clock is the domain the backfill paths already write in.
        //
        // Deliberately no per-entity locking: the residual
        // stale-read-last-write race is accepted and self-heals via
        // the next event or POST /sync/single/:id. If the retry is also skipped
        // a concurrent newer write won — leave it, do not loop.
        const entity = await refetchOnSkip(chunk[k].id)
        if (entity === undefined) continue

        const cleansed = this.cleanseArrayField(entity)
        cleansed.last_synced_at = new Date().toISOString()

        const retrySql = this.constructUpsertWithTimestampProtectionSql(
          this.config.schema,
          table,
          tableSchema
        )
        const prepared = sql(retrySql, {
          useNullForMissing: true,
        })(cleansed)

        await this.pool.query(prepared.text, prepared.values)
      }
    }

    // Upstream parity: the guarded upsert has no RETURNING clause, so
    // callers have always received an empty array from this method.
    return []
  }

  async findMissingEntries(table: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return []

    const prepared = sql(`
    select id from "${this.config.schema}"."${table}"
    where id=any(:ids::text[]);
    `)({ ids })

    const { rows } = await this.query(prepared.text, prepared.values)
    const existingIds = rows.map((it) => it.id)

    const missingIds = ids.filter((it) => !existingIds.includes(it))

    return missingIds
  }

  /**
   * Returns an (yesql formatted) upsert function based on the key/vals of an object.
   * eg,
   *  insert into customers ("id", "name")
   *  values (:id, :name)
   *  on conflict (id)
   *  do update set (
   *   "id" = :id,
   *   "name" = :name
   *  )
   */
  private constructUpsertSql(
    schema: string,
    table: string,
    tableSchema: EntitySchema,
    options?: {
      conflict?: string
    }
  ): string {
    const { conflict = 'id' } = options || {}
    const properties = tableSchema.properties

    return `
    insert into "${schema}"."${table}" (
      ${properties.map((x) => `"${x}"`).join(',')}
    )
    values (
      ${properties.map((x) => `:${x}`).join(',')}
    )
    on conflict (
      ${conflict}
    )
    do update set 
      ${properties.map((x) => `"${x}" = :${x}`).join(',')}
    ;`
  }

  /**
   * Returns an (yesql formatted) upsert statement with timestamp protection,
   * wrapped in a writable CTE that reports the outcome of the write in the
   * same statement. All CTE sub-statements share one snapshot, so `prev`
   * reflects the stored row version the ON CONFLICT guard evaluated — the
   * tie/stale verdict is not affected by a concurrent write landing between
   * separate queries.
   *
   * The WHERE clause in ON CONFLICT DO UPDATE only applies to the conflicting row
   * (the row being updated), not to all rows in the table. PostgreSQL ensures that
   * the condition is evaluated only for the specific row that conflicts with the INSERT.
   *
   * Returns one row: `{ applied, is_tie }`.
   *
   * - applied = true: the INSERT or the guarded UPDATE applied.
   * - applied = false: the guard skipped an UPDATE on an existing row
   *   (an INSERT always applies), i.e. stored last_synced_at >= attempted.
   * - is_tie (only meaningful when applied = false): stored <= attempted,
   *   i.e. equal — a same-second tie that is unresolvable locally.
   *   is_tie = false means strictly stale (stored > attempted).
   *
   * eg:
   *   WITH prev AS (
   *     SELECT last_synced_at FROM "stripe"."charges" WHERE id = :id
   *   ),
   *   upsert AS (
   *     INSERT INTO "stripe"."charges" (
   *       "id", "amount", "created", "last_synced_at"
   *     )
   *     VALUES (
   *       :id, :amount, :created, :last_synced_at
   *     )
   *     ON CONFLICT (id) DO UPDATE SET
   *       "amount" = EXCLUDED."amount",
   *       "created" = EXCLUDED."created",
   *       last_synced_at = :last_synced_at
   *     WHERE "charges"."last_synced_at" IS NULL
   *        OR "charges"."last_synced_at" < :last_synced_at
   *     RETURNING id
   *   )
   *   SELECT EXISTS (SELECT 1 FROM upsert) AS applied,
   *          COALESCE(
   *            (SELECT (last_synced_at <= :last_synced_at) FROM prev), true
   *          ) AS is_tie;
   */
  private constructUpsertWithTimestampProtectionSql = (
    schema: string,
    table: string,
    tableSchema: EntitySchema
  ): string => {
    const conflict = 'id'
    const properties = tableSchema.properties

    return `
      WITH prev AS (
        SELECT "last_synced_at" FROM "${schema}"."${table}"
        WHERE id = :id
      ),
      upsert AS (
        INSERT INTO "${schema}"."${table}" (
          ${properties.map((x) => `"${x}"`).join(',')}, "last_synced_at"
        )
        VALUES (
          ${properties.map((x) => `:${x}`).join(',')}, :last_synced_at
        )
        ON CONFLICT (${conflict}) DO UPDATE SET
          ${properties
            .filter((x) => x !== 'last_synced_at')
            .map((x) => `"${x}" = EXCLUDED."${x}"`)
            .join(',')},
          last_synced_at = :last_synced_at
        WHERE "${table}"."last_synced_at" IS NULL
           OR "${table}"."last_synced_at" < :last_synced_at
        RETURNING id
      )
      SELECT
        EXISTS (SELECT 1 FROM upsert) AS applied,
        -- A skipped upsert guarantees a stored row with ts >= attempted (the
        -- ON CONFLICT guard cannot fail otherwise). An empty prev then means
        -- the row was inserted by a concurrent writer mid-statement — tie or
        -- stale-concurrent, either way canonical refetch is safe.
        COALESCE(
          (SELECT ("last_synced_at" <= :last_synced_at) FROM prev), true
        ) AS is_tie;`
  }

  /**
   * For array object field like invoice.custom_fields
   * ex: [{"name":"Project name","value":"Test Project"}]
   *
   * we need to stringify it first cos passing array object directly will end up with
   * {
   * invalid input syntax for type json
   * detail: 'Expected ":", but found "}".',
   * where: 'JSON data, line 1: ...\\":\\"Project name\\",\\"value\\":\\"Test Project\\"}"}',
   * }
   */

  private cleanseArrayField(obj: {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  }): {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  } {
    const cleansed = { ...obj }
    Object.keys(cleansed).map((k) => {
      const data = cleansed[k]
      if (Array.isArray(data)) {
        cleansed[k] = JSON.stringify(data)
      }
    })
    return cleansed
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
