import type { Boom } from '@hapi/boom'
import type {
  AccountTables,
  Capability,
  ChatSnapshotEntry,
  Clock,
  Codec,
  Connector,
  ConnectorHealth,
  ConnectorState,
  Db,
  HistoryRequestHandle,
  RawEvent,
  RawEventHandler,
  SendCommand,
  SendResult,
} from '@wamcp/core'
import { systemClock } from '@wamcp/core'
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  type WAMessageKey,
} from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import { loadAuthState } from './auth-state.js'
import {
  callToRaw,
  chatUpdateToRaw,
  contactToRaw,
  groupUpdateToRaw,
  messageToRaw,
  participantsToRaw,
  receiptToRaw,
  statusUpdateToRaw,
  tsToDate,
} from './mapping.js'

/** The subset of a Baileys socket the connector touches; injectable for tests. */
export interface SocketLike {
  ev: {
    on(event: string, listener: (...args: never[]) => void): unknown
    removeAllListeners?(event?: string): unknown
  }
  user?: { id: string } | undefined
  sendMessage(
    jid: string,
    content: unknown,
    options?: { messageId?: string; quoted?: unknown },
  ): Promise<unknown>
  readMessages(keys: WAMessageKey[]): Promise<void>
  sendPresenceUpdate(
    type: 'composing' | 'paused' | 'available' | 'unavailable',
    toJid?: string,
  ): Promise<void>
  requestPairingCode(phone: string): Promise<string>
  fetchMessageHistory(count: number, oldestKey: WAMessageKey, oldestTs: number): Promise<string>
  end(err?: Error): void
  logout(): Promise<void>
}

export interface SocketConfigLike {
  auth: unknown
  logger: unknown
  version?: readonly [number, number, number]
  browser: readonly [string, string, string]
  markOnlineOnConnect: boolean
  syncFullHistory: boolean
  shouldSyncHistoryMessage: (msg: { syncType?: number | null; chunkOrder?: number | null }) => boolean
  getMessage: (key: WAMessageKey) => Promise<undefined>
  generateHighQualityLinkPreview: boolean
}

export interface WebConnectorOptions {
  accountId: string
  db: Db
  tables: AccountTables
  codec: Codec
  schemaName: string
  log: Logger
  historyDays?: number
  /** Request a pairing code for this E.164 number instead of showing a QR. */
  pairingPhone?: string
  onQr?: (qr: string) => void
  onPairingCode?: (code: string) => void
  onState?: (state: ConnectorState, reason?: string) => void
  socketFactory?: (cfg: SocketConfigLike) => Promise<SocketLike> | SocketLike
  fetchVersion?: boolean
  clock?: Clock
  sleep?: (ms: number) => Promise<void>
  backoff?: { baseMs: number; capMs: number }
  conflictWaitMs?: number
  degradedAfterMs?: number
}

const LIBRARY_VERSION = '7.0.0-rc14'

/**
 * WhatsApp Web connector on Baileys (PRD §6, §8.1). The socket is created per connection attempt;
 * the state machine lives here, not in the library.
 */
export class WebConnector implements Connector {
  readonly accountId: string
  readonly capabilities: ReadonlySet<Capability> = new Set([
    'groups',
    'reactions',
    'presence',
    'media',
    'edit',
    'delete',
    'history_request',
  ])
  private handler: RawEventHandler | null = null
  private sock: SocketLike | null = null
  private state: ConnectorState = 'disconnected'
  private stopping = false
  private attempt = 0
  private firstFailureAt: number | null = null
  private conflictRetried = false
  private lastEventAt: Date | null = null
  private lastInboundAt: Date | null = null
  private lastErrorKind: string | null = null
  private decryptFailures = 0
  private selfJid: string | undefined
  private readonly log: Logger
  private readonly clock: Clock
  private readonly sleep: (ms: number) => Promise<void>
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly keyCache = new Map<string, { key: WAMessageKey; ts: number }>()
  private readonly chatSnapshot = new Map<string, ChatSnapshotEntry>()
  private saveCreds: (() => Promise<void>) | null = null
  readonly metrics = { handlerLatencyMs: [] as number[], reconnects: 0 }

