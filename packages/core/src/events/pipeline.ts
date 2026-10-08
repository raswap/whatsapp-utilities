import { eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Clock } from '../clock.js'
import type { Connector } from '../connectors/types.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import { newId } from '../ids.js'
import type { Codec } from '../store/codec.js'
import { EventStore } from '../store/events.js'
import { IdentityStore } from '../store/identities.js'
import { ChatStore, MessageStore } from '../store/messages.js'
import { PipelineState } from '../store/state.js'
import { SubscriptionManager } from './subscriptions.js'
import { type IdentityHint, MESSAGE_TYPES, type Origin, type RawEvent, type StoredEvent } from './types.js'

export type EventHandler = (e: StoredEvent) => Promise<void>

export interface PipelineOptions {
  accountId: string
  schemaName: string
  db: Db
  tables: AccountTables
  codec: Codec
  clock: Clock
  log: Logger
  backfillAgeThresholdMs?: number
  persistPresence?: boolean
  /** Max events pulled from the store per dispatch round. */
  batchSize?: number
}

const DISPATCH_CURSOR_KEY = 'dispatch_cursor'

/**
 * Per-account event pipeline (PRD §7.2 and §9).
 *
 *   connector ──▶ ingest(): resolve identity, derive origin, write-ahead insert
 *             ──▶ dispatcher: drains the store by cursor, per-chat lanes in seq order,
 *                 persists a watermark so a crash resumes undelivered events
 *             ──▶ handlers (rule engine later) and subscribers
 */
export class Pipeline {
  readonly events: EventStore
  readonly identities: IdentityStore
  readonly messages: MessageStore
  readonly chats: ChatStore
  readonly subscriptions: SubscriptionManager
  private readonly state: PipelineState
  private readonly handlers: EventHandler[] = []
  private readonly log: Logger
  private watermark = 0
  private dispatching = false
  private wakeRequested = false
  private stopped = false
  private readonly batchSize: number
  /** Resolves when the dispatcher has gone idle; replaced on every run. */
  private idle: Promise<void> = Promise.resolve()
  private idleResolve: (() => void) | null = null
  readonly metrics = {
    ingested: 0,
    duplicates: 0,
    dispatched: 0,
    handlerErrors: 0,
    persistMs: [] as number[],
  }

  constructor(private readonly opts: PipelineOptions) {
    this.log = opts.log.child({ account: opts.accountId })
    this.events = new EventStore(opts.db, opts.tables, {
      accountId: opts.accountId,
      backfillAgeThresholdMs: opts.backfillAgeThresholdMs ?? 5 * 60_000,
      clock: opts.clock,
    })
    this.identities = new IdentityStore(opts.db, opts.tables, opts.codec, opts.schemaName)
    this.messages = new MessageStore(opts.db, opts.tables, opts.schemaName)
    this.chats = new ChatStore(opts.db, opts.tables)
    this.subscriptions = new SubscriptionManager(opts.accountId, this.log)
    this.state = new PipelineState(opts.db, opts.schemaName)
    this.batchSize = opts.batchSize ?? 100
  }

  onEvent(handler: EventHandler) {
    this.handlers.push(handler)
  }

  attach(connector: Connector) {
    connector.onEvent(async (raw) => {
      await this.ingest(raw)
    })
  }

  async start() {
    this.stopped = false
    this.watermark = await this.state.get<number>(DISPATCH_CURSOR_KEY, 0)
    this.requestDispatch()
  }

  async stop() {
    this.stopped = true
    await this.idle
  }

  /** Connector handler. Resolves before the connector may deliver the next event for the chat. */
  async ingest(raw: RawEvent): Promise<StoredEvent | null> {
    const t0 = performance.now()
    if (raw.type === 'presence.updated' && !this.opts.persistPresence) {
      this.subscriptions.publish(this.ephemeral(raw))
      return null
    }
    const senderId = await this.resolveSender(raw)
    if (senderId && raw.type === 'message.received' && !raw.isFromMe && (raw.chatType ?? 'dm') === 'dm') {
      await this.identities.noteFirstDm(senderId, raw.occurredAt)
    }
    const origin =
      raw.isFromMe && raw.providerId && MESSAGE_TYPES.has(raw.type)
        ? await this.originFor(raw.providerId)
        : null
    const { event, inserted } = await this.events.insert(raw, { senderId, origin })
    this.metrics.persistMs.push(performance.now() - t0)
    if (!inserted) {
      this.metrics.duplicates++
      this.log.debug({ type: raw.type, providerId: raw.providerId }, 'duplicate event dropped')
      return event
    }
    this.metrics.ingested++
    this.requestDispatch()
    return event
  }

