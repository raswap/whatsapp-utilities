import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountConfigSchema } from '../config/schema.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { AuditLog } from './log.js'

let tdb: TestDatabase
beforeAll(async () => {
  tdb = await createTestDatabase()
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id: 'aud', type: 'web', display_name: 'A', timezone: 'UTC' }),
  )
})
afterAll(() => tdb.drop())

describe('audit log', () => {
  it('chains hashes and detects tampering', async () => {
    const t = tablesFor('acct_aud')
    const audit = new AuditLog(tdb.handle.db, t)
    const a = await audit.append({ actor: 'cli', kind: 'gate', decision: 'execute', detail: { check: null } })
    const b = await audit.append({ actor: 'cli', kind: 'action', decision: 'sent', subjectId: a.id })
    expect(b.prevHash).toBe(a.hash)
    expect(await audit.verify()).toEqual({ ok: true, count: 2 })
    await tdb.handle.db.execute(`update acct_aud.audit_log set decision = 'failed' where id = '${b.id}'`)
    expect(await audit.verify()).toEqual({ ok: false, brokenAtSeq: b.seq })
  })
  it('concurrent appends keep a single chain', async () => {
    const audit = new AuditLog(tdb.handle.db, tablesFor('acct_aud'))
    await tdb.handle.db.execute('delete from acct_aud.audit_log')
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => audit.append({ actor: 'x', kind: 'k', detail: { i } })),
    )
    expect(await audit.verify()).toEqual({ ok: true, count: 20 })
  })
  it('query filters by event, rule, chat, kind and time', async () => {
    const audit = new AuditLog(tdb.handle.db, tablesFor('acct_aud'))
    await tdb.handle.db.execute('delete from acct_aud.audit_log')
    const e = await audit.append({
      actor: 'x',
      kind: 'gate',
      eventId: 'E1',
      ruleId: 'R1',
      chatId: 'c@s.whatsapp.net',
    })
    await audit.append({ actor: 'x', kind: 'action' })
    const q = (o: Parameters<AuditLog['query']>[0]) => audit.query(o).then((r) => r.map((x) => x.id))
    expect(await q({ eventId: 'E1' })).toEqual([e.id])
    expect(await q({ ruleId: 'R1', chatId: 'c@s.whatsapp.net', kind: 'gate', limit: 1 })).toEqual([e.id])
    expect(await q({ since: new Date(Date.now() + 60_000) })).toEqual([])
    expect(await q({ until: new Date(Date.now() + 60_000) })).toHaveLength(2)
  })
})