  constructor(private readonly o: WebConnectorOptions) {
    this.accountId = o.accountId
    this.log = o.log.child({ component: 'connector-web', account: o.accountId })
    this.clock = o.clock ?? systemClock
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  onEvent(handler: RawEventHandler) {
    if (this.handler) throw new Error('WebConnector: handler already registered')
    this.handler = handler
  }

  health(): ConnectorHealth {
    return {
      state: this.state,
      lastEventAt: this.lastEventAt,
      lastInboundAt: this.lastInboundAt,
      lastErrorKind: this.lastErrorKind,
      decryptFailures: this.decryptFailures,
      libraryVersion: LIBRARY_VERSION,
    }
  }

  private setState(s: ConnectorState, reason?: string) {
    if (s === this.state) return
    this.state = s
    this.log.info({ state: s, reason }, 'connection state')
    this.o.onState?.(s, reason)
    void this.deliver({
      type: 'connection.state',
      occurredAt: this.clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { state: s, ...(reason ? { reason } : {}) },
    })
  }

  async start() {
    this.stopping = false
    await this.connect()
  }

  async stop() {
    this.stopping = true
    const s = this.sock
    this.sock = null
    try {
      s?.end(undefined)
    } catch {
      /* ignore */
    }
    this.setState('disconnected', 'stopped')
    await Promise.all([...this.lanes.values()])
  }

  private async connect() {
    if (this.stopping) return
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const { state, saveCreds } = await loadAuthState({
      db: this.o.db,
      tables: this.o.tables,
      codec: this.o.codec,
      schemaName: this.o.schemaName,
    })
    this.saveCreds = saveCreds
    let version: readonly [number, number, number] | undefined
    if (this.o.fetchVersion !== false) {
      try {
        version = (await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(5000) })).version
      } catch (e) {
        this.log.warn(
          { err: (e as Error).message },
          'could not fetch WhatsApp Web version; using library default',
        )
      }
    }
    const historyCutoffS = Math.floor(this.clock.now().getTime() / 1000) - (this.o.historyDays ?? 30) * 86_400
    const cfg: SocketConfigLike = {
      auth: state,
      logger: this.log.child({ lib: 'baileys' }, { level: 'warn' }),
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu('wamcp'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => (this.o.historyDays ?? 30) > 0,
      getMessage: async () => undefined,
      generateHighQualityLinkPreview: false,
    }
    const factory =
      this.o.socketFactory ??
      ((c: SocketConfigLike) =>
        makeWASocket(c as unknown as Parameters<typeof makeWASocket>[0]) as unknown as SocketLike)
    const sock = await factory(cfg)
    this.sock = sock
    this.wire(sock, historyCutoffS)
  }