  /** `self_system` when we pre-generated this message id (PRD FR-M10). */
  private async originFor(providerId: string): Promise<Origin> {
    const { actions } = this.opts.tables
    const [row] = await this.opts.db
      .select({ id: actions.id })
      .from(actions)
      .where(eq(actions.messageId, providerId))
      .limit(1)
    return row ? 'self_system' : 'other_device'
  }

  private async resolveSender(raw: RawEvent): Promise<string | null> {
    const hints: IdentityHint[] = [...(raw.identityHints ?? [])]
    if (raw.senderJid && !hints.some((h) => h.jid === raw.senderJid)) {
      hints.unshift({ jid: raw.senderJid, kind: raw.senderJid.endsWith('@lid') ? 'lid' : 'phone' })
    }
    let senderId: string | null = null
    for (const h of hints) {
      const r = await this.identities.resolve(h)
      if (h.jid === raw.senderJid) senderId = r.contactId
      if (r.mergedFrom) {
        await this.events.insert(
          {
            type: 'identity.linked',
            occurredAt: this.opts.clock.now(),
            isFromMe: false,
            source: 'live',
            payload: {
              contactId: r.contactId,
              jids: await this.identities.jidsFor(r.contactId),
              mergedFrom: r.mergedFrom,
            },
          },
          {},
        )
      }
    }
    return senderId
  }

  private ephemeral(raw: RawEvent): StoredEvent {
    return {
      cursor: -1,
      id: newId(),
      accountId: this.opts.accountId,
      type: raw.type,
      providerId: raw.providerId ?? null,
      discriminator: '',
      chatId: raw.chatId ?? null,
      senderId: null,
      seq: null,
      occurredAt: raw.occurredAt,
      receivedAt: this.opts.clock.now(),
      isBackfill: false,
      isFromMe: raw.isFromMe,
      origin: null,
      payload: raw.payload,
    }
  }

  private requestDispatch() {
    if (this.stopped) return
    this.wakeRequested = true
    if (!this.dispatching) void this.runDispatcher()
  }

  /** Wait until every persisted event up to now has been handed to handlers. */
  async drained(): Promise<void> {
    const target = await this.events.latestCursor()
    while (this.watermark < target || this.dispatching) {
      await this.idle
      if (this.watermark >= target && !this.dispatching) break
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  get dispatchCursor() {
    return this.watermark
  }

  private async runDispatcher() {
    this.dispatching = true
    this.idle = new Promise((r) => {
      this.idleResolve = r
    })
    try {
      while (this.wakeRequested && !this.stopped) {
        this.wakeRequested = false
        let batch = await this.events.listAfter(this.watermark, this.batchSize)
        while (batch.length && !this.stopped) {
          await this.dispatchBatch(batch)
          const last = batch[batch.length - 1]
          if (last) {
            this.watermark = last.cursor
            await this.state.set(DISPATCH_CURSOR_KEY, this.watermark)
          }
          batch = await this.events.listAfter(this.watermark, this.batchSize)
        }
      }
    } catch (e) {
      this.log.error({ err: (e as Error).message }, 'dispatcher failed; will retry on next event')
    } finally {
      this.dispatching = false
      this.idleResolve?.()
      if (this.wakeRequested && !this.stopped) void this.runDispatcher()
    }
  }

  /** Per-chat lanes keep seq order; lanes run concurrently; global-lane events run in order too. */
  private async dispatchBatch(batch: StoredEvent[]) {
    const lanes = new Map<string, StoredEvent[]>()
    for (const e of batch) {
      const key = e.chatId ?? '__global__'
      const lane = lanes.get(key)
      if (lane) lane.push(e)
      else lanes.set(key, [e])
    }
    await Promise.all(
      [...lanes.values()].map(async (lane) => {
        for (const e of lane) await this.deliver(e)
      }),
    )
  }

  private async deliver(e: StoredEvent) {
    for (const h of this.handlers) {
      try {
        await h(e)
      } catch (err) {
        this.metrics.handlerErrors++
        this.log.error({ err: (err as Error).message, event: e.id, type: e.type }, 'event handler threw')
      }
    }
    this.subscriptions.publish(e)
    this.metrics.dispatched++
  }
}
