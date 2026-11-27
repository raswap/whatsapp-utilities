import { describe, expect, it } from 'vitest'
import {
  deniedKinds,
  inTimeWindow,
  type MatchContext,
  matchesScope,
  sortRules,
  specificity,
} from './match.js'
import { ACCOUNT, CHAT, compileYaml, makeEvent, SENDER, T0 } from './testing/fixtures.js'

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  accountId: 'main',
  phoneNumber: null,
  chatType: 'dm',
  labels: [],
  senderIds: [SENDER, CHAT],
  now: T0,
  zone: 'UTC',
  businessHours: ACCOUNT.business_hours,
  ...over,
})
const BH = ACCOUNT.business_hours

describe('scope matching (PRD §7.5)', () => {
  it('sums the weight table; global is 0', () => {
    expect(specificity({})).toBe(0)
    expect(specificity({ account: 'main', chat_type: 'dm' })).toBe(30)
    expect(specificity({ contact: 'x', time_window: 'business_hours', message_type: 'voice' })).toBe(60)
    expect(
      specificity({ group: 'g', participant_in_group: 'p', thread: 't', label: 'l', phone_number: 'n' }),
    ).toBe(215)
  })

  it('matches each key against the event and context; keys compose with AND', () => {
    const e = makeEvent()
    const g = makeEvent({ chatId: '120@g.us', payload: { kind: 'voice', quotedProviderId: 'ROOT' } })
    expect(matchesScope({}, e, ctx())).toBe(true)
    expect(matchesScope({ account: 'main' }, e, ctx())).toBe(true)
    expect(matchesScope({ account: 'other' }, e, ctx())).toBe(false)
    expect(matchesScope({ phone_number: '+1555' }, e, ctx())).toBe(false)
    expect(matchesScope({ phone_number: '+1555' }, e, ctx({ phoneNumber: '+1555' }))).toBe(true)
    expect(matchesScope({ chat_type: 'dm' }, e, ctx())).toBe(true)
    expect(matchesScope({ chat_type: 'group' }, e, ctx())).toBe(false)
    expect(matchesScope({ label: 'vip' }, e, ctx())).toBe(false)
    expect(matchesScope({ label: 'vip' }, e, ctx({ labels: ['vip'] }))).toBe(true)
    expect(matchesScope({ chat: CHAT }, e, ctx())).toBe(true)
    expect(matchesScope({ chat: 'x' }, e, ctx())).toBe(false)
    // a contact scope accepts the canonical id or any JID of the sender
    expect(matchesScope({ contact: SENDER }, e, ctx())).toBe(true)
    expect(matchesScope({ contact: CHAT }, e, ctx())).toBe(true)
    expect(matchesScope({ contact: 'nobody' }, e, ctx())).toBe(false)
    // group and participant_in_group need a group chat
    expect(matchesScope({ group: '120@g.us' }, g, ctx({ chatType: 'group' }))).toBe(true)
    expect(matchesScope({ group: '120@g.us' }, g, ctx({ chatType: 'dm' }))).toBe(false)
    expect(matchesScope({ participant_in_group: SENDER }, g, ctx({ chatType: 'group' }))).toBe(true)
    expect(matchesScope({ participant_in_group: SENDER }, e, ctx())).toBe(false)
    expect(matchesScope({ message_type: 'voice' }, g, ctx({ chatType: 'group' }))).toBe(true)
    expect(matchesScope({ message_type: 'text' }, g, ctx({ chatType: 'group' }))).toBe(false)
    expect(matchesScope({ time_window: 'business_hours' }, e, ctx())).toBe(true)
    expect(matchesScope({ time_window: '12:00-13:00' }, e, ctx())).toBe(false)
    expect(matchesScope({ thread: 'ROOT' }, g, ctx({ chatType: 'group' }))).toBe(true)
    expect(matchesScope({ thread: 'P1' }, e, ctx())).toBe(true)
    expect(matchesScope({ thread: 'OTHER' }, e, ctx())).toBe(false)
    expect(matchesScope({ account: 'main', chat_type: 'group' }, e, ctx())).toBe(false)
  })

  it('sorts by specificity desc, priority desc, id asc', () => {
    const rules = [
      { id: 'b', specificity: 10, priority: 0 },
      { id: 'a', specificity: 10, priority: 0 },
      { id: 'c', specificity: 10, priority: 5 },
      { id: 'd', specificity: 50, priority: -1 },
      { id: 'a', specificity: 10, priority: 0 },
    ]
    expect(sortRules(rules).map((r) => r.id)).toEqual(['d', 'c', 'a', 'a', 'b'])
    expect(rules[0]?.id).toBe('b') // input untouched
  })

  it('unions never and deny across scope-matched rules, sorted and de-duplicated', () => {
    const a = compileYaml(
      'id: a\nwhen:\n  event: message.received\nnever: [send_media, react_to_message]\nactions:\n  - set_label: x\n',
    )
    const b = compileYaml(
      'id: b\nwhen:\n  event: message.received\ndeny: [react_to_message, forward_message]\nactions:\n  - set_label: x\n',
    )
    const c = compileYaml('id: c\nwhen:\n  event: message.received\nactions:\n  - set_label: x\n')
    expect(deniedKinds([a, b, c])).toEqual(['forward_message', 'react_to_message', 'send_media'])
    expect(deniedKinds([c])).toEqual([])
  })
})

