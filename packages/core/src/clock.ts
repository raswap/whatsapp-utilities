export interface Clock {
  now(): Date
}
export const systemClock: Clock = { now: () => new Date() }

/** Test clock that can be advanced. */
export class ManualClock implements Clock {
  constructor(private t: Date = new Date('2026-01-01T00:00:00Z')) {}
  now() {
    return new Date(this.t)
  }
  set(d: Date) {
    this.t = new Date(d)
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms)
  }
}
