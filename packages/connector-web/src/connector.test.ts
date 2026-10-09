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
import { DisconnectReason, fetchLatestBaileysVersion, type WAMessageKey } from '@whiskeysockets/baileys'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type SocketConfigLike,
  type SocketLike,
  WebConnector,
  type WebConnectorOptions,
} from './connector.js'

vi.mock('@whiskeysockets/baileys', async (orig) => ({
  ...(await orig<typeof import('@whiskeysockets/baileys')>()),
  fetchLatestBaileysVersion: vi.fn(),
}))

let tdb: TestDatabase
const log = pino({ level: 'silent' })

class FakeSocket extends EventEmitter implements SocketLike {
  user: { id: string } | undefined = { id: '919999000000:12@s.whatsapp.net' }
  sent: Array<{ jid: string; content: unknown; options?: { messageId?: string } }> = []
  read: WAMessageKey[][] = []
  presence: Array<[string, string | undefined]> = []
  failWith: Error | null = null
  pairingError: Error | null = null
  loggedOut = false
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
  async readMessages(keys: WAMessageKey[]) {
    this.read.push(keys)
  }
  async sendPresenceUpdate(type: string, toJid?: string) {
    this.presence.push([type, toJid])
  }
  async requestPairingCode() {
    if (this.pairingError) throw this.pairingError
    return 'ABCD-EFGH'
  }
  async fetchMessageHistory() {
    return 'req-1'
  }
  end() {}
  async logout() {
    this.loggedOut = true
  }
}

const closeWith = (s: FakeSocket, code: number) =>
  s.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: new Boom('x', { statusCode: code }) },
  })
const msg = (id: string, remoteJid = 'a@s.whatsapp.net', messageTimestamp = 1_780_000_000) => ({
  key: { remoteJid, fromMe: false, id },
  message: { conversation: 'hi' },
  messageTimestamp,
})

async function waitFor(cond: () => boolean, timeoutMs = 5000, poll?: () => Promise<void>) {
  const start = Date.now()
  await poll?.()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 2))
    await poll?.()
  }
}

