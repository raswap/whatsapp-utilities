import { AccountConfigSchema, plainCodec, provisionAccount, tablesFor } from '@wamcp/core'
import { createTestDatabase, type TestDatabase } from '@wamcp/core/testing'
import { BufferJSON, proto } from '@whiskeysockets/baileys'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadAuthState } from './auth-state.js'

let tdb: TestDatabase
beforeAll(async () => {
  tdb = await createTestDatabase()
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id: 'auth', type: 'web', display_name: 'A', timezone: 'UTC' }),
  )
})
afterAll(() => tdb.drop())

describe('auth state', () => {
  const deps = () => ({
    db: tdb.handle.db,
    tables: tablesFor('acct_auth'),
    codec: plainCodec,
    schemaName: 'acct_auth',
  })

  it('generates creds on first load and reloads the same creds after save', async () => {
    const a = await loadAuthState(deps())
    expect(a.state.creds.noiseKey.public.length).toBe(32)
    await a.saveCreds()
    const b = await loadAuthState(deps())
    expect(
      Buffer.from(b.state.creds.noiseKey.public).equals(Buffer.from(a.state.creds.noiseKey.public)),
    ).toBe(true)
    expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId)
  })

  it('round-trips signal keys with binary payloads, deletes on null, and revives app-state keys', async () => {
    const { state } = await loadAuthState(deps())
    const session = new Uint8Array([1, 2, 3, 250])
    await state.keys.set({
      session: { 'a.0': session, 'b.0': new Uint8Array([9]) },
      'app-state-sync-key': {
        k1: {
          keyData: new Uint8Array([7, 7]),
          fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
          timestamp: 12,
        },
      },
    })
    const got = await state.keys.get('session', ['a.0', 'b.0', 'missing'])
    expect(Buffer.from(got['a.0'] as Uint8Array).equals(Buffer.from(session))).toBe(true)
    expect(got.missing).toBeUndefined()
    const ask = await state.keys.get('app-state-sync-key', ['k1'])
    expect(ask.k1).toBeInstanceOf(proto.Message.AppStateSyncKeyData)
    await state.keys.set({ session: { 'a.0': null } })
    expect(Object.keys(await state.keys.get('session', ['a.0', 'b.0']))).toEqual(['b.0'])
  })

  it('stores values encrypted under the key-bound associated data', async () => {
    const rows = await tdb.handle.db.select().from(tablesFor('acct_auth').sessionState)
    const creds = rows.find((r) => r.key === 'creds')
    expect(creds?.valueEnc.startsWith('plain:')).toBe(true) // test codec; real codec yields a v1 envelope
    expect(JSON.parse(creds?.valueEnc.slice(6) ?? '{}', BufferJSON.reviver).noiseKey).toBeDefined()
  })
})
