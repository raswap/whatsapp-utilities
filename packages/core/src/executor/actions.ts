import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { Clock } from '../clock.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import { ACTION_CLASS, type PlannedAction } from '../gate/types.js'
import { newApprovalCode, newId } from '../ids.js'

export type ActionRow = AccountTables['actions']['$inferSelect']
export type ActionState =
  | 'planned'
  | 'blocked'
  | 'dry_run'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'retry_wait'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'rejected'
  | 'expired'
  | 'cancelled'

export const TERMINAL_STATES: ReadonlySet<ActionState> = new Set([
  'blocked',
  'dry_run',
  'sent',
  'failed',
  'rejected',
  'expired',
  'cancelled',
])

function localDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Persistence for the action lifecycle (PRD §8.3). */
export class ActionStore {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
    private readonly clock: Clock,
  ) {}

  async findByIdempotencyKey(key: string): Promise<ActionRow | null> {
    const day = localDay(this.clock.now())
    const [row] = await this.db
      .select()
      .from(this.t.actions)
      .where(and(eq(this.t.actions.idempotencyKey, key), eq(this.t.actions.createdDay, day)))
    return row ?? null
  }

  async create(p: PlannedAction): Promise<{ row: ActionRow; created: boolean }> {
    const existing = await this.findByIdempotencyKey(p.idempotencyKey)
    if (existing) return { row: existing, created: false }
    const now = this.clock.now()
    const [row] = await this.db
      .insert(this.t.actions)
      .values({
        id: newId(),
        idempotencyKey: p.idempotencyKey,
        createdDay: localDay(now),
        state: 'planned',
        kind: p.kind,
        class: ACTION_CLASS[p.kind],
        source: p.source,
        chatId: p.chatId ?? null,
        ruleId: p.ruleId ?? null,
        eventId: p.eventId ?? null,
        bodyHash: p.bodyHash ?? null,
        approvalCreatedBy: p.actor,
        payload: {
          ...p.payload,
          ...(p.text !== undefined ? { text: p.text } : {}),
          recipientContactId: p.recipientContactId ?? null,
        },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      const again = await this.findByIdempotencyKey(p.idempotencyKey)
      if (!again) throw new Error('action insert raced and lookup failed')
      return { row: again, created: false }
    }
    return { row, created: true }
  }

  async get(id: string): Promise<ActionRow | null> {
    const [row] = await this.db.select().from(this.t.actions).where(eq(this.t.actions.id, id))
    return row ?? null
  }

  async byApprovalCode(code: string): Promise<ActionRow | null> {
    const [row] = await this.db
      .select()
      .from(this.t.actions)
      .where(
        and(
          eq(this.t.actions.approvalCode, code.toUpperCase()),
          eq(this.t.actions.state, 'awaiting_approval'),
        ),
      )
    return row ?? null
  }

  async byMessageId(messageId: string): Promise<ActionRow | null> {
    const [row] = await this.db.select().from(this.t.actions).where(eq(this.t.actions.messageId, messageId))
    return row ?? null
  }

  async update(id: string, patch: Partial<ActionRow>): Promise<ActionRow> {
    const [row] = await this.db
      .update(this.t.actions)
      .set({ ...patch, updatedAt: this.clock.now() })
      .where(eq(this.t.actions.id, id))
      .returning()
    if (!row) throw new Error(`action ${id} not found`)
    return row
  }

  async transition(
    id: string,
    from: ActionState[],
    to: ActionState,
    patch: Partial<ActionRow> = {},
  ): Promise<ActionRow | null> {
    const [row] = await this.db
      .update(this.t.actions)
      .set({ ...patch, state: to, updatedAt: this.clock.now() })
      .where(and(eq(this.t.actions.id, id), inArray(this.t.actions.state, from)))
      .returning()
    return row ?? null
  }

  async markAwaitingApproval(id: string, ttlMs: number): Promise<ActionRow> {
    const code = newApprovalCode()
    return this.update(id, {
      state: 'awaiting_approval',
      approvalCode: code,
      expiresAt: new Date(this.clock.now().getTime() + ttlMs),
    })
  }

  async list(
    opts: { state?: ActionState | ActionState[]; chatId?: string; limit?: number } = {},
  ): Promise<ActionRow[]> {
    const conds = []
    if (opts.state)
      conds.push(inArray(this.t.actions.state, Array.isArray(opts.state) ? opts.state : [opts.state]))
    if (opts.chatId) conds.push(eq(this.t.actions.chatId, opts.chatId))
    const q = this.db.select().from(this.t.actions)
    return (conds.length ? q.where(and(...conds)) : q)
      .orderBy(asc(this.t.actions.createdAt))
      .limit(Math.min(opts.limit ?? 100, 1000))
  }

  async expiredApprovals(now: Date): Promise<ActionRow[]> {
    return this.db
      .select()
      .from(this.t.actions)
      .where(and(eq(this.t.actions.state, 'awaiting_approval'), lt(this.t.actions.expiresAt, now)))
  }

  /** Pending approvals bound to a message whose body changed or was deleted (PRD FR-P7). */
  async cancelForTrigger(eventId: string, reason: string): Promise<number> {
    const rows = await this.db
      .update(this.t.actions)
      .set({ state: 'cancelled', result: { reason }, updatedAt: this.clock.now() })
      .where(
        and(
          eq(this.t.actions.eventId, eventId),
          inArray(this.t.actions.state, ['awaiting_approval', 'planned', 'retry_wait']),
        ),
      )
      .returning({ id: this.t.actions.id })
    return rows.length
  }

  async lastIdenticalSendAt(chatId: string, textHash: string, since: Date): Promise<Date | null> {
    const [row] = await this.db
      .select({ t: this.t.actions.updatedAt })
      .from(this.t.actions)
      .where(
        and(
          eq(this.t.actions.chatId, chatId),
          eq(this.t.actions.state, 'sent'),
          sql`${this.t.actions.payload}->>'textHash' = ${textHash}`,
          sql`${this.t.actions.updatedAt} > ${since}`,
        ),
      )
      .orderBy(sql`${this.t.actions.updatedAt} desc`)
      .limit(1)
    return row?.t ?? null
  }
}