  private wire(sock: SocketLike, historyCutoffS: number) {
    const on = <T>(event: string, fn: (arg: T) => void | Promise<void>) => sock.ev.on(event, fn as never)

    on<{ connection?: string; lastDisconnect?: { error?: Error }; qr?: string; isNewLogin?: boolean }>(
      'connection.update',
      async (u) => {
        if (u.qr) {
          this.setState('pairing', 'qr')
          if (this.o.pairingPhone && !this.o.onQr) {
            try {
              const code = await sock.requestPairingCode(this.o.pairingPhone.replace(/\D/g, ''))
              this.o.onPairingCode?.(code)
            } catch (e) {
              this.log.error({ err: (e as Error).message }, 'pairing code request failed')
            }
          } else this.o.onQr?.(u.qr)
        }
        if (u.connection === 'open') {
          this.attempt = 0
          this.firstFailureAt = null
          this.conflictRetried = false
          this.selfJid = sock.user?.id ? sock.user.id.replace(/:\d+@/, '@') : this.selfJid
          this.setState('connected')
        }
        if (u.connection === 'close') {
          // A socket we already replaced may still emit a close; only the live one drives the state machine.
          if (this.sock !== sock) return
          await this.onClose(u.lastDisconnect?.error)
        }
      },
    )

    on<Record<string, unknown>>('creds.update', async () => {
      await this.saveCreds?.()
    })

    on<{ messages: Parameters<typeof messageToRaw>[0][]; type: 'notify' | 'append' }>(
      'messages.upsert',
      async ({ messages, type }) => {
        for (const m of messages) {
          if (m.messageStubType === 2) this.decryptFailures++
          this.remember(m)
          const raw = messageToRaw(m, {
            source: type === 'notify' ? 'live' : 'history',
            ...(this.selfJid ? { selfJid: this.selfJid } : {}),
          })
          if (raw) await this.deliver(raw)
        }
      },
    )

    on<{
      messages: Parameters<typeof messageToRaw>[0][]
      chats: Array<{ id?: string | null; lastMessageRecvTimestamp?: number; name?: string | null }>
      contacts: Array<Parameters<typeof contactToRaw>[0]>
      lidPnMappings?: Array<{ pn: string; lid: string }>
    }>('messaging-history.set', async (h) => {
      for (const c of h.chats ?? []) {
        if (c.id)
          this.chatSnapshot.set(c.id, {
            chatId: c.id,
            ...(c.lastMessageRecvTimestamp
              ? { lastMessageAt: new Date(c.lastMessageRecvTimestamp * 1000) }
              : {}),
          })
      }
      for (const c of h.contacts ?? []) {
        const raw = contactToRaw(c)
        if (raw) await this.deliver(raw)
      }
      for (const m of h.lidPnMappings ?? []) {
        await this.deliver({
          type: 'contact.updated',
          senderJid: m.pn,
          occurredAt: this.clock.now(),
          isFromMe: false,
          source: 'history',
          payload: {},
          identityHints: [{ jid: m.lid, kind: 'lid', sameAs: m.pn }],
        })
      }
      for (const m of h.messages ?? []) {
        const ts = tsToDate(m.messageTimestamp).getTime() / 1000
        if (ts < historyCutoffS) continue
        this.remember(m)
        const raw = messageToRaw(m, { source: 'history', ...(this.selfJid ? { selfJid: this.selfJid } : {}) })
        if (raw) await this.deliver(raw)
      }
    })

    on<Parameters<typeof statusUpdateToRaw>[0][]>('messages.update', async (updates) => {
      for (const u of updates) {
        const raw = statusUpdateToRaw(u, this.selfJid)
        if (raw) await this.deliver(raw)
      }
    })
    on<Parameters<typeof receiptToRaw>[0][]>('message-receipt.update', async (updates) => {
      for (const u of updates) for (const raw of receiptToRaw(u, this.selfJid)) await this.deliver(raw)
    })
    on<{ keys?: WAMessageKey[] }>('messages.delete', async (d) => {
      for (const k of d.keys ?? []) {
        if (k.remoteJid && k.id)
          await this.deliver({
            type: 'message.deleted',
            providerId: k.id,
            chatId: k.remoteJid,
            occurredAt: this.clock.now(),
            isFromMe: k.fromMe === true,
            source: 'live',
            payload: {},
          })
      }
    })
    on<
      Array<{
        key: WAMessageKey
        reaction: { text?: string | null; key?: WAMessageKey | null; senderTimestampMs?: number | null }
      }>
    >('messages.reaction', async (rs) => {
      for (const r of rs) {
        const reactor = r.key.fromMe ? this.selfJid : (r.key.participant ?? r.key.remoteJid)
        if (!r.key.remoteJid || !r.key.id || !reactor) continue
        await this.deliver({
          type: 'message.reaction',
          providerId: r.key.id,
          chatId: r.key.remoteJid,
          senderJid: reactor,
          occurredAt: this.clock.now(),
          isFromMe: r.key.fromMe === true,
          source: 'live',
          payload: { reactorJid: reactor, emoji: r.reaction.text ? r.reaction.text : null },
        })
      }
    })
    on<Parameters<typeof chatUpdateToRaw>[0][]>('chats.upsert', async (chats) => {
      for (const c of chats) {
        if (c.id)
          this.chatSnapshot.set(c.id, {
            chatId: c.id,
            ...(c.lastMessageRecvTimestamp
              ? { lastMessageAt: new Date(c.lastMessageRecvTimestamp * 1000) }
              : {}),
          })
        for (const raw of chatUpdateToRaw(c)) await this.deliver(raw)
      }
    })
    on<Parameters<typeof chatUpdateToRaw>[0][]>('chats.update', async (chats) => {
      for (const c of chats) for (const raw of chatUpdateToRaw(c)) await this.deliver(raw)
    })
    on<Parameters<typeof contactToRaw>[0][]>('contacts.upsert', async (cs) => {
      for (const c of cs) {
        const raw = contactToRaw(c)
        if (raw) await this.deliver(raw)
      }
    })
    on<Parameters<typeof contactToRaw>[0][]>('contacts.update', async (cs) => {
      for (const c of cs) {
        const raw = contactToRaw(c)
        if (raw) await this.deliver(raw)
      }
    })
    on<{ pn: string; lid: string }>('lid-mapping.update', async (m) => {
      await this.deliver({
        type: 'contact.updated',
        senderJid: m.pn,
        occurredAt: this.clock.now(),
        isFromMe: false,
        source: 'live',
        payload: {},
        identityHints: [{ jid: m.lid, kind: 'lid', sameAs: m.pn }],
      })
    })
    on<Parameters<typeof participantsToRaw>[0]>('group-participants.update', async (u) => {
      for (const raw of participantsToRaw(u)) await this.deliver(raw)
    })
    on<Parameters<typeof groupUpdateToRaw>[0][]>('groups.update', async (gs) => {
      for (const g of gs) for (const raw of groupUpdateToRaw(g)) await this.deliver(raw)
    })
    on<Parameters<typeof callToRaw>[0][]>('call', async (calls) => {
      for (const c of calls) {
        const raw = callToRaw(c)
        if (raw) await this.deliver(raw)
      }
    })
    on<{ id: string; presences: Record<string, { lastKnownPresence: string }> }>(
      'presence.update',
      async (p) => {
        for (const [who, data] of Object.entries(p.presences)) {
          await this.deliver({
            type: 'presence.updated',
            chatId: p.id,
            senderJid: who,
            occurredAt: this.clock.now(),
            isFromMe: false,
            source: 'live',
            payload: { state: data.lastKnownPresence },
          })
        }
      },
    )
  }

