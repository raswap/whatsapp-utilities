import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Clock } from '../clock.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import {
  discriminatorFor,
  type EditPayload,
  type EventType,
  MESSAGE_TYPES,
  type MessagePayload,
  type Origin,
  type RawEvent,
  type StoredEvent,
} from '../events/types.js'
import { newId } from '../ids.js'

export interface InsertContext {
  senderId?: string | null
  origin?: Origin | null
}

export interface InsertResult {
  event: StoredEvent
  inserted: boolean
}

export interface EventFilter {
  chatIds?: string[]
  types?: EventType[]
  includeFromMe?: boolean
  includeBackfill?: boolean
}

export interface EventStoreOptions {
  accountId: string
  backfillAgeThresholdMs: number
  clock: Clock
}

function isUniqueViolation(e: unknown): boolean {
  let err = e as { code?: string; cause?: unknown }
  while (err) {
    if (err.code === '23505') return true
    err = err.cause as { code?: string; cause?: unknown }
  }
  return false
}

/**
 * Write-ahead event store (PRD FR-M1 to FR-M4). One instance per account schema.
 * `insert` is the only write path; it assigns `seq` per chat, deduplicates by
 * (chat, provider id, type, discriminator), classifies backfill, and projects messages.
 */
export class EventStore {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
    private readonly opts: EventStoreOptions,
  ) {}

  private toStored(row: typeof this.t.events.$inferSelect): StoredEvent {
    return {
      cursor: row.cursor,
      id: row.id,
      accountId: this.opts.accountId,
      type: row.type as EventType,
      providerId: row.providerId,
      discriminator: row.discriminator,
      chatId: row.chatId,
      senderId: row.senderId,
      seq: row.seq,
      occurredAt: row.occurredAt,
      receivedAt: row.receivedAt,
      isBackfill: row.isBackfill,
      isFromMe: row.isFromMe,
      origin: row.origin as Origin | null,
      payload: row.payload as StoredEvent['payload'],
    }
  }

  classifyBackfill(raw: RawEvent, receivedAt: Date): boolean {
    if (raw.source === 'history') return true
    return receivedAt.getTime() - raw.occurredAt.getTime() > this.opts.backfillAgeThresholdMs
  }

  async insert(raw: RawEvent, ctx: InsertContext = {}): Promise<InsertResult> {
    const { events, chats } = this.t
    const discriminator = discriminatorFor(raw)
    const receivedAt = this.opts.clock.now()
    const isBackfill = this.classifyBackfill(raw, receivedAt)

    const findExisting = async () => {
      if (!raw.providerId) return null
      const rows = await this.db
        .select()
        .from(events)
        .where(
          and(
            raw.chatId ? eq(events.chatId, raw.chatId) : sql`${events.chatId} is null`,
            eq(events.providerId, raw.providerId),
            eq(events.type, raw.type),
            eq(events.discriminator, discriminator),
          ),
        )
      return rows[0] ?? null
    }

    const existing = await findExisting()
    if (existing) return { event: this.toStored(existing), inserted: false }

    try {
      const row = await this.db.transaction(async (tx) => {
        let seq: number | null = null
        if (raw.chatId) {
          await tx
            .insert(chats)
            .values({
              id: raw.chatId,
              type: raw.chatType ?? (raw.chatId.endsWith('@g.us') ? 'group' : 'dm'),
              name: raw.chatName ?? null,
            })
            .onConflictDoUpdate({
              target: chats.id,
              set: { name: sql`coalesce(excluded.name, ${chats.name})`, updatedAt: receivedAt },
            })
          const [bumped] = await tx
            .update(chats)
            .set({
              lastSeq: sql`${chats.lastSeq} + 1`,
              ...(MESSAGE_TYPES.has(raw.type)
                ? {
                    lastMessageAt: sql`greatest(coalesce(${chats.lastMessageAt}, 'epoch'::timestamptz), ${raw.occurredAt})`,
                  }
                : {}),
            })
            .where(eq(chats.id, raw.chatId))
            .returning({ lastSeq: chats.lastSeq })
          seq = bumped?.lastSeq ?? null
        }
        const [inserted] = await tx
          .insert(events)
          .values({
            id: newId(),
            type: raw.type,
            providerId: raw.providerId ?? null,
            discriminator,
            chatId: raw.chatId ?? null,
            senderId: ctx.senderId ?? null,
            seq,
            occurredAt: raw.occurredAt,
            receivedAt,
            isBackfill,
            isFromMe: raw.isFromMe,
            origin: ctx.origin ?? null,
            payload: raw.payload,
          })
          .returning()
        if (!inserted) throw new Error('insert returned no row')
        await this.project(tx, raw, inserted, ctx)
        return inserted
      })
      return { event: this.toStored(row), inserted: true }
    } catch (e) {
      if (isUniqueViolation(e)) {
        const again = await findExisting()
        if (again) return { event: this.toStored(again), inserted: false }
      }
      throw e
    }
  }

  /** Maintains the messages projection inside the event transaction. */
  private async project(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    raw: RawEvent,
    ev: typeof this.t.events.$inferSelect,
    ctx: InsertContext,
  ) {
    const { messages } = this.t
    if (!raw.chatId || !raw.providerId) return
    if (MESSAGE_TYPES.has(raw.type)) {
      const p = raw.payload as MessagePayload
      const body = p.body ?? p.caption ?? null
      await tx
        .insert(messages)
        .values({
          id: ev.id,
          providerId: raw.providerId,
          chatId: raw.chatId,
          senderId: ctx.senderId ?? null,
          eventId: ev.id,
          type: p.kind ?? 'unknown',
          body,
          mediaId: p.mediaRef ?? null,
          quotedProviderId: p.quotedProviderId ?? null,
          isFromMe: raw.isFromMe,
          origin: ctx.origin ?? null,
          occurredAt: raw.occurredAt,
          bodyHash: body ? sha256(body) : null,
        })
        .onConflictDoNothing()
    } else if (raw.type === 'message.edited') {
      const p = raw.payload as EditPayload
      await tx
        .update(messages)
        .set({ body: p.body, bodyHash: sha256(p.body), editedAt: raw.occurredAt })
        .where(and(eq(messages.chatId, raw.chatId), eq(messages.providerId, raw.providerId)))
    } else if (raw.type === 'message.deleted') {
      await tx
        .update(messages)
        .set({ deletedAt: raw.occurredAt })
        .where(and(eq(messages.chatId, raw.chatId), eq(messages.providerId, raw.providerId)))
    }
  }

  async listAfter(cursor: number, limit: number, filter: EventFilter = {}): Promise<StoredEvent[]> {
    const { events } = this.t
    const conds = [gt(events.cursor, cursor)]
    if (filter.chatIds?.length) conds.push(inArray(events.chatId, filter.chatIds))
    if (filter.types?.length) conds.push(inArray(events.type, filter.types))
    if (filter.includeFromMe === false) conds.push(eq(events.isFromMe, false))
    if (filter.includeBackfill === false) conds.push(eq(events.isBackfill, false))
    const rows = await this.db
      .select()
      .from(events)
      .where(and(...conds))
      .orderBy(asc(events.cursor))
      .limit(Math.max(1, Math.min(limit, 1000)))
    return rows.map((r) => this.toStored(r))
  }

  async latestCursor(): Promise<number> {
    const [row] = await this.db
      .select({ c: sql<number>`coalesce(max(${this.t.events.cursor}), 0)` })
      .from(this.t.events)
    return Number(row?.c ?? 0)
  }

  async getById(id: string): Promise<StoredEvent | null> {
    const [row] = await this.db.select().from(this.t.events).where(eq(this.t.events.id, id))
    return row ? this.toStored(row) : null
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

import { createHash } from 'node:crypto'
