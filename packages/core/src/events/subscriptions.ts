import type { Logger } from 'pino'
import type { EventType, StoredEvent } from './types.js'

export interface SubscriptionFilter {
  chatIds?: string[]
  types?: EventType[]
  includeFromMe?: boolean
  includeBackfill?: boolean
}

export type EventSink = (e: StoredEvent) => Promise<void> | void

export interface Subscription {
  id: string
  unsubscribe(): void
  /** Number of events dropped because the sink fell behind; reset after a lagged notice. */
  readonly dropped: number
}

interface Sub {
  id: string
  filter: SubscriptionFilter
  sink: EventSink
  queue: StoredEvent[]
  limit: number
  dropped: number
  lastDroppedCursor: number
  draining: boolean
  closed: boolean
}

export function matchesFilter(e: StoredEvent, f: SubscriptionFilter): boolean {
  if (f.chatIds?.length && (!e.chatId || !f.chatIds.includes(e.chatId))) return false
  if (f.types?.length && !f.types.includes(e.type)) return false
  if (f.includeFromMe === false && e.isFromMe) return false
  if (f.includeBackfill === false && e.isBackfill) return false
  return true
}

/**
 * Fan-out to MCP clients and the CLI tail (PRD FR-M9). Each subscriber has a bounded queue; on
 * overflow the oldest event is dropped and a `subscription.lagged` event with a resume cursor is
 * delivered before the next real event. Rule evaluation never waits on subscribers.
 */
export class SubscriptionManager {
  private subs = new Map<string, Sub>()
  private counter = 0

  constructor(
    private readonly accountId: string,
    private readonly log: Logger,
    private readonly defaultLimit = 1000,
  ) {}

  subscribe(filter: SubscriptionFilter, sink: EventSink, limit = this.defaultLimit): Subscription {
    const id = `sub_${++this.counter}`
    const sub: Sub = {
      id,
      filter,
      sink,
      queue: [],
      limit,
      dropped: 0,
      lastDroppedCursor: 0,
      draining: false,
      closed: false,
    }
    this.subs.set(id, sub)
    return {
      id,
      unsubscribe: () => {
        sub.closed = true
        this.subs.delete(id)
      },
      get dropped() {
        return sub.dropped
      },
    }
  }

  get size() {
    return this.subs.size
  }

  publish(e: StoredEvent): void {
    for (const sub of this.subs.values()) {
      if (!matchesFilter(e, sub.filter)) continue
      if (sub.queue.length >= sub.limit) {
        const victim = sub.queue.shift()
        sub.dropped++
        if (victim) sub.lastDroppedCursor = victim.cursor
      }
      sub.queue.push(e)
      void this.drain(sub)
    }
  }

  private async drain(sub: Sub) {
    if (sub.draining) return
    sub.draining = true
    try {
      while (sub.queue.length && !sub.closed) {
        if (sub.dropped > 0) {
          const dropped = sub.dropped
          const resumeCursor = sub.lastDroppedCursor
          sub.dropped = 0
          await this.deliver(sub, {
            cursor: -1,
            id: `lag_${resumeCursor}_${dropped}`,
            accountId: this.accountId,
            type: 'subscription.lagged',
            providerId: null,
            discriminator: '',
            chatId: null,
            senderId: null,
            seq: null,
            occurredAt: new Date(),
            receivedAt: new Date(),
            isBackfill: false,
            isFromMe: false,
            origin: null,
            payload: { dropped, resumeCursor },
          })
        }
        const next = sub.queue.shift()
        if (next) await this.deliver(sub, next)
      }
    } finally {
      sub.draining = false
    }
  }

  private async deliver(sub: Sub, e: StoredEvent) {
    try {
      await sub.sink(e)
    } catch (err) {
      this.log.warn({ sub: sub.id, err: (err as Error).message }, 'subscriber sink failed')
    }
  }
}