describe('time windows in the account zone with DST (FR-R2)', () => {
  const berlin = 'Europe/Berlin'
  const at = (iso: string) => new Date(iso)

  it('spring gap (last Sunday of March): the skipped hour never matches, a window across it keeps both sides', () => {
    // 2026-03-29: 02:00 CET jumps to 03:00 CEST.
    expect(inTimeWindow('02:00-03:00', at('2026-03-29T00:59:00Z'), berlin, BH)).toBe(false) // 01:59 CET
    expect(inTimeWindow('02:00-03:00', at('2026-03-29T01:00:00Z'), berlin, BH)).toBe(false) // 03:00 CEST
    expect(inTimeWindow('02:00-03:00', at('2026-03-29T01:30:00Z'), berlin, BH)).toBe(false) // 03:30 CEST
    expect(inTimeWindow('01:30-03:30', at('2026-03-29T00:45:00Z'), berlin, BH)).toBe(true) // 01:45 CET
    expect(inTimeWindow('01:30-03:30', at('2026-03-29T01:00:00Z'), berlin, BH)).toBe(true) // 03:00 CEST
    expect(inTimeWindow('01:30-03:30', at('2026-03-29T01:30:00Z'), berlin, BH)).toBe(false) // 03:30 CEST
    // the day before, the same window matches as usual
    expect(inTimeWindow('02:00-03:00', at('2026-03-28T01:30:00Z'), berlin, BH)).toBe(true) // 02:30 CET
  })

  it('autumn overlap (last Sunday of October): the repeated hour matches on both passes', () => {
    // 2026-10-25: 03:00 CEST falls back to 02:00 CET.
    expect(inTimeWindow('02:00-03:00', at('2026-10-25T00:30:00Z'), berlin, BH)).toBe(true) // 02:30 CEST
    expect(inTimeWindow('02:00-03:00', at('2026-10-25T01:30:00Z'), berlin, BH)).toBe(true) // 02:30 CET
    expect(inTimeWindow('02:00-03:00', at('2026-10-25T02:30:00Z'), berlin, BH)).toBe(false) // 03:30 CET
    expect(inTimeWindow('02:00-03:00', at('2026-10-24T23:30:00Z'), berlin, BH)).toBe(false) // 01:30 CEST
  })

  it('windows may cross midnight and business_hours follows the account settings', () => {
    expect(inTimeWindow('22:00-06:00', at('2026-06-01T23:30:00Z'), 'UTC', BH)).toBe(true)
    expect(inTimeWindow('22:00-06:00', at('2026-06-02T05:59:00Z'), 'UTC', BH)).toBe(true)
    expect(inTimeWindow('22:00-06:00', at('2026-06-02T06:00:00Z'), 'UTC', BH)).toBe(false)
    expect(inTimeWindow('business_hours', at('2026-06-01T08:59:00Z'), 'UTC', BH)).toBe(false)
    expect(inTimeWindow('business_hours', at('2026-06-01T09:00:00Z'), 'UTC', BH)).toBe(true)
    expect(inTimeWindow('business_hours', at('2026-06-06T12:00:00Z'), 'UTC', BH)).toBe(false) // Saturday
  })
})
