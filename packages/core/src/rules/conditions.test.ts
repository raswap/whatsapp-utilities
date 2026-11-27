import { RE2JS } from 're2js'
import { describe, expect, it } from 'vitest'
import type { StoredEvent } from '../events/types.js'
import {
  containsKeyword,
  type EvalContext,
  evaluateCondition,
  MAX_REGEX_INPUT,
  normalizeText,
  regexMatches,
} from './conditions.js'
import type { Condition } from './schema.js'
import { CHAT, makeCtx, makeEvent, SENDER, T0 } from './testing/fixtures.js'

const deps = (patterns: string[] = []) => ({
  ruleId: 'r',
  regexes: new Map(patterns.map((p) => [p, RE2JS.compile(p)] as const)),
})
const run = (
  c: Condition,
  e: StoredEvent = makeEvent(),
  ctx: EvalContext = makeCtx(),
  patterns: string[] = [],
) => evaluateCondition(c, e, ctx, deps(patterns))
const passes = (...args: Parameters<typeof run>) => run(...args).every((r) => r.passed)

describe('keyword matching (T34)', () => {
  it('is case-insensitive, NFKC-normalised, diacritics-stripped substring', () => {
    expect(normalizeText('Ürgent ﬁle Café')).toBe('urgent file cafe')
    expect(containsKeyword('Das ist ÜRGENT!!', ['urgent'])).toBe('urgent')
    expect(containsKeyword('cafe please', ['café'])).toBe('café')
    expect(containsKeyword('nothing here', ['urgent', 'asap'])).toBeNull()
    expect(containsKeyword('', ['x'])).toBeNull()
  })
})

describe('regex (T28, FR-R2)', () => {
  it('the pathological (a+)+$ finishes under 10 ms on 64 KB and input is capped at 64 KB', () => {
    const d = deps(['(a+)+$'])
    const input = `${'a'.repeat(MAX_REGEX_INPUT)}!`
    let hit = false
    let ms = Number.POSITIVE_INFINITY
    // Best of five: the first pass pays for JIT warm-up, which is not what the acceptance criterion measures.
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      hit = regexMatches(d.regexes, '(a+)+$', input)
      ms = Math.min(ms, performance.now() - t0)
    }
    expect(ms).toBeLessThan(10)
    // the 64 KB prefix is all a's, so the truncated input matches even though the full string ends in '!'
    expect(hit).toBe(true)
    expect(regexMatches(d.regexes, '(a+)+$', 'aaa!')).toBe(false)
    expect(() => regexMatches(d.regexes, 'not compiled', 'x')).toThrow('regex not compiled')
  })
})

