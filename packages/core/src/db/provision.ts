import { eq } from 'drizzle-orm'
import type { AccountConfig } from '../config/schema.js'
import { accountSchemaName } from '../ids.js'
import type { DbHandle } from './client.js'
import { applyMigrations } from './migrate.js'
import { accounts } from './schema/operator.js'

export const OPERATOR_SCHEMA = 'operator'

/** Brings the operator schema up to date. Idempotent. */
export async function provisionOperator(h: DbHandle) {
  return applyMigrations(h.pool, 'operator', OPERATOR_SCHEMA)
}

/** Creates or updates the account row and brings its schema up to date. Idempotent. */
export async function provisionAccount(h: DbHandle, cfg: AccountConfig) {
  const schema = accountSchemaName(cfg.id)
  const result = await applyMigrations(h.pool, 'account', schema)
  const existing = await h.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, cfg.id))
  if (existing.length === 0) {
    await h.db.insert(accounts).values({
      id: cfg.id,
      type: cfg.type,
      displayName: cfg.display_name,
      timezone: cfg.timezone,
      settings: { business_hours: cfg.business_hours, persona: cfg.persona, limits: cfg.limits },
    })
  } else {
    await h.db
      .update(accounts)
      .set({
        type: cfg.type,
        displayName: cfg.display_name,
        timezone: cfg.timezone,
        settings: { business_hours: cfg.business_hours, persona: cfg.persona, limits: cfg.limits },
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, cfg.id))
  }
  return { schema, ...result }
}

export async function listAccountSchemas(h: DbHandle): Promise<string[]> {
  const r = await h.pool.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname like 'acct\\_%' order by nspname`,
  )
  return r.rows.map((x) => x.nspname)
}