  private remember(m: { key: WAMessageKey; messageTimestamp?: number | { toNumber(): number } | null }) {
    if (!m.key.id || !m.key.remoteJid) return
    const ts = tsToDate(m.messageTimestamp as never).getTime() / 1000
    this.keyCache.set(m.key.id, { key: m.key, ts })
    if (this.keyCache.size > 5000) {
      const first = this.keyCache.keys().next().value
      if (first) this.keyCache.delete(first)
    }
    const prev = this.chatSnapshot.get(m.key.remoteJid)
    if (!prev?.lastMessageAt || prev.lastMessageAt.getTime() / 1000 <= ts) {
      this.chatSnapshot.set(m.key.remoteJid, {
        chatId: m.key.remoteJid,
        lastMessageId: m.key.id,
        lastMessageAt: new Date(ts * 1000),
      })
    }
  }

  private async onClose(err: Error | undefined) {
    if (this.stopping) return
    const code = (err as Boom | undefined)?.output?.statusCode
    this.lastErrorKind = code ? `close:${code}` : 'close'
    this.sock = null
    switch (code) {
      case DisconnectReason.loggedOut:
      case DisconnectReason.forbidden:
      case DisconnectReason.badSession:
        this.setState('logged_out', `disconnect ${code}`)
        return
      case DisconnectReason.connectionReplaced:
        if (this.conflictRetried) {
          this.setState('logged_out', 'conflict: another session took over twice')
          return
        }
        this.conflictRetried = true
        this.setState('conflict_wait', 'another session took over; retrying once')
        await this.sleep(this.o.conflictWaitMs ?? 30_000)
        await this.connect()
        return
      case DisconnectReason.restartRequired:
        this.metrics.reconnects++
        await this.connect()
        return
      default: {
        this.metrics.reconnects++
        this.attempt++
        this.firstFailureAt ??= this.clock.now().getTime()
        const { baseMs, capMs } = this.o.backoff ?? { baseMs: 1000, capMs: 20_000 }
        const raw = Math.min(capMs, baseMs * 2 ** (this.attempt - 1))
        const jitter = raw * (0.8 + Math.random() * 0.4)
        if (this.clock.now().getTime() - this.firstFailureAt > (this.o.degradedAfterMs ?? 24 * 3600_000)) {
          this.setState('degraded', 'no successful connection for 24 h')
          await this.sleep(3600_000)
        } else {
          this.setState('reconnecting', `disconnect ${code ?? 'unknown'}; retry in ${Math.round(jitter)} ms`)
          await this.sleep(jitter)
        }
        await this.connect()
      }
    }
  }

