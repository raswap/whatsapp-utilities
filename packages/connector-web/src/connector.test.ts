import { EventEmitter } from 'node:events'
import { Boom } from '@hapi/boom'
import {
  AccountConfigSchema,
  ManualClock,
  plainCodec,
  provisionAccount,
  type RawEvent,
  tablesFor,
} from '@wamcp/core'
import { createTestDatabase, type TestDatabase } from '@wamcp/core/testing'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type SocketConfigLike, type SocketLike, WebConnector } from './connector.js'

let tdb: TestDatabase
const log = pino({ level: 'silent' })

class FakeSocket extends EventEmitter implements SocketLike {
  user = { id: '919999000000:12@s.whatsapp.net' }
  sent: Array<{ jid: string; content: unknown; options?: { messageId?: string } }> = []
  failWith: Error | null = null
  get ev() {
    return {
      on: (event: string, listener: (...args: never[]) => void) =>
        this.on(event, listener as (...args: unknown[]) => void),
    }
  }
  async sendMessage(jid: string, content: unknown, options?: { messageId?: string }) {
    if (this.failWith) throw this.failWith
    this.sent.push({ jid, content, options })
    return {}
  }
  async readMessages() {}
  async sendPresenceUpdate() {}
  async requestPairingCode() {
    return 'ABCD-EFGH'
  }
  async fetchMessageHistory() {
    return 'req-1'
  }
  end() {}
  async logout() {}
}

async function waitFor(cond: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 2))
  }
}

async function rig(over: { conflictWaitMs?: number } = {}) {
  const id = `wc${Math.random().toString(36).slice(2, 7)}`
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id, type: 'web', display_name: id, timezone: 'UTC' }),
  )
  const sockets: FakeSocket[] = []
  const configs: SocketConfigLike[] = []
  const sleeps: number[] = []
  const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
  const events: RawEvent[] = []
  const states: string[] = []
  const c = new WebConnector({
    accountId: id,
    db: tdb.handle.db,
    tables: tablesFor(`acct_${id}`),
    codec: plainCodec,
    schemaName: `acct_${id}`,
    log,
    fetchVersion: false,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    socketFactory: (cfg) => {
      configs.push(cfg)
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    onState: (s) => states.push(s),
    ...over,
  })
  c.onEvent(async (e) => {
    events.push(e)
  })
  await c.start()
  return { c, sockets, configs, sleeps, events, states, clock }
}

beforeAll(async () => {
  tdb = await createTestDatabase()
})
afterAll(() => tdb.drop())

describe('web connector', () => {
  it('starts with auth state from Postgres, opens, and maps upserts with source by type', async () => {
    const { c, sockets, configs, events } = await rig()
    expect(configs[0]?.markOnlineOnConnect).toBe(false)
    const firstCfg = configs[0] as SocketConfigLike
    expect((firstCfg.auth as { creds: { registrationId: number } }).creds.registrationId).toBeGreaterThan(0)
    const s = sockets[0] as FakeSocket
    s.emit('connection.update', { connection: 'open' })
    expect(c.health().state).toBe('connected')
    s.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'M1' },
          message: { conversation: 'hi' },
          messageTimestamp: 1_780_000_000,
        },
      ],
    })
    s.emit('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: '3EB0X' },
          message: { conversation: 'old' },
          messageTimestamp: 1_780_000_000,
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 20))
    const msgs = events.filter((e) => e.type.startsWith('message.'))
    expect(msgs.map((e) => [e.providerId, e.source, e.senderJid])).toEqual([
      ['M1', 'live', 'a@s.whatsapp.net'],
      ['3EB0X', 'history', '919999000000@s.whatsapp.net'],
    ])
    expect(c.health().lastInboundAt).not.toBeNull()
    expect((await c.listChatsSnapshot())[0]).toMatchObject({
      chatId: 'a@s.whatsapp.net',
      lastMessageId: '3EB0X',
    })
  })

  it('reconnects with capped backoff on ordinary closes and gives up on logged_out', async () => {
    const { c, sockets, sleeps, states } = await rig()
    const close = (code: number) =>
      (sockets.at(-1) as FakeSocket).emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: new Boom('x', { statusCode: code }) },
      })
    for (let i = 0; i < 7; i++) {
      close(408)
      await waitFor(() => sockets.length === i + 2)
    }
    expect(sockets.length).toBe(8)
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(20_000 * 1.2)
    expect(sleeps[0]).toBeLessThanOrEqual(1200)
    expect(states.filter((s) => s === 'reconnecting').length).toBeGreaterThan(0)
    close(401)
    await waitFor(() => c.health().state === 'logged_out')
    expect(c.health().state).toBe('logged_out')
    expect(sockets.length).toBe(8)
  })

  it('conflict: waits and retries once, then logs out', async () => {
    const { c, sockets, sleeps } = await rig({ conflictWaitMs: 30_000 })
    const close = () =>
      (sockets.at(-1) as FakeSocket).emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: new Boom('replaced', { statusCode: 440 }) },
      })
    close()
    await waitFor(() => sockets.length === 2)
    expect(sleeps).toContain(30_000)
    expect(sockets.length).toBe(2)
    close()
    await waitFor(() => c.health().state === 'logged_out')
    expect(c.health().state).toBe('logged_out')
    expect(sockets.length).toBe(2)
  })

  it('send uses the pre-generated id, rejects when not connected, and classifies frameWritten', async () => {
    const { c, sockets } = await rig()
    const notYet = await c.send({
      kind: 'send_message',
      chatId: 'a@s.whatsapp.net',
      text: 'x',
      messageId: '3EB0ID',
    })
    expect(notYet).toMatchObject({ outcome: 'rejected', frameWritten: false })
    const s = sockets[0] as FakeSocket
    s.emit('connection.update', { connection: 'open' })
    const ok = await c.send({
      kind: 'send_message',
      chatId: 'a@s.whatsapp.net',
      text: 'hello',
      messageId: '3EB0ID',
      quotedProviderId: 'nope',
    })
    expect(ok).toEqual({ outcome: 'accepted', frameWritten: true })
    expect(s.sent[0]).toMatchObject({
      jid: 'a@s.whatsapp.net',
      content: { text: 'hello' },
      options: { messageId: '3EB0ID' },
    })
    s.failWith = new Boom('Connection Closed', { statusCode: 428 })
    await expect(
      c.send({ kind: 'send_message', chatId: 'a@s.whatsapp.net', text: 'x', messageId: '3EB0I2' }),
    ).rejects.toMatchObject({ frameWritten: false })
    s.failWith = new Error('Timed Out')
    await expect(
      c.send({ kind: 'send_message', chatId: 'a@s.whatsapp.net', text: 'x', messageId: '3EB0I3' }),
    ).rejects.toMatchObject({ frameWritten: true })
  })

  it('history requests need an anchor and pass it to the socket', async () => {
    const { c, sockets } = await rig()
    const s = sockets[0] as FakeSocket
    s.emit('connection.update', { connection: 'open' })
    await expect(c.requestHistory('a@s.whatsapp.net', null, 20)).rejects.toThrow(/anchor/)
    s.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'M1' },
          message: { conversation: 'hi' },
          messageTimestamp: 1_780_000_000,
        },
      ],
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(await c.requestHistory('a@s.whatsapp.net', 'M1', 20)).toEqual({ requestId: 'req-1' })
  })
})
