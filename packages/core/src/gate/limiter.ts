import { and, eq, sql } from 'drizzle-orm'
import type { Clock } from '../clock.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'

export interface LimitResult {
  allowed: boolean
  retryAfterMs: number
  remaining: number
}

/**
 * Persisted limiters (PRD §7.6 check 7): token buckets for per-interval limits and fixed-window
 * counters for per-day limits. `peek` never mutates; `consume` is called once at execution time.
 */
export class Limiter {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
    private readonly clock: Clock,
  ) {}

  /** Token bucket. `intervalSeconds` is the time to refill one token; capacity defaults to 1. */
  async bucket(
    key: string,
    intervalSeconds: number,
    capacity = 1,
    mode: 'peek' | 'consume' = 'peek',
  ): Promise<LimitResult> {
    const { rateBuckets } = this.t
    const now = this.clock.now()
    const intervalMs = Math.max(1, Math.round(intervalSeconds * 1000)) // one token per interval
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(rateBuckets).where(eq(rateBuckets.key, key)).for('update')
      // Tokens are tracked in thousandths so partial refills are not lost between calls.
      let tokensMilli = capacity * 1000
      let updatedAt = now
      if (row) {
        const elapsedMs = Math.max(0, now.getTime() - row.updatedAt.getTime())
        const refilled = Math.floor((elapsedMs * 1000) / row.intervalMs)
        tokensMilli = Math.min(capacity * 1000, row.tokens + refilled)
        // Keep the remainder of the interval by only moving updatedAt forward by whole refills.
        updatedAt = new Date(row.updatedAt.getTime() + Math.floor((refilled * row.intervalMs) / 1000))
        if (tokensMilli >= capacity * 1000) updatedAt = now
      }
      const allowed = tokensMilli >= 1000
      const retryAfterMs = allowed ? 0 : Math.ceil(((1000 - tokensMilli) * intervalMs) / 1000)
      if (mode === 'consume' && allowed) tokensMilli -= 1000
      if (mode === 'consume' || !row) {
        await tx
          .insert(rateBuckets)
          .values({ key, tokens: tokensMilli, capacity, intervalMs, updatedAt })
          .onConflictDoUpdate({
            target: rateBuckets.key,
            set: { tokens: tokensMilli, capacity, intervalMs, updatedAt },
          })
      }
      return { allowed, retryAfterMs, remaining: Math.floor(tokensMilli / 1000) }
    })
  }

  /** Fixed window counter, e.g. per day in the account's zone. */
  async window(
    key: string,
    windowStart: Date,
    windowMs: number,
    limit: number,
    mode: 'peek' | 'consume' | 'refund' = 'peek',
  ): Promise<LimitResult> {
    const { counters } = this.t
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(counters)
        .where(and(eq(counters.key, key), eq(counters.windowStart, windowStart)))
        .for('update')
      const current = row?.value ?? 0
      const now = this.clock.now()
      const retryAfterMs = Math.max(0, windowStart.getTime() + windowMs - now.getTime())
      if (mode === 'refund') {
        if (row && current > 0)
          await tx
            .update(counters)
            .set({ value: current - 1 })
            .where(and(eq(counters.key, key), eq(counters.windowStart, windowStart)))
        return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, limit - Math.max(0, current - 1)) }
      }
      const allowed = current < limit
      if (mode === 'consume' && allowed) {
        await tx
          .insert(counters)
          .values({ key, windowStart, value: 1 })
          .onConflictDoUpdate({
            target: [counters.key, counters.windowStart],
            set: { value: sql`${counters.value} + 1` },
          })
      }
      const after = mode === 'consume' && allowed ? current + 1 : current
      return { allowed, retryAfterMs: allowed ? 0 : retryAfterMs, remaining: Math.max(0, limit - after) }
    })
  }
}

/** Start of the current local day in an IANA zone, as a UTC instant. */
export function startOfDayInZone(d: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const localMidnightAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), 0, 0, 0)
  // Offset between local wall clock and UTC at this instant.
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  const offsetMs = wallAsUtc - d.getTime()
  return new Date(localMidnightAsUtc - offsetMs)
}

export const DAY_MS = 24 * 3600 * 1000
export const HOUR_MS = 3600 * 1000

export function startOfHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS)
}