describe('one predicate per deterministic condition', () => {
  it('sender, allow_list, deny_list and group use canonical ids or JIDs', () => {
    expect(run({ sender: CHAT })).toEqual([{ name: 'sender', passed: true, detail: CHAT }])
    expect(run({ sender: [SENDER] })[0]?.passed).toBe(true)
    expect(run({ sender: 'nobody' })).toEqual([
      { name: 'sender', passed: false, detail: 'sender not listed' },
    ])
    expect(passes({ allow_list: [SENDER] })).toBe(true)
    expect(passes({ allow_list: ['x'] })).toBe(false)
    expect(run({ deny_list: ['x'] })).toEqual([{ name: 'deny_list', passed: true }])
    expect(run({ deny_list: [SENDER] })).toEqual([{ name: 'deny_list', passed: false, detail: SENDER }])
    expect(passes({ group: CHAT })).toBe(true)
    expect(passes({ group: ['a', 'b'] })).toBe(false)
    expect(passes({ group: 'g' }, makeEvent({ chatId: null }))).toBe(false)
  })

  it('message type, media presence, keywords and regex read the payload', () => {
    const img = makeEvent({ payload: { kind: 'image', caption: 'Receipt #4521', mediaRef: 'm1' } })
    expect(run({ message_type: 'image' }, img)).toEqual([
      { name: 'message_type', passed: true, detail: 'image' },
    ])
    expect(passes({ message_type: ['text', 'voice'] }, img)).toBe(false)
    expect(passes({ message_type: 'unknown' }, makeEvent({ payload: {} }))).toBe(true)
    expect(passes({ has_media: true }, img)).toBe(true)
    expect(passes({ has_media: false }, img)).toBe(false)
    expect(passes({ has_media: true })).toBe(false)
    expect(passes({ has_media: true }, makeEvent({ payload: { kind: 'text', mediaRef: 'x' } }))).toBe(true)
    expect(run({ keywords: ['receipt'] }, img)).toEqual([
      { name: 'keywords', passed: true, detail: 'receipt' },
    ])
    expect(passes({ keywords: ['refund'] }, img)).toBe(false)
    expect(passes({ regex: '#\\d{4}' }, img, makeCtx(), ['#\\d{4}'])).toBe(true)
    expect(passes({ regex: '#\\d{4}' }, makeEvent(), makeCtx(), ['#\\d{4}'])).toBe(false)
  })

  it('mentions_me, reply_to_me and quoted filters', () => {
    const mention = makeEvent({ payload: { kind: 'text', body: 'hey @me', mentions: ['me@s.whatsapp.net'] } })
    expect(passes({ mentions_me: true }, mention, makeCtx({ me: ['ME', 'me@s.whatsapp.net'] }))).toBe(true)
    expect(passes({ mentions_me: true }, mention)).toBe(false)
    expect(passes({ mentions_me: false })).toBe(true)
    const quoted = {
      id: 'q',
      providerId: 'Q1',
      chatId: CHAT,
      senderId: 'ME',
      eventId: 'q',
      type: 'text',
      body: 'Your order ships Monday',
      bodyTsv: '',
      mediaId: null,
      quotedProviderId: null,
      isFromMe: true,
      origin: 'other_device',
      occurredAt: T0,
      deletedAt: null,
      editedAt: null,
      bodyHash: null,
    }
    const withQ = makeCtx({ quoted })
    expect(passes({ reply_to_me: true }, makeEvent(), withQ)).toBe(true)
    expect(passes({ reply_to_me: true })).toBe(false)
    expect(passes({ reply_to_me: false })).toBe(true)
    expect(run({ quoted: { from_me: true } })).toEqual([
      { name: 'quoted', passed: false, detail: 'no quoted message' },
    ])
    expect(run({ quoted: { from_me: false } }, makeEvent(), withQ)[0]).toMatchObject({
      passed: false,
      detail: 'quoted.from_me',
    })
    expect(passes({ quoted: { from_me: true, keywords: ['order'] } }, makeEvent(), withQ)).toBe(true)
    expect(run({ quoted: { keywords: ['refund'] } }, makeEvent(), withQ)[0]?.detail).toBe('quoted.keywords')
    expect(passes({ quoted: { regex: 'Mon' } }, makeEvent(), withQ, ['Mon'])).toBe(true)
    expect(run({ quoted: { regex: 'Tue' } }, makeEvent(), withQ, ['Tue'])[0]?.detail).toBe('quoted.regex')
    expect(
      passes({ quoted: { from_me: true } }, makeEvent(), makeCtx({ quoted: { ...quoted, body: null } })),
    ).toBe(true)
  })

  it('facts, counters and sampling read the context snapshot', () => {
    const ctx = makeCtx({ facts: { vip: 'yes' }, counters: { 'rule:r:matches': 3 } })
    expect(passes({ facts: { vip: 'yes' } }, makeEvent(), ctx)).toBe(true)
    expect(run({ facts: { vip: 'no', other: 'x' } }, makeEvent(), ctx)[0]).toMatchObject({
      passed: false,
      detail: 'facts.vip',
    })
    expect(run({ counter: { name: 'matches', max: 3 } }, makeEvent(), ctx)).toEqual([
      { name: 'counter', passed: true, detail: 'matches=3' },
    ])
    expect(passes({ counter: { name: 'matches', max: 2 } }, makeEvent(), ctx)).toBe(false)
    expect(passes({ counter: { name: 'matches', min: 4 } }, makeEvent(), ctx)).toBe(false)
    expect(passes({ counter: { name: 'other', min: 0 } }, makeEvent(), ctx)).toBe(true)
    // the seeded draw is the same for the same event id
    const a = run({ sample: 0.5 })
    const b = run({ sample: 0.5 })
    expect(a).toEqual(b)
    expect(passes({ sample: 1 })).toBe(true)
    expect(run({ sample: 0.000001 })[0]?.passed).toBe(false)
  })

  it('time windows and skip_if_human_replied_within use the account zone and clock', () => {
    expect(passes({ time_window: 'business_hours' })).toBe(true)
    expect(passes({ not_time_window: 'business_hours' })).toBe(false)
    expect(passes({ time_window: '12:00-13:00', not_time_window: '00:00-01:00' })).toBe(false)
    const recent = makeCtx({ lastHumanReplyAt: new Date(T0.getTime() - 60_000) })
    expect(run({ skip_if_human_replied_within: '2m' }, makeEvent(), recent)[0]).toMatchObject({
      passed: false,
      detail: new Date(T0.getTime() - 60_000).toISOString(),
    })
    expect(passes({ skip_if_human_replied_within: '30s' }, makeEvent(), recent)).toBe(true)
    expect(run({ skip_if_human_replied_within: '2m' })).toEqual([
      { name: 'skip_if_human_replied_within', passed: true, detail: 'no human reply' },
    ])
  })

  it('evaluates cheap keys first and stops at the first failure', () => {
    const r = run(
      { regex: 'x', keywords: ['nope'], message_type: 'text', sender: 'nobody' },
      makeEvent(),
      makeCtx(),
      ['x'],
    )
    expect(r.map((x) => x.name)).toEqual(['message_type', 'sender'])
  })

  it('P2 conditions are refused here; validation stops them earlier', () => {
    expect(() => run({ llm_condition: 'is angry' } as Condition)).toThrow('needs P2 understanding')
  })
})