  /** Per-chat lanes so the pipeline sees one chat's events in order; the handler is awaited. */
  private deliver(raw: RawEvent): Promise<void> {
    const h = this.handler
    if (!h) return Promise.resolve()
    const lane = raw.chatId ?? '__global__'
    const prev = this.lanes.get(lane) ?? Promise.resolve()
    const run = prev.then(async () => {
      const t0 = performance.now()
      this.lastEventAt = this.clock.now()
      if (!raw.isFromMe && raw.type.startsWith('message.')) this.lastInboundAt = this.lastEventAt
      try {
        await h(raw)
      } catch (e) {
        this.log.error({ err: (e as Error).message, type: raw.type }, 'event handler failed')
      }
      this.metrics.handlerLatencyMs.push(performance.now() - t0)
      if (this.metrics.handlerLatencyMs.length > 1000) this.metrics.handlerLatencyMs.shift()
    })
    this.lanes.set(lane, run)
    return run
  }

  async send(cmd: SendCommand & { messageId: string }): Promise<SendResult> {
    const sock = this.sock
    if (!sock || this.state !== 'connected')
      return {
        outcome: 'rejected',
        frameWritten: false,
        error: { kind: 'CONNECTOR_UNAVAILABLE', message: `connector is ${this.state}` },
      }
    try {
      switch (cmd.kind) {
        case 'send_message': {
          const quoted = cmd.quotedProviderId ? this.keyCache.get(cmd.quotedProviderId) : undefined
          await sock.sendMessage(
            cmd.chatId,
            { text: cmd.text, ...(cmd.mentions?.length ? { mentions: cmd.mentions } : {}) },
            {
              messageId: cmd.messageId,
              ...(quoted ? { quoted: { key: quoted.key, message: { conversation: '' } } } : {}),
            },
          )
          break
        }
        case 'react_to_message': {
          const target = this.keyCache.get(cmd.providerId)?.key ?? {
            remoteJid: cmd.chatId,
            id: cmd.providerId,
            fromMe: false,
          }
          await sock.sendMessage(
            cmd.chatId,
            { react: { text: cmd.emoji ?? '', key: target } },
            { messageId: cmd.messageId },
          )
          break
        }
        case 'mark_read':
          await sock.readMessages(
            cmd.providerIds.map(
              (id) => this.keyCache.get(id)?.key ?? { remoteJid: cmd.chatId, id, fromMe: false },
            ),
          )
          break
        case 'set_typing':
          await sock.sendPresenceUpdate(cmd.typing ? 'composing' : 'paused', cmd.chatId)
          break
      }
      return { outcome: 'accepted', frameWritten: true }
    } catch (e) {
      const code = (e as Boom)?.output?.statusCode
      const frameWritten = !(
        code === DisconnectReason.connectionClosed || /Connection Closed/i.test((e as Error).message ?? '')
      )
      this.lastErrorKind = `send:${code ?? 'error'}`
      throw Object.assign(e as Error, { frameWritten })
    }
  }

  async requestHistory(
    chatId: string,
    beforeProviderId: string | null,
    limit: number,
  ): Promise<HistoryRequestHandle> {
    const sock = this.sock
    if (!sock) throw new Error('connector not connected')
    const anchor = beforeProviderId
      ? this.keyCache.get(beforeProviderId)
      : [...this.keyCache.values()].filter((v) => v.key.remoteJid === chatId).sort((a, b) => a.ts - b.ts)[0]
    if (!anchor)
      throw new Error(
        'no anchor message known for history request; receive at least one message in the chat first',
      )
    const requestId = await sock.fetchMessageHistory(Math.min(limit, 50), anchor.key, Math.floor(anchor.ts))
    return { requestId }
  }

  async listChatsSnapshot(): Promise<ChatSnapshotEntry[]> {
    return [...this.chatSnapshot.values()]
  }

  /** Forgets the session (for `wamcp accounts unpair`). */
  async logout() {
    try {
      await this.sock?.logout()
    } finally {
      const { clear } = await loadAuthState({
        db: this.o.db,
        tables: this.o.tables,
        codec: this.o.codec,
        schemaName: this.o.schemaName,
      })
      await clear()
    }
  }
}
