import type { RawEvent } from '../events/types.js'
import type {
  Capability,
  ChatSnapshotEntry,
  Connector,
  ConnectorHealth,
  ConnectorState,
  HistoryRequestHandle,
  RawEventHandler,
  SendCommand,
  SendResult,
} from './types.js'

export interface FakeSendRecord {
  cmd: SendCommand & { messageId: string }
  at: Date
}

/**
 * In-memory connector for tests, `wamcp tail --fake`, and fixture replay. Events are pushed with
 * `emit()`, sends are recorded, and failure modes can be scripted.
 */
export class FakeConnector implements Connector {
  readonly capabilities: ReadonlySet<Capability>
  private handler: RawEventHandler | null = null
  private state: ConnectorState = 'disconnected'
  private lastEventAt: Date | null = null
  private lastInboundAt: Date | null = null
  readonly sends: FakeSendRecord[] = []
  readonly historyRequests: Array<{ chatId: string; before: string | null; limit: number }> = []
  snapshot: ChatSnapshotEntry[] = []
  /** Next send outcome; reset to default after use. */
  nextSendResult: SendResult | null = null
  /** When set, send() rejects with this error after optionally writing the frame. */
  nextSendThrow: { error: Error; frameWritten: boolean } | null = null
  private pending = Promise.resolve()

  constructor(
    readonly accountId: string,
    capabilities: Capability[] = ['groups', 'reactions', 'presence', 'media', 'edit', 'delete'],
  ) {
    this.capabilities = new Set(capabilities)
  }

  async start() {
    this.state = 'connected'
  }
  async stop() {
    this.state = 'disconnected'
  }
  onEvent(handler: RawEventHandler) {
    if (this.handler) throw new Error('FakeConnector: handler already registered')
    this.handler = handler
  }

  /** Delivers one event through the registered handler, serialised like the real connector. */
  emit(e: RawEvent): Promise<void> {
    if (!this.handler) throw new Error('FakeConnector: no handler registered')
    const h = this.handler
    const run = this.pending.then(() => h(e))
    this.pending = run.catch(() => undefined)
    this.lastEventAt = new Date()
    if (!e.isFromMe) this.lastInboundAt = this.lastEventAt
    return run
  }

  async send(cmd: SendCommand & { messageId: string }): Promise<SendResult> {
    this.sends.push({ cmd, at: new Date() })
    if (this.nextSendThrow) {
      const t = this.nextSendThrow
      this.nextSendThrow = null
      throw Object.assign(t.error, { frameWritten: t.frameWritten })
    }
    if (this.nextSendResult) {
      const r = this.nextSendResult
      this.nextSendResult = null
      return r
    }
    return { outcome: 'accepted', frameWritten: true }
  }

  async requestHistory(chatId: string, before: string | null, limit: number): Promise<HistoryRequestHandle> {
    this.historyRequests.push({ chatId, before, limit })
    return { requestId: `fake-${this.historyRequests.length}` }
  }

  async listChatsSnapshot() {
    return this.snapshot
  }

  setState(state: ConnectorState) {
    this.state = state
  }

  health(): ConnectorHealth {
    return {
      state: this.state,
      lastEventAt: this.lastEventAt,
      lastInboundAt: this.lastInboundAt,
      lastErrorKind: null,
      decryptFailures: 0,
      libraryVersion: 'fake',
    }
  }
}

/** Convenience builder for tests. */
export function textMessage(
  over: Partial<RawEvent> & { chatId: string; senderJid: string; body: string; providerId: string },
): RawEvent {
  const { body, ...rest } = over
  return {
    type: 'message.received',
    chatType: over.chatId.endsWith('@g.us') ? 'group' : 'dm',
    occurredAt: new Date(),
    isFromMe: false,
    source: 'live',
    payload: { kind: 'text', body },
    ...rest,
  }
}