async function rig(over: Partial<WebConnectorOptions> & { handler?: false } = {}) {
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
  if (over.handler !== false)
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

  it('constructor defaults, double handler guard, and deliver without a handler', async () => {
    const bare = new WebConnector({
      accountId: 'x',
      db: tdb.handle.db,
      tables: tablesFor('acct_x'),
      codec: plainCodec,
      schemaName: 'acct_x',
      log,
    })
    bare.onEvent(async () => {})
    expect(() => bare.onEvent(async () => {})).toThrow(/already registered/)
    await expect(bare.requestHistory('a@s.whatsapp.net', null, 1)).rejects.toThrow(/not connected/)

    const { c, sockets } = await rig({ handler: false })
    const s = sockets[0] as FakeSocket
    s.emit('messages.upsert', { type: 'notify', messages: [msg('M1')] })
    s.emit('connection.update', { connection: 'open' })
    expect(c.health().lastEventAt).toBeNull()
  })

  it('uses the fetched WhatsApp Web version and falls back when the fetch fails', async () => {
    vi.mocked(fetchLatestBaileysVersion).mockResolvedValueOnce({ version: [2, 3, 4], isLatest: true })
    const ok = await rig({ fetchVersion: true })
    expect(ok.configs[0]?.version).toEqual([2, 3, 4])
    vi.mocked(fetchLatestBaileysVersion).mockRejectedValueOnce(new Error('offline'))
    const fallback = await rig({ fetchVersion: true })
    expect(fallback.configs[0]?.version).toBeUndefined()
  })

  it('pairing: QR callback, pairing code for a phone, and a failed code request', async () => {
    const qrs: string[] = []
    const qr = await rig({ onQr: (q) => qrs.push(q) })
    ;(qr.sockets[0] as FakeSocket).emit('connection.update', { qr: 'QR1' })
    await waitFor(() => qrs.length === 1)
    expect(qr.c.health().state).toBe('pairing')

    const codes: string[] = []
    const pair = await rig({ pairingPhone: '+91 99990 00000', onPairingCode: (code) => codes.push(code) })
    ;(pair.sockets[0] as FakeSocket).emit('connection.update', { qr: 'QR1' })
    await waitFor(() => codes.length === 1)
    expect(codes).toEqual(['ABCD-EFGH'])

    const broken = await rig({ pairingPhone: '1', onPairingCode: (code) => codes.push(code) })
    ;(broken.sockets[0] as FakeSocket).pairingError = new Error('nope')
    ;(broken.sockets[0] as FakeSocket).emit('connection.update', { qr: 'QR1' })
    await waitFor(() => broken.c.health().state === 'pairing')
    expect(codes).toHaveLength(1)
  })

  it('open without a user keeps the previous selfJid; stub type 2 counts a decrypt failure', async () => {
    const { c, sockets, events } = await rig()
    const s = sockets[0] as FakeSocket
    s.user = undefined
    s.emit('connection.update', { connection: 'open' })
    s.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: 'S1' }, messageStubType: 2 }],
    })
    await waitFor(() => events.some((e) => e.type === 'message.sent'))
    expect(c.health().decryptFailures).toBe(1)
    expect(events.find((e) => e.type === 'message.sent')?.senderJid).toBeUndefined()
  })

  it('restart-required reconnects at once; a close from a replaced socket is ignored', async () => {
    const { c, sockets, sleeps } = await rig()
    closeWith(sockets[0] as FakeSocket, DisconnectReason.restartRequired)
    await waitFor(() => sockets.length === 2)
    expect(sleeps).toEqual([])
    expect(c.metrics.reconnects).toBe(1)
    ;(sockets[1] as FakeSocket).emit('connection.update', { connection: 'open' })
    closeWith(sockets[0] as FakeSocket, DisconnectReason.loggedOut)
    expect(c.health().state).toBe('connected')
    expect(c.health().lastErrorKind).toBe('close:515')
  })

  it('non-Boom close, custom backoff, and degraded after too long without a connection', async () => {
    const { c, sockets, sleeps, states, clock } = await rig({
      backoff: { baseMs: 100, capMs: 200 },
      degradedAfterMs: 1000,
    })
    ;(sockets[0] as FakeSocket).emit('connection.update', { connection: 'close', lastDisconnect: {} })
    await waitFor(() => sockets.length === 2)
    expect(c.health().lastErrorKind).toBe('close')
    expect(sleeps[0]).toBeLessThanOrEqual(120)
    clock.advance(2000)
    closeWith(sockets[1] as FakeSocket, 408)
    await waitFor(() => sockets.length === 3)
    expect(states).toContain('degraded')
    expect(sleeps[1]).toBe(3600_000)
  })

  it('conflict wait defaults to 30 s', async () => {
    const { sockets, sleeps } = await rig()
    closeWith(sockets[0] as FakeSocket, DisconnectReason.connectionReplaced)
    await waitFor(() => sockets.length === 2)
    expect(sleeps).toEqual([30_000])
  })

  it('stop during a reconnect sleep cancels the reconnect', async () => {
    let release: () => void = () => {}
    const { c, sockets } = await rig({
      sleep: () =>
        new Promise<void>((r) => {
          release = r
        }),
    })
    closeWith(sockets[0] as FakeSocket, 408)
    await waitFor(() => c.health().state === 'reconnecting')
    await c.stop()
    release()
    await new Promise((r) => setImmediate(r))
    expect(sockets).toHaveLength(1)
    expect(c.health().state).toBe('disconnected')
    await expect(c.requestHistory('a@s.whatsapp.net', null, 1)).rejects.toThrow(/not connected/)
  })

  it('send paths: mentions, quoted, reactions, mark read, typing, and errors without a message', async () => {
    const { c, sockets } = await rig()
    const s = sockets[0] as FakeSocket
    s.emit('connection.update', { connection: 'open' })
    s.emit('messages.upsert', { type: 'notify', messages: [msg('M1')] })
    await waitFor(() => c.health().lastInboundAt !== null)
    const chatId = 'a@s.whatsapp.net'
    await c.send({
      kind: 'send_message',
      chatId,
      text: 'hi',
      messageId: 'I1',
      mentions: ['b@s.whatsapp.net'],
      quotedProviderId: 'M1',
    })
    expect(s.sent[0]?.content).toEqual({ text: 'hi', mentions: ['b@s.whatsapp.net'] })
    expect(s.sent[0]?.options).toMatchObject({ quoted: { key: { id: 'M1' } } })
    await c.send({ kind: 'react_to_message', chatId, providerId: 'M1', emoji: '👍', messageId: 'I2' })
    await c.send({ kind: 'react_to_message', chatId, providerId: 'M9', emoji: null, messageId: 'I3' })
    expect(s.sent[1]?.content).toEqual({
      react: { text: '👍', key: { remoteJid: chatId, fromMe: false, id: 'M1' } },
    })
    expect(s.sent[2]?.content).toEqual({
      react: { text: '', key: { remoteJid: chatId, fromMe: false, id: 'M9' } },
    })
    await c.send({ kind: 'mark_read', chatId, providerIds: ['M1', 'M9'], messageId: 'I4' })
    expect(s.read[0]?.map((k) => k.id)).toEqual(['M1', 'M9'])
    await c.send({ kind: 'set_typing', chatId, typing: true, messageId: 'I5' })
    await c.send({ kind: 'set_typing', chatId, typing: false, messageId: 'I6' })
    expect(s.presence).toEqual([
      ['composing', chatId],
      ['paused', chatId],
    ])
    const blank = new Error()
    ;(blank as { message?: string }).message = undefined
    s.failWith = blank
    await expect(c.send({ kind: 'send_message', chatId, text: 'x', messageId: 'I7' })).rejects.toMatchObject({
      frameWritten: true,
    })
    expect(c.health().lastErrorKind).toBe('send:error')
  })

  it('history request without an anchor id uses the oldest known message in the chat', async () => {
    const { c, sockets, events } = await rig()
    const s = sockets[0] as FakeSocket
    s.emit('connection.update', { connection: 'open' })
    s.emit('messages.upsert', {
      type: 'notify',
      messages: [msg('M2', 'a@s.whatsapp.net', 1_780_000_100), msg('M1')],
    })
    await waitFor(() => events.filter((e) => e.type === 'message.received').length === 2)
    expect(await c.requestHistory('a@s.whatsapp.net', null, 20)).toEqual({ requestId: 'req-1' })
  })

  it('history sync honours the cutoff and maps chats, contacts and lid mappings', async () => {
    const { c, sockets, events } = await rig()
    const s = sockets[0] as FakeSocket
    s.emit('messaging-history.set', {
      chats: [{ id: 'g@g.us', lastMessageRecvTimestamp: 1_780_000_000 }, { id: 'h@g.us' }, {}],
      contacts: [{ id: '91555@s.whatsapp.net', notify: 'Bo' }, {}],
      lidPnMappings: [{ pn: '91555@s.whatsapp.net', lid: '1@lid' }],
      messages: [msg('OLD', 'b@s.whatsapp.net', 1_700_000_000), msg('NEW', 'b@s.whatsapp.net')],
    })
    s.emit('messaging-history.set', {})
    await waitFor(() => events.length === 4)
    expect(events.slice(1).map((e) => [e.type, e.providerId ?? e.senderJid])).toEqual([
      ['contact.updated', '91555@s.whatsapp.net'],
      ['contact.updated', '91555@s.whatsapp.net'],
      ['message.received', 'NEW'],
    ])
    expect((await c.listChatsSnapshot()).map((e) => e.chatId)).toEqual([
      'g@g.us',
      'h@g.us',
      'b@s.whatsapp.net',
    ])
  })

  it('maps status, receipt, delete, reaction, chat, contact, group, call and presence events', async () => {
    const { sockets, events } = await rig()
    const s = sockets[0] as FakeSocket
    s.emit('connection.update', { connection: 'open' })
    const key = { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: 'M1' }
    s.emit('messages.update', [
      { key, update: { status: 4 } },
      { key, update: {} },
    ])
    s.emit('message-receipt.update', [
      {
        key: { ...key, remoteJid: 'g@g.us' },
        receipt: { userJid: 'b@s.whatsapp.net', readTimestamp: 1_780_000_000 },
      },
    ])
    s.emit('messages.delete', { keys: [key, { id: 'X' }] })
    s.emit('messages.delete', {})
    s.emit('messages.reaction', [
      { key, reaction: { text: '❤' } },
      {
        key: { remoteJid: 'g@g.us', fromMe: false, id: 'M2', participant: 'b@s.whatsapp.net' },
        reaction: { text: '' },
      },
      { key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'M3' }, reaction: {} },
      { key: { id: 'M4' }, reaction: {} },
    ])
    s.emit('chats.upsert', [
      { id: 'c@s.whatsapp.net', lastMessageRecvTimestamp: 1_780_000_000, archived: true },
      { id: 'd@s.whatsapp.net' },
      {},
    ])
    s.emit('chats.update', [{ id: 'c@s.whatsapp.net', pinned: 1 }])
    s.emit('contacts.upsert', [{ id: '91555@s.whatsapp.net' }, {}])
    s.emit('contacts.update', [{ id: '91555@s.whatsapp.net', name: 'Bo' }, {}])
    s.emit('lid-mapping.update', { pn: '91555@s.whatsapp.net', lid: '1@lid' })
    s.emit('group-participants.update', {
      id: 'g@g.us',
      author: 'a@s.whatsapp.net',
      action: 'add',
      participants: [{ id: 'b@s.whatsapp.net' }],
    })
    s.emit('groups.update', [{ id: 'g@g.us', subject: 'New' }])
    s.emit('call', [
      { id: 'C1', from: 'a@s.whatsapp.net', status: 'offer', date: new Date(), isGroup: false },
      { id: 'C2', from: 'a@s.whatsapp.net', status: 'accept', date: new Date(), isGroup: false },
    ])
    s.emit('presence.update', {
      id: 'a@s.whatsapp.net',
      presences: { 'a@s.whatsapp.net': { lastKnownPresence: 'composing' } },
    })
    await waitFor(() => events.length === 17)
    // Lanes are per chat, so only the sorted multiset of event types is deterministic.
    expect(events.map((e) => e.type).sort()).toEqual(
      [
        'connection.state',
        'connection.state',
        'message.status',
        'message.status',
        'message.deleted',
        'message.reaction',
        'message.reaction',
        'message.reaction',
        'chat.archived',
        'chat.pinned',
        'contact.updated',
        'contact.updated',
        'contact.updated',
        'group.participant_added',
        'group.subject_changed',
        'call.incoming',
        'presence.updated',
      ].sort(),
    )
    const reactions = events.filter((e) => e.type === 'message.reaction')
    expect(reactions.map((e) => [e.senderJid, (e.payload as { emoji: string | null }).emoji])).toEqual([
      ['919999000000@s.whatsapp.net', '❤'],
      ['b@s.whatsapp.net', null],
      ['a@s.whatsapp.net', null],
    ])
  })

  it('handler errors are logged, and caches are bounded', async () => {
    const { c, sockets } = await rig({ handler: false })
    let calls = 0
    c.onEvent(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
    })
    const s = sockets[0] as FakeSocket
    const messages = Array.from({ length: 5001 }, (_, i) => msg(`K${i}`))
    s.emit('messages.upsert', { type: 'notify', messages })
    await waitFor(() => calls === 5001)
    expect(c.metrics.handlerLatencyMs).toHaveLength(1000)
    await expect(c.requestHistory('a@s.whatsapp.net', 'K0', 1)).rejects.toThrow(/anchor/)
  })

  it('logout ends the session and wipes the stored auth state', async () => {
    const { c, sockets } = await rig()
    const s = sockets[0] as FakeSocket
    s.emit('creds.update', {})
    const sessionState = tablesFor(`acct_${c.accountId}`).sessionState
    let saved = 0
    await waitFor(
      () => saved > 0,
      5000,
      async () => {
        saved = (await tdb.handle.db.select().from(sessionState)).length
      },
    )
    await c.logout()
    expect(s.loggedOut).toBe(true)
    const rows = await tdb.handle.db.select().from(tablesFor(`acct_${c.accountId}`).sessionState)
    expect(rows).toEqual([])
    s.end = () => {
      throw new Error('already closed') // stop() must swallow this
    }
    await c.stop()
    await c.logout() // no socket: clear only
  })
})
