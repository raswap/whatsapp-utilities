import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'

export type MessageRow = AccountTables['messages']['$inferSelect']

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  truncated: boolean
}

/** Opaque pagination cursor over (occurred_at, id). */
export function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString('base64url')
}
export function decodeCursor(c: string): { occurredAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|')
  if (!iso || !id) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : { occurredAt: d, id }
}

export class MessageStore {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
    private readonly schemaName: string,
  ) {}

  /** Newest first, paginated backwards with `before`. */
  async getMessages(opts: {
    chatId: string
    limit?: number
    before?: string
    includeDeleted?: boolean
  }): Promise<Page<MessageRow>> {
    const { messages } = this.t
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
    const conds = [eq(messages.chatId, opts.chatId)]
    if (!opts.includeDeleted) conds.push(isNull(messages.deletedAt))
    if (opts.before) {
      const c = decodeCursor(opts.before)
      if (!c) throw new Error('invalid cursor')
      conds.push(
        or(
          lt(messages.occurredAt, c.occurredAt),
          and(eq(messages.occurredAt, c.occurredAt), lt(messages.id, c.id)),
        ) as ReturnType<typeof lt>,
      )
    }
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.occurredAt), desc(messages.id))
      .limit(limit + 1)
    const truncated = rows.length > limit
    const items = truncated ? rows.slice(0, limit) : rows
    const last = items[items.length - 1]
    return { items, nextCursor: truncated && last ? encodeCursor(last.occurredAt, last.id) : null, truncated }
  }

  async getByProviderId(chatId: string, providerId: string): Promise<MessageRow | null> {
    const [row] = await this.db
      .select()
      .from(this.t.messages)
      .where(and(eq(this.t.messages.chatId, chatId), eq(this.t.messages.providerId, providerId)))
    return row ?? null
  }

  /** Walks the quote chain from a message back to its root, oldest first (PRD FR-U2). */
  async getThread(chatId: string, providerId: string, depth = 20): Promise<MessageRow[]> {
    const out: MessageRow[] = []
    let current: string | null = providerId
    const seen = new Set<string>()
    while (current && out.length < Math.min(depth, 20) && !seen.has(current)) {
      seen.add(current)
      const m = await this.getByProviderId(chatId, current)
      if (!m) break
      out.push(m)
      current = m.quotedProviderId
    }
    return out.reverse()
  }

  async search(opts: { query: string; chatIds?: string[]; limit?: number }): Promise<MessageRow[]> {
    const { messages } = this.t
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100))
    const conds = [
      sql`${messages.bodyTsv} @@ plainto_tsquery('simple', ${opts.query})`,
      isNull(messages.deletedAt),
    ]
    if (opts.chatIds?.length) conds.push(inArray(messages.chatId, opts.chatIds))
    return this.db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.occurredAt))
      .limit(limit)
  }

  /** Time of the last human (other-device) reply in a chat, for skip_if_human_replied_within. */
  async lastHumanReplyAt(chatId: string): Promise<Date | null> {
    const { messages } = this.t
    const [row] = await this.db
      .select({ t: messages.occurredAt })
      .from(messages)
      .where(
        and(eq(messages.chatId, chatId), eq(messages.isFromMe, true), eq(messages.origin, 'other_device')),
      )
      .orderBy(desc(messages.occurredAt))
      .limit(1)
    return row?.t ?? null
  }

  /** Last N messages in a chat, oldest first, for loop protection and context. */
  async recent(chatId: string, n: number): Promise<MessageRow[]> {
    const rows = await this.db
      .select()
      .from(this.t.messages)
      .where(and(eq(this.t.messages.chatId, chatId), isNull(this.t.messages.deletedAt)))
      .orderBy(desc(this.t.messages.occurredAt), desc(this.t.messages.id))
      .limit(n)
    return rows.reverse()
  }

  get schema() {
    return this.schemaName
  }
}

export type ChatRow = AccountTables['chats']['$inferSelect']

export class ChatStore {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
  ) {}

  async get(id: string): Promise<ChatRow | null> {
    const [row] = await this.db.select().from(this.t.chats).where(eq(this.t.chats.id, id))
    return row ?? null
  }

  async list(
    opts: { type?: ChatRow['type']; limit?: number; unreadOnly?: boolean } = {},
  ): Promise<ChatRow[]> {
    const { chats } = this.t
    const conds = []
    if (opts.type) conds.push(eq(chats.type, opts.type))
    if (opts.unreadOnly) conds.push(sql`${chats.unreadCount} > 0`)
    const q = this.db.select().from(chats)
    const rows = await (conds.length ? q.where(and(...conds)) : q)
      .orderBy(desc(sql`coalesce(${chats.lastMessageAt}, 'epoch'::timestamptz)`), asc(chats.id))
      .limit(Math.max(1, Math.min(opts.limit ?? 50, 200)))
    return rows
  }

  async setAutomation(id: string, state: 'active' | 'paused' | 'escalated', pausedUntil: Date | null = null) {
    await this.db
      .update(this.t.chats)
      .set({ automationState: state, pausedUntil, updatedAt: new Date() })
      .where(eq(this.t.chats.id, id))
  }
}
