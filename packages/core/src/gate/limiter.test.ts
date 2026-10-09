import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '../clock.js'
import { AccountConfigSchema } from '../config/schema.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { inBusinessHours } from './hours.js'
import { DAY_MS, Limiter, startOfDayInZone } from './limiter.js'

let tdb: TestDatabase
beforeAll(async () => {
  tdb = await createTestDatabase()
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id: 'lim', type: 'web', display_name: 'L', timezone: 'UTC' }),
  )
})
afterAll(() => tdb.drop())

describe('limiter', () => {
  it('token bucket: peek never consumes, consume drains, refill restores', async () => {
    const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
    const lim = new Limiter(tdb.handle.db, tablesFor('acct_lim'), clock)
    expect((await lim.bucket('chat:a', 30, 1, 'peek')).allowed).toBe(true)
    expect((await lim.bucket('chat:a', 30, 1, 'peek')).allowed).toBe(true)
    expect((await lim.bucket('chat:a', 30, 1, 'consume')).allowed).toBe(true)
    const denied = await lim.bucket('chat:a', 30, 1, 'consume')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(25_000)
    clock.advance(31_000)
    expect((await lim.bucket('chat:a', 30, 1, 'consume')).allowed).toBe(true)
  })

  it('fixed window: counts, denies at the limit, refunds, and resets next window', async () => {
    const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
    const lim = new Limiter(tdb.handle.db, tablesFor('acct_lim'), clock)
    const ws = startOfDayInZone(clock.now(), 'UTC')
    for (let i = 0; i < 3; i++)
      expect((await lim.window('acct:day', ws, DAY_MS, 3, 'consume')).allowed).toBe(true)
    expect((await lim.window('acct:day', ws, DAY_MS, 3, 'peek')).allowed).toBe(false)
    await lim.window('acct:day', ws, DAY_MS, 3, 'refund')
    expect((await lim.window('acct:day', ws, DAY_MS, 3, 'peek')).allowed).toBe(true)
    const tomorrow = new Date(ws.getTime() + DAY_MS)
    expect((await lim.window('acct:day', tomorrow, DAY_MS, 3, 'peek')).remaining).toBe(3)
  })

  it('startOfDayInZone respects the account zone', () => {
    const d = new Date('2026-06-01T20:30:00Z') // 02:00 next day in Kolkata
    expect(startOfDayInZone(d, 'Asia/Kolkata').toISOString()).toBe('2026-06-01T18:30:00.000Z')
    expect(startOfDayInZone(d, 'UTC').toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })
})

describe('business hours', () => {
  const bh = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }
  it('evaluates in the account zone', () => {
    // 2026-06-01 is a Monday. 04:00 UTC is 09:30 in Kolkata.
    expect(inBusinessHours(new Date('2026-06-01T04:00:00Z'), 'Asia/Kolkata', bh)).toBe(true)
    expect(inBusinessHours(new Date('2026-06-01T04:00:00Z'), 'UTC', bh)).toBe(false)
    expect(inBusinessHours(new Date('2026-06-06T04:00:00Z'), 'Asia/Kolkata', bh)).toBe(false) // Saturday
  })
  it('handles windows that cross midnight', () => {
    const night = { days: [5], start: '22:00', end: '06:00' } // Friday night into Saturday morning
    expect(inBusinessHours(new Date('2026-06-05T23:00:00Z'), 'UTC', night)).toBe(true)
    expect(inBusinessHours(new Date('2026-06-06T03:00:00Z'), 'UTC', night)).toBe(true)
    expect(inBusinessHours(new Date('2026-06-06T07:00:00Z'), 'UTC', night)).toBe(false)
    expect(inBusinessHours(new Date('2026-06-04T23:00:00Z'), 'UTC', night)).toBe(false) // Thursday night
  })
  it('DST transition: a window spanning the spring-forward gap still evaluates', () => {
    // US spring forward 2026-03-08 02:00 local. 07:30Z is 02:30 which does not exist locally; it is 03:30 EDT.
    const d = new Date('2026-03-08T07:30:00Z')
    expect(inBusinessHours(d, 'America/New_York', { days: [7], start: '03:00', end: '04:00' })).toBe(true)
  })
})
