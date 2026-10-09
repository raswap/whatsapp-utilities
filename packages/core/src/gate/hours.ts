import type { z } from 'zod'
import type { BusinessHoursSchema } from '../config/schema.js'

export type BusinessHours = z.infer<typeof BusinessHoursSchema>

/** Weekday (1 = Monday ... 7 = Sunday) and HH:MM wall-clock in a zone. All windows are evaluated in the account zone (PRD §13). */
export function wallClock(d: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return { weekday: map[wd] ?? 1, minutes: hour * 60 + minute }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** True when `d` falls inside business hours. Windows may cross midnight (22:00 to 06:00). */
export function inBusinessHours(d: Date, timeZone: string, bh: BusinessHours): boolean {
  const { weekday, minutes } = wallClock(d, timeZone)
  const start = toMinutes(bh.start)
  const end = toMinutes(bh.end)
  if (start <= end) return bh.days.includes(weekday) && minutes >= start && minutes < end
  // Crosses midnight: the part after midnight belongs to the previous day's window.
  if (minutes >= start) return bh.days.includes(weekday)
  const prev = weekday === 1 ? 7 : weekday - 1
  return minutes < end && bh.days.includes(prev)
}
