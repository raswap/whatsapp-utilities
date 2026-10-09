import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import { newId } from '../ids.js'

export interface AuditEntry {
  actor: string
  kind: string
  subjectId?: string | null
  eventId?: string | null
  ruleId?: string | null
  chatId?: string | null
  decision?: string | null
  /** References and hashes only; never message bodies (PRD §10.4). */
  detail?: Record<string, unknown>
}

export type AuditRow = AccountTables['auditLog']['$inferSelect']

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

export function rowHash(
  prevHash: string | null,
  fields: Omit<AuditEntry, 'detail'> & { id: string; detail: unknown },
): string {
  return createHash('sha256')
    .update(prevHash ?? '')
    .update(canonical(fields))
    .digest('hex')
}

/** Append-only, hash-chained audit log per account (PRD §9, §10.4). */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
  ) {}

  async append(entry: AuditEntry): Promise<AuditRow> {
    const { auditLog } = this.t
    return this.db.transaction(async (tx) => {
      // Serialise appends so the chain has one tail.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`audit:${this.t.schema.schemaName}`}))`)
      const [tail] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .orderBy(desc(auditLog.seq))
        .limit(1)
      const id = newId()
      const fields = {
        id,
        actor: entry.actor,
        kind: entry.kind,
        subjectId: entry.subjectId ?? null,
        eventId: entry.eventId ?? null,
        ruleId: entry.ruleId ?? null,
        chatId: entry.chatId ?? null,
        decision: entry.decision ?? null,
        detail: entry.detail ?? {},
      }
      const hash = rowHash(tail?.hash ?? null, fields)
      const [row] = await tx
        .insert(auditLog)
        .values({ ...fields, prevHash: tail?.hash ?? null, hash })
        .returning()
      if (!row) throw new Error('audit insert returned no row')
      return row
    })
  }

  async query(
    opts: {
      eventId?: string
      ruleId?: string
      chatId?: string
      kind?: string
      since?: Date
      until?: Date
      limit?: number
    } = {},
  ) {
    const { auditLog } = this.t
    const conds = []
    if (opts.eventId) conds.push(eq(auditLog.eventId, opts.eventId))
    if (opts.ruleId) conds.push(eq(auditLog.ruleId, opts.ruleId))
    if (opts.chatId) conds.push(eq(auditLog.chatId, opts.chatId))
    if (opts.kind) conds.push(eq(auditLog.kind, opts.kind))
    if (opts.since) conds.push(gte(auditLog.createdAt, opts.since))
    if (opts.until) conds.push(lte(auditLog.createdAt, opts.until))
    const q = this.db.select().from(auditLog)
    return (conds.length ? q.where(and(...conds)) : q)
      .orderBy(desc(auditLog.seq))
      .limit(Math.min(opts.limit ?? 100, 1000))
  }

  /** Recomputes the chain; returns the first broken seq or null when intact. */
  async verify(): Promise<{ ok: true; count: number } | { ok: false; brokenAtSeq: number }> {
    const rows = await this.db.select().from(this.t.auditLog).orderBy(asc(this.t.auditLog.seq))
    let prev: string | null = null
    for (const r of rows) {
      const expected = rowHash(prev, {
        id: r.id,
        actor: r.actor,
        kind: r.kind,
        subjectId: r.subjectId,
        eventId: r.eventId,
        ruleId: r.ruleId,
        chatId: r.chatId,
        decision: r.decision,
        detail: r.detail,
      })
      if (expected !== r.hash || r.prevHash !== prev) return { ok: false, brokenAtSeq: r.seq }
      prev = r.hash
    }
    return { ok: true, count: rows.length }
  }
}
