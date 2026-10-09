import { describe, expect, it } from 'vitest'
import { inBusinessHours, wallClock } from './hours.js'

describe('business hours', () => {
  const at = (iso: string) => new Date(iso)
  it('same-day windows respect days and bounds', () => {
    const bh = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }
    expect(inBusinessHours(at('2026-06-01T10:00:00Z'), 'UTC', bh)).toBe(true) // Monday
    expect(inBusinessHours(at('2026-06-01T18:00:00Z'), 'UTC', bh)).toBe(false) // end is exclusive
    expect(inBusinessHours(at('2026-06-06T10:00:00Z'), 'UTC', bh)).toBe(false) // Saturday
  })
  it('windows crossing midnight belong to the day they started on', () => {
    const bh = { days: [5], start: '22:00', end: '02:00' } // Friday night
    expect(inBusinessHours(at('2026-06-05T23:00:00Z'), 'UTC', bh)).toBe(true)
    expect(inBusinessHours(at('2026-06-06T01:00:00Z'), 'UTC', bh)).toBe(true) // Saturday 01:00 is still Friday's window
    expect(inBusinessHours(at('2026-06-06T03:00:00Z'), 'UTC', bh)).toBe(false)
    expect(inBusinessHours(at('2026-06-04T23:00:00Z'), 'UTC', bh)).toBe(false) // Thursday
    // Monday 01:00 falls back to Sunday (7)
    expect(
      inBusinessHours(at('2026-06-01T01:00:00Z'), 'UTC', { days: [7], start: '22:00', end: '02:00' }),
    ).toBe(true)
  })
  it('wallClock evaluates in the account zone', () => {
    expect(wallClock(at('2026-06-01T20:30:00Z'), 'Asia/Kolkata')).toEqual({ weekday: 2, minutes: 2 * 60 })
    expect(wallClock(at('2026-06-07T00:00:00Z'), 'UTC').weekday).toBe(7)
  })
})
