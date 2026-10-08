import type { AccountTables, Codec, Db } from '@wamcp/core'
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import { inArray } from 'drizzle-orm'

export interface AuthStateDeps {
  db: Db
  tables: AccountTables
  codec: Codec
  schemaName: string
}

const CREDS_KEY = 'creds'

/**
 * Baileys authentication state backed by the account's `session_state` table (PRD FR-A3,
 * tech-stack T6). Every value is encrypted with associated data bound to the account and key,
 * so a row cannot be replayed into another account. Writes are awaited by the library before it
 * proceeds, which keeps the Signal ratchet on disk in step with what the socket has consumed.
 */
export async function loadAuthState(
  d: AuthStateDeps,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; clear: () => Promise<void> }> {
  const { sessionState } = d.tables
  const aad = (key: string) => `session_state:${d.schemaName}:${key}`

  const readRaw = async (keys: string[]): Promise<Map<string, string>> => {
    if (keys.length === 0) return new Map()
    const rows = await d.db
      .select({ key: sessionState.key, valueEnc: sessionState.valueEnc })
      .from(sessionState)
      .where(inArray(sessionState.key, keys))
    return new Map(rows.map((r) => [r.key, d.codec.decrypt(r.valueEnc, aad(r.key))]))
  }

  const writeRaw = async (entries: Array<{ key: string; value: string | null }>) => {
    if (entries.length === 0) return
    await d.db.transaction(async (tx) => {
      const dels = entries.filter((e) => e.value === null).map((e) => e.key)
      if (dels.length) await tx.delete(sessionState).where(inArray(sessionState.key, dels))
      for (const e of entries) {
        if (e.value === null) continue
        const valueEnc = d.codec.encrypt(e.value, aad(e.key))
        await tx
          .insert(sessionState)
          .values({ key: e.key, valueEnc, updatedAt: new Date() })
          .onConflictDoUpdate({ target: sessionState.key, set: { valueEnc, updatedAt: new Date() } })
      }
    })
  }

  const stored = (await readRaw([CREDS_KEY])).get(CREDS_KEY)
  const creds: AuthenticationCreds = stored ? JSON.parse(stored, BufferJSON.reviver) : initAuthCreds()

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const raw = await readRaw(ids.map((id) => `${type}:${id}`))
        const out: { [id: string]: SignalDataTypeMap[T] } = {}
        for (const id of ids) {
          const v = raw.get(`${type}:${id}`)
          if (v === undefined) continue
          let value = JSON.parse(v, BufferJSON.reviver)
          if (type === 'app-state-sync-key' && value)
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          out[id] = value as SignalDataTypeMap[T]
        }
        return out
      },
      async set(data: SignalDataSet) {
        const entries: Array<{ key: string; value: string | null }> = []
        for (const type of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
          const byId = data[type]
          if (!byId) continue
          for (const [id, value] of Object.entries(byId)) {
            entries.push({
              key: `${type}:${id}`,
              value:
                value === null || value === undefined ? null : JSON.stringify(value, BufferJSON.replacer),
            })
          }
        }
        await writeRaw(entries)
      },
      async clear() {
        await d.db.delete(sessionState)
      },
    },
  }

  return {
    state,
    saveCreds: () => writeRaw([{ key: CREDS_KEY, value: JSON.stringify(state.creds, BufferJSON.replacer) }]),
    clear: async () => {
      await d.db.delete(sessionState)
    },
  }
}
