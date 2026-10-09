import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountConfigSchema } from '../config/schema.js'
import { accountSchemaName } from '../ids.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { pendingMigrations } from './migrate.js'
import { listAccountSchemas, provisionAccount, provisionOperator } from './provision.js'
import { tablesFor } from './schema/account.js'
import { accounts } from './schema/operator.js'

/** Drizzle wraps driver errors; the constraint name lives on the cause. */
async function rootCause(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'no error'
  } catch (e) {
    let err = e as Error & { cause?: unknown }
    while (err.cause instanceof Error) err = err.cause as Error & { cause?: unknown }
    return err.message
  }
}

let tdb: TestDatabase
beforeAll(async () => {
  tdb = await createTestDatabase({ provision: false })
})
afterAll(async () => {
  await tdb.drop()
})

describe('migrations and provisioning', () => {
  it('applies operator migrations once and is idempotent', async () => {
    const first = await provisionOperator(tdb.handle)
    expect(first.applied).toEqual(['0001_init.sql'])
    const second = await provisionOperator(tdb.handle)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(['0001_init.sql'])
    expect(await pendingMigrations(tdb.handle.pool, 'operator', 'operator')).toEqual([])
  })

  it('provisions two isolated account schemas and registers the accounts', async () => {
    const a = AccountConfigSchema.parse({ id: 'main', type: 'web', display_name: 'Main', timezone: 'UTC' })
    const b = AccountConfigSchema.parse({ id: 'shop', type: 'cloud', display_name: 'Shop', timezone: 'UTC' })
    await provisionAccount(tdb.handle, a)
    await provisionAccount(tdb.handle, b)
    expect(await listAccountSchemas(tdb.handle)).toEqual(['acct_main', 'acct_shop'])
    const rows = await tdb.handle.db.select().from(accounts)
    expect(rows.map((r) => r.id).sort()).toEqual(['main', 'shop'])

    const tm = tablesFor(accountSchemaName('main'))
    const ts = tablesFor(accountSchemaName('shop'))
    await tdb.handle.db.insert(tm.chats).values({ id: '1@s.whatsapp.net', type: 'dm', name: 'One' })
    expect((await tdb.handle.db.select().from(tm.chats)).length).toBe(1)
    expect((await tdb.handle.db.select().from(ts.chats)).length).toBe(0)
  })

  it('re-provisioning updates the account row without re-running migrations', async () => {
    const a = AccountConfigSchema.parse({
      id: 'main',
      type: 'web',
      display_name: 'Renamed',
      timezone: 'Asia/Kolkata',
    })
    const r = await provisionAccount(tdb.handle, a)
    expect(r.applied).toEqual([])
    const [row] = await tdb.handle.db.select().from(accounts)
    expect(['Renamed', 'Shop']).toContain(row?.displayName)
  })

  it('enforces the dedup and seq uniqueness on events', async () => {
    const t = tablesFor('acct_main')
    const base = { type: 'message.received', chatId: 'c1', providerId: 'M1', occurredAt: new Date() }
    await tdb.handle.db.insert(t.events).values({ ...base, id: 'e1', seq: 1 })
    await expect(
      rootCause(tdb.handle.db.insert(t.events).values({ ...base, id: 'e2', seq: 2 })),
    ).resolves.toMatch(/events_dedup_uq/)
    await tdb.handle.db.insert(t.events).values({ ...base, id: 'e3', discriminator: 'r1:read', seq: 2 })
    await expect(
      rootCause(tdb.handle.db.insert(t.events).values({ ...base, id: 'e4', providerId: 'M9', seq: 2 })),
    ).resolves.toMatch(/events_chat_seq_uq/)
  })

  it('full-text search works on message bodies', async () => {
    const t = tablesFor('acct_main')
    await tdb.handle.db.insert(t.messages).values({
      id: 'm1',
      providerId: 'M1',
      chatId: 'c1',
      eventId: 'e1',
      type: 'text',
      body: 'please process my refund today',
      occurredAt: new Date(),
    })
    const r = await tdb.handle.pool.query(
      `select id from acct_main.messages where body_tsv @@ plainto_tsquery('simple', $1)`,
      ['refund'],
    )
    expect(r.rows.map((x) => x.id)).toEqual(['m1'])
  })
})
