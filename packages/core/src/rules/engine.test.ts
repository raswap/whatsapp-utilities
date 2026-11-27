import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { StoredEvent } from '../events/types.js'
import type { EvalContext } from './conditions.js'
import {
  type CompiledRule,
  compileRule,
  counterKeys,
  evaluate,
  onMatch,
  type PlanState,
  plan,
  rateKeys,
  seededRng,
} from './engine.js'
import { RuleSchema } from './schema.js'
import { ACCOUNT, CHAT, compileYaml, json, makeCtx, makeEvent, SENDER, T0 } from './testing/fixtures.js'

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'golden')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

const W = 'when:\n  event: message.received\n'
const LABEL = 'actions:\n  - set_label: hit\n'
const SEND = 'actions:\n  - send_message:\n      text: "Hi {{contact.display_name}}"\n'
const rule = (id: string, body: string) => `id: ${id}\n${body}`

interface Golden {
  name: string
  yaml: string
  event?: Partial<StoredEvent> & { type?: string }
  ctx?: Partial<EvalContext>
}

const QUOTED = {
  id: 'q',
  providerId: 'Q1',
  chatId: CHAT,
  senderId: 'ME',
  eventId: 'q',
  type: 'text',
  body: 'ships Monday',
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

/** One golden per trigger kind (FR-R1) and per deterministic condition (FR-R2), plus every action kind. */
const GOLDENS: Golden[] = [
  // triggers
  { name: 'trigger-message-received', yaml: rule('t1', `${W}${LABEL}`) },
  {
    name: 'trigger-message-sent',
    yaml: rule('t2', 'when:\n  event: message.sent\n  from_me: true\nactions:\n  - mark_read: true\n'),
    event: { type: 'message.sent', isFromMe: true, origin: 'other_device' },
  },
  {
    name: 'trigger-message-reaction',
    yaml: rule('t3', 'when:\n  event: message.reaction\nactions:\n  - set_label: reacted\n'),
    event: { type: 'message.reaction', payload: { reactorJid: CHAT, emoji: '👍' } },
  },
  {
    name: 'trigger-group-participant-added',
    yaml: rule(
      't4',
      'scope:\n  chat_type: group\nwhen:\n  event: group.participant_added\nactions:\n  - notify_operator:\n      text: "joined {{chat.name}}"\n',
    ),
    event: { type: 'group.participant_added', chatId: '120@g.us', payload: { participant: 'x' } },
    ctx: { chat: { ...makeCtx().chat, id: '120@g.us', type: 'group', name: 'Ops' } as EvalContext['chat'] },
  },
  {
    name: 'trigger-schedule-cron',
    yaml: rule(
      't5',
      'when:\n  event: schedule.cron\n  cron: "0 18 * * *"\nactions:\n  - notify_operator:\n      title: "Digest"\n      text: "{{now.date}} in {{account.timezone}}"\n',
    ),
    event: { type: 'schedule.cron', providerId: null, senderId: null, payload: {} },
    ctx: { contact: null, senderIds: [] },
  },
  {
    name: 'trigger-schedule-no-reply-within',
    yaml: rule(
      't6',
      'when:\n  event: schedule.no_reply_within\n  no_reply_within: 2h\nactions:\n  - escalate:\n      reason: "no reply to {{chat.name}} for 2h"\n',
    ),
    event: { type: 'schedule.no_reply_within', providerId: null, payload: {} },
  },
  {
    name: 'trigger-manual',
    yaml: rule('t7', `when:\n  event: manual\n${SEND}policy:\n  approval: auto\n`),
    event: { type: 'manual', providerId: null, payload: {} },
  },
  { name: 'trigger-mismatch', yaml: rule('t8', 'when:\n  event: chat.opened\nactions:\n  - set_label: x\n') },
  // conditions
  { name: 'cond-sender', yaml: rule('c1', `${W}  sender: ${CHAT}\n${LABEL}`) },
  { name: 'cond-sender-miss', yaml: rule('c1b', `${W}  sender: [nobody]\n${LABEL}`) },
  { name: 'cond-allow-list', yaml: rule('c2', `${W}  allow_list: [${SENDER}]\n${LABEL}`) },
  { name: 'cond-deny-list', yaml: rule('c3', `${W}  deny_list: [${SENDER}]\n${LABEL}`) },
  {
    name: 'cond-group',
    yaml: rule(
      'c4',
      'scope:\n  group: 120@g.us\nwhen:\n  event: message.received\n  group: [120@g.us]\nactions:\n  - set_label: ops\n',
    ),
    event: { chatId: '120@g.us' },
    ctx: { chat: { ...makeCtx().chat, id: '120@g.us', type: 'group', name: 'Ops' } as EvalContext['chat'] },
  },
  {
    name: 'cond-keywords',
    yaml: rule('c5', `${W}  keywords: ["urgent", "asap"]\n${LABEL}`),
    event: { payload: { kind: 'text', body: 'Das ist ÜRGENT!' } },
  },
  {
    name: 'cond-regex',
    yaml: rule('c6', `${W}  regex: "order #\\\\d{4}"\n${LABEL}`),
    event: { payload: { kind: 'text', body: 'my order #1234 is late' } },
  },
  {
    name: 'cond-message-type',
    yaml: rule('c7', `${W}  message_type: [voice, audio]\n${LABEL}`),
    event: { payload: { kind: 'voice', mediaRef: 'm1', mimeType: 'audio/ogg' } },
  },
  {
    name: 'cond-has-media',
    yaml: rule('c8', `${W}  has_media: true\n${LABEL}`),
    event: { payload: { kind: 'image', caption: 'look', mediaRef: 'm2' } },
  },
  {
    name: 'cond-mentions-me',
    yaml: rule('c9', `${W}  mentions_me: true\n${LABEL}`),
    event: { payload: { kind: 'text', body: '@me ping', mentions: ['me@s.whatsapp.net'] } },
    ctx: { me: ['ME', 'me@s.whatsapp.net'] },
  },
  {
    name: 'cond-reply-to-me',
    yaml: rule('c10', `${W}  reply_to_me: true\n${LABEL}`),
    ctx: { quoted: QUOTED },
  },
  {
    name: 'cond-quoted',
    yaml: rule(
      'c11',
      `${W}  quoted:\n    from_me: true\n    keywords: [monday]\n    regex: "ships"\n${LABEL}`,
    ),
    ctx: { quoted: QUOTED },
  },
  {
    name: 'cond-facts',
    yaml: rule('c12', `${W}  facts:\n    tier: gold\n${LABEL}`),
    ctx: { facts: { tier: 'gold' } },
  },
  {
    name: 'cond-counter',
    yaml: rule('c13', `${W}  counter: { name: matches, max: 2 }\n${LABEL}`),
    ctx: { counters: { 'rule:c13:matches': 2 } },
  },
  {
    name: 'cond-counter-exhausted',
    yaml: rule('c13b', `${W}  counter: { name: matches, max: 2 }\n${LABEL}`),
    ctx: { counters: { 'rule:c13b:matches': 3 } },
  },
  { name: 'cond-sample', yaml: rule('c14', `${W}  sample: 0.5\n${LABEL}`) },
  { name: 'cond-time-window', yaml: rule('c15', `${W}  time_window: "09:00-18:00"\n${LABEL}`) },
  { name: 'cond-not-time-window', yaml: rule('c16', `${W}  not_time_window: business_hours\n${LABEL}`) },
  {
    name: 'cond-skip-if-human-replied',
    yaml: rule('c17', `${W}  skip_if_human_replied_within: 2m\n${LABEL}`),
    ctx: { lastHumanReplyAt: new Date(T0.getTime() - 30_000) },
  },
  { name: 'cond-from-me', yaml: rule('c18', `${W}  from_me: true\n${LABEL}`) },
  { name: 'cond-ignore-backfill', yaml: rule('c19', `${W}${LABEL}`), event: { isBackfill: true } },
  {
    name: 'cond-backfill-allowed-sends-off',
    yaml: rule(
      'c19b',
      `${W}  ignore_backfill: false\n${SEND}  - set_label: seen\npolicy:\n  approval: auto\n`,
    ),
    event: { isBackfill: true },
  },
  {
    name: 'cond-any-of',
    yaml: rule('c20', `${W}  any_of:\n    - keywords: [refund]\n    - regex: "money back"\n${LABEL}`),
    event: { payload: { kind: 'text', body: 'I want my MONEY back' } },
  },
  {
    name: 'cond-all-of',
    yaml: rule('c21', `${W}  all_of:\n    - keywords: [refund]\n    - message_type: text\n${LABEL}`),
    event: { payload: { kind: 'text', body: 'refund please' } },
  },
  {
    name: 'cond-all-of-miss',
    yaml: rule('c21b', `${W}  all_of:\n    - keywords: [refund]\n    - message_type: image\n${LABEL}`),
    event: { payload: { kind: 'text', body: 'refund please' } },
  },
  {
    name: 'cond-not',
    yaml: rule('c22', `${W}  not:\n    - keywords: [spam]\n    - sender: nobody\n${LABEL}`),
  },
  { name: 'cond-not-miss', yaml: rule('c22b', `${W}  not:\n    - keywords: [hello]\n${LABEL}`) },
  // actions
  {
    name: 'actions-every-kind',
    yaml: rule(
      'a1',
      `scope:\n  chat: ${CHAT}\n${W}actions:\n  - send_message:\n      text: "Hi {{contact.display_name}}, re: {{message.body}}"\n      reply: true\n      typing_delay: natural\n      rate_limit: { per_chat: "1/1d", per_contact: "2/h", per_rule: "10/d" }\n  - react_to_message: { emoji: "👍" }\n  - mark_read: true\n  - set_label: vip\n  - remove_label: new\n  - escalate: true\n  - notify_operator:\n      title: "From {{contact.display_name}}"\n      text: "{{message.body}}"\n  - set_chat_automation: { state: paused, duration: 1h }\n  - remember_fact: { key: last_seen, value: "{{event.occurred_at}}", ttl: 90d }\n  - schedule:\n      after: 10m\n      action:\n        send_message:\n          text: "Still there?"\npolicy:\n  approval: auto\n  quiet_hours_override: true\n`,
    ),
    event: { payload: { kind: 'text', body: '*hi* there' } },
  },
  {
    name: 'actions-schedule-fact-and-unsupported',
    yaml: rule(
      'a2',
      `${W}  sender: ${SENDER}\nactions:\n  - schedule:\n      after: 1h\n      action:\n        remember_fact: { key: followup, value: "{{message.body}}", subject: chat }\n  - notify:\n      target: ops@s.whatsapp.net\n      text: "{{message.body}}"\n  - call_tool:\n      target: hook\n      args: { body: "{{message.body}}" }\n  - set_chat_automation: { state: active }\n`,
    ),
  },
  {
    name: 'actions-denied-and-suppressed',
    yaml: rule('a3', `${W}${SEND}  - set_label: seen\n  - react_to_message: { emoji: "x" }\n`),
    ctx: { deniedKinds: ['react_to_message'], suppressed: 'chat automation is paused' },
  },
  {
    name: 'actions-all-denied',
    yaml: rule('a4', `${W}${SEND}`),
    ctx: { deniedKinds: ['send_message'] },
  },
  {
    name: 'gate-7-6-tainted-off-chat-forced-approve',
    yaml: rule(
      'g1',
      `${W}actions:\n  - send_message:\n      text: "FYI: {{message.body}}"\n      to: boss@s.whatsapp.net\n      destinations: [boss@s.whatsapp.net]\npolicy:\n  approval: auto\n`,
    ),
  },
  {
    name: 'gate-7-6-destination-not-allowed',
    yaml: rule(
      'g2',
      `${W}actions:\n  - send_message:\n      text: "FYI: {{message.body}}"\n      to: boss@s.whatsapp.net\npolicy:\n  approval: auto\n`,
    ),
  },
  {
    name: 'gate-7-6-clean-off-chat-keeps-policy',
    yaml: rule(
      'g3',
      `${W}actions:\n  - send_message:\n      text: "Ping at {{now.time}}"\n      to: boss@s.whatsapp.net\npolicy:\n  approval: auto\n`,
    ),
  },
]

const TARGETS = {
  hook: {
    kind: 'http' as const,
    url: 'https://example.com/hook',
    timeout_ms: 5000,
    data_policy: { fields: [], pseudonymise_phones: true, honour_llm_optout: true, max_bytes: 16_384 },
    allow_private: false,
  },
}

describe('golden traces (design §7)', () => {
  for (const g of GOLDENS) {
    it(g.name, () => {
      const compiled = compileYaml(g.yaml, { targets: TARGETS })
      const e = makeEvent(g.event)
      const got = json(evaluate(e, [compiled], makeCtx({ ...g.ctx, rng: seededRng(e.id) })))
      const file = resolve(GOLDEN, `${g.name}.json`)
      if (UPDATE || !existsSync(file)) writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`)
      expect(got).toEqual(JSON.parse(readFileSync(file, 'utf8')))
    })
  }
})

describe('plan (pure)', () => {
  const state = (over: Partial<PlanState> = {}): PlanState => ({
    accountId: 'main',
    phoneNumber: null,
    chatType: 'dm',
    labels: [],
    senderIds: [SENDER, CHAT],
    now: T0,
    zone: 'UTC',
    businessHours: ACCOUNT.business_hours,
    chat: makeCtx().chat,
    senderBlocked: false,
    accountPaused: false,
    throttled: false,
    globalKill: false,
    ...over,
  })
  const rules = [
    compileYaml(rule('low', `${W}never: [send_media]\n${LABEL}`)),
    compileYaml(rule('vip', `scope:\n  label: vip\n${W}deny: [react_to_message]\n${LABEL}`)),
    compileYaml(rule('mine', `scope:\n  contact: ${SENDER}\n  chat_type: dm\n${W}priority: 5\n${LABEL}`)),
    compileYaml(rule('me2', `scope:\n  contact: ${SENDER}\n  chat_type: dm\n${W}priority: 5\n${LABEL}`)),
    compileYaml(rule('grp', `scope:\n  chat_type: group\n${W}deny: [forward_message]\n${LABEL}`)),
  ]

  it('scope-matches, orders by specificity, unions denies of scope-matched rules only', () => {
    const p = plan(makeEvent(), rules, state({ labels: ['vip'] }))
    expect(p.candidates.map((r) => r.id)).toEqual(['me2', 'mine', 'vip', 'low'])
    expect(p.skipped).toEqual([{ ruleId: 'grp', reason: 'scope' }])
    expect(p.deniedKinds).toEqual(['react_to_message', 'send_media'])
    expect(p.suppressed).toBeNull()
    expect(p.dropped).toBeNull()
    const noVip = plan(makeEvent(), rules, state())
    expect(noVip.deniedKinds).toEqual(['send_media'])
    // input order does not matter
    expect(plan(makeEvent(), [...rules].reverse(), state()).candidates.map((r) => r.id)).toEqual(
      noVip.candidates.map((r) => r.id),
    )
  })

  it('short-circuits: kill switch, account paused, throttled, chat paused or escalated', () => {
    const paused = (s: string, until: Date | null = null) =>
      ({ ...makeCtx().chat, automationState: s, pausedUntil: until }) as PlanState['chat']
    expect(plan(makeEvent(), rules, state({ globalKill: true })).suppressed).toBe('global kill switch is on')
    expect(plan(makeEvent(), rules, state({ accountPaused: true })).suppressed).toBe('account is paused')
    expect(plan(makeEvent(), rules, state({ throttled: true })).suppressed).toBe('account is throttled')
    expect(plan(makeEvent(), rules, state({ chat: paused('escalated') })).suppressed).toBe(
      'chat automation is escalated',
    )
    expect(plan(makeEvent(), rules, state({ chat: paused('paused') })).suppressed).toBe(
      'chat automation is paused',
    )
    expect(
      plan(makeEvent(), rules, state({ chat: paused('paused', new Date(T0.getTime() + 1000)) })).suppressed,
    ).toBe('chat automation is paused')
    expect(
      plan(makeEvent(), rules, state({ chat: paused('paused', new Date(T0.getTime() - 1)) })).suppressed,
    ).toBeNull()
    expect(plan(makeEvent(), rules, state({ chat: null })).suppressed).toBeNull()
  })

  it('drops everything for a blocked sender (gate check 0)', () => {
    const p = plan(makeEvent(), rules, state({ senderBlocked: true }))
    expect(p).toEqual({
      candidates: [],
      skipped: rules.map((r) => ({ ruleId: r.id, reason: 'sender_blocked' })),
      deniedKinds: [],
      suppressed: null,
      dropped: 'sender_blocked',
    })
  })
})

describe('evaluate (pure)', () => {
  it('on_match: default stop for sending rules, continue otherwise, explicit wins', () => {
    const send = compileYaml(rule('s', `${W}${SEND}`))
    const label = compileYaml(rule('l', `${W}${LABEL}`))
    const sendContinue = compileYaml(rule('sc', `${W}${SEND}on_match: continue\n`))
    const labelStop = compileYaml(rule('ls', `${W}${LABEL}on_match: stop\n`))
    expect(onMatch(send.definition)).toBe('stop')
    expect(onMatch(label.definition)).toBe('continue')
    expect(onMatch(sendContinue.definition)).toBe('continue')
    const r1 = evaluate(makeEvent(), [send, label], makeCtx())
    expect(r1.traces.map((t) => [t.ruleId, t.outcome, t.reason])).toEqual([
      ['s', 'matched', undefined],
      ['l', 'not_matched', 'stopped by s'],
    ])
    expect(r1.actions.map((a) => a.kind)).toEqual(['send_message'])
    const r2 = evaluate(makeEvent(), [sendContinue, label], makeCtx())
    expect(r2.actions.map((a) => a.kind)).toEqual(['send_message', 'set_label'])
    const r3 = evaluate(makeEvent(), [labelStop, label], makeCtx())
    expect(r3.traces[1]?.reason).toBe('stopped by ls')
    // a rule whose conditions fail does not stop the walk
    const miss = compileYaml(rule('m', `${W}  keywords: [nope]\n${SEND}`))
    expect(evaluate(makeEvent(), [miss, label], makeCtx()).actions.map((a) => a.kind)).toEqual(['set_label'])
  })

  it('maps rule actions onto PlannedAction (FR-X1 keys, source, approval, quiet-hours flags)', () => {
    const r = compileYaml(
      rule(
        'map',
        `scope:\n  thread: P1\n${W}actions:\n  - send_message:\n      text: "Hi {{contact.display_name}}"\n  - set_label: x\npolicy:\n  quiet_hours_override: true\n`,
      ),
    )
    const ctx = makeCtx({ deniedKinds: ['forward_message'] })
    const [send, label] = evaluate(makeEvent(), [r], ctx).actions
    expect(send).toEqual({
      kind: 'send_message',
      source: 'rule:map',
      actor: 'rule:map',
      idempotencyKey: 'rule:map:01EVENT:0',
      chatId: CHAT,
      recipientContactId: SENDER,
      payload: { text: 'Hi Asha' },
      ruleId: 'map',
      eventId: '01EVENT',
      inboundOrigin: null,
      bodyHash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      approval: 'approve',
      overrideQuietHours: true,
      allowQuietOverride: true,
      deniedKinds: ['forward_message'],
      text: 'Hi Asha',
    })
    expect(label).toMatchObject({
      kind: 'set_label',
      idempotencyKey: 'rule:map:01EVENT:1',
      payload: { label: 'x' },
    })
    // no body, no sender: no hash, no recipient; global scope: no quiet override
    const bare = evaluate(
      makeEvent({ senderId: null, payload: {} }),
      [compileYaml(rule('b', `${W}${LABEL}`))],
      ctx,
    )
    expect(bare.actions[0]).not.toHaveProperty('bodyHash')
    expect(bare.actions[0]).not.toHaveProperty('recipientContactId')
    expect(bare.actions[0]).toMatchObject({ allowQuietOverride: false, approval: 'auto' })
  })

  it('PRD §7.6 additional rule: message-derived text to another recipient is forced to approve and allowlisted', () => {
    const tainted = compileYaml(
      rule(
        't',
        `${W}actions:\n  - send_message:\n      text: "{{message.body}}"\n      to: boss@s.whatsapp.net\n      destinations: [boss@s.whatsapp.net]\npolicy:\n  approval: auto\n`,
      ),
    )
    const [a] = evaluate(makeEvent(), [tainted], makeCtx()).actions
    expect(a).toMatchObject({ approval: 'approve', chatId: 'boss@s.whatsapp.net' })
    expect(a).not.toHaveProperty('recipientContactId')
    const noList = compileYaml(
      rule(
        'n',
        `${W}actions:\n  - send_message:\n      text: "{{contact.display_name}} wrote"\n      to: boss@s.whatsapp.net\npolicy:\n  approval: auto\n`,
      ),
    )
    const r = evaluate(makeEvent(), [noList], makeCtx())
    expect(r.actions).toEqual([])
    expect(r.traces[0]?.actions[0]).toMatchObject({ status: 'destination_not_allowed' })
    const clean = compileYaml(
      rule(
        'c',
        `${W}actions:\n  - send_message:\n      text: "ping"\n      to: boss@s.whatsapp.net\npolicy:\n  approval: auto\n`,
      ),
    )
    expect(evaluate(makeEvent(), [clean], makeCtx()).actions[0]?.approval).toBe('auto')
    const listed = compileYaml(
      rule(
        'l',
        `${W}actions:\n  - send_message:\n      text: "ping"\n      to: other@s.whatsapp.net\n      destinations: [boss@s.whatsapp.net]\npolicy:\n  approval: auto\n`,
      ),
    )
    expect(evaluate(makeEvent(), [listed], makeCtx()).traces[0]?.actions[0]?.status).toBe(
      'destination_not_allowed',
    )
    // `to` equal to the inbound chat is an ordinary reply
    const same = compileYaml(
      rule(
        's',
        `${W}actions:\n  - send_message:\n      text: "{{message.body}}"\n      to: ${CHAT}\npolicy:\n  approval: auto\n`,
      ),
    )
    expect(evaluate(makeEvent(), [same], makeCtx()).actions[0]).toMatchObject({
      approval: 'auto',
      recipientContactId: SENDER,
    })
  })

  it('action rate limits read counters and emit deltas; exhausted ones are skipped', () => {
    const r = compileYaml(
      rule(
        'rl',
        `${W}actions:\n  - send_message:\n      text: "once a day"\n      rate_limit: { per_chat: "1/1d" }\npolicy:\n  approval: auto\n`,
      ),
    )
    const e = makeEvent()
    const [key] = rateKeys(r, 0, e, T0)
    expect(key).toEqual({
      key: `rule:rl:rate:0:chat:${CHAT}:${Math.floor(T0.getTime() / 86_400_000)}`,
      limit: 1,
    })
    const first = evaluate(e, [r], makeCtx())
    expect(first.actions).toHaveLength(1)
    expect(first.deltas).toEqual([
      { counter: 'rule:rl:matches', by: 1 },
      { counter: key?.key, by: 1 },
    ])
    const second = evaluate(e, [r], makeCtx({ counters: { [key?.key as string]: 1 } }))
    expect(second.actions).toEqual([])
    expect(second.traces[0]).toMatchObject({
      outcome: 'matched',
      actions: [{ status: 'rate_limited', reason: 'chat' }],
    })
    expect(second.deltas).toEqual([{ counter: 'rule:rl:matches', by: 1 }])
    expect(rateKeys(r, 1, e, T0)).toEqual([])
    expect(rateKeys(r, 0, makeEvent({ chatId: null }), T0)).toEqual([])
    expect(counterKeys([r], e, T0)).toEqual(['rule:rl:matches', key?.key])
  })

  it('a throwing rule yields an error trace and the walk continues', () => {
    const boom = compileYaml(
      rule(
        'boom',
        'when:\n  event: chat.opened\nactions:\n  - remember_fact: { key: k, value: v, subject: contact }\n',
      ),
    )
    const ok = compileYaml(rule('ok', 'when:\n  event: chat.opened\nactions:\n  - set_label: opened\n'))
    const r = evaluate(makeEvent({ type: 'chat.opened', senderId: null, payload: {} }), [boom, ok], makeCtx())
    expect(r.traces[0]).toMatchObject({
      outcome: 'error',
      reason: 'remember_fact: event has no contact subject',
    })
    expect(r.traces[1]?.outcome).toBe('matched')
    expect(r.actions).toHaveLength(1)
  })

  it('compileRule compiles each regex once and marks message-derived actions', () => {
    const r = compileYaml(
      rule(
        'cr',
        `${W}  regex: "a+"\n  quoted: { regex: "a+" }\n  any_of:\n    - regex: "b+"\nactions:\n  - notify_operator:\n      text: "{{message.body}}"\n  - set_label: x\n  - remember_fact: { key: k, value: "{{contact.display_name}}" }\n  - schedule:\n      after: 1m\n      action:\n        notify_operator:\n          text: "{{now.time}}"\n`,
      ),
    )
    expect([...r.regexes.keys()]).toEqual(['a+', 'b+'])
    expect(r.tainted).toEqual([true, false, true, false])
    expect(compileRule({ definition: r.definition, account: 'main' }).account).toBe('main')
  })
})

describe('determinism loop (G5)', () => {
  const rng = seededRng('determinism')
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T
  const maybe = (p: number) => rng() < p
  const WORDS = ['urgent', 'refund', 'hello', 'asap', 'order #1234', 'money back', 'ÜRGENT', 'thanks']
  const CONDS = [
    () => ({ keywords: [pick(WORDS)] }),
    () => ({ regex: pick(['#\\d+', 'a+', 'back$']) }),
    () => ({ sender: pick([SENDER, 'nobody']) }),
    () => ({ message_type: pick(['text', 'image']) }),
    () => ({ has_media: maybe(0.5) }),
    () => ({ sample: 0.5 }),
    () => ({ counter: { name: 'matches', max: 2 } }),
    () => ({ time_window: pick(['business_hours', '00:00-12:00']) }),
    () => ({ skip_if_human_replied_within: '5m' }),
    () => ({ facts: { tier: 'gold' } }),
  ]
  const ACTIONS = [
    () => ({
      send_message: {
        text: pick(['Hi {{contact.display_name}}', '{{message.body}}']),
        rate_limit: { per_chat: '2/h' },
      },
    }),
    () => ({ set_label: pick(['a', 'b']) }),
    () => ({ notify_operator: { text: '{{message.body}} at {{now.time}}' } }),
    () => ({ react_to_message: { emoji: '👍' } }),
    () => ({ remember_fact: { key: 'k', value: '{{event.id}}', ttl: '1d' } }),
    () => ({ schedule: { after: '5m', action: { set_label: 'later' } } }),
  ]
  const genRule = (i: number): CompiledRule => {
    const when: Record<string, unknown> = {
      event: pick(['message.received', 'message.received', 'message.sent']),
    }
    if (maybe(0.3)) when.from_me = maybe(0.5)
    if (maybe(0.3)) when.ignore_backfill = maybe(0.5)
    Object.assign(when, pick(CONDS)())
    if (maybe(0.4)) when.any_of = [pick(CONDS)(), pick(CONDS)()]
    if (maybe(0.3)) when.not = [pick(CONDS)()]
    const scope: Record<string, unknown> = {}
    if (maybe(0.3)) scope.chat_type = pick(['dm', 'group'])
    if (maybe(0.3)) scope.contact = pick([SENDER, 'other'])
    if (maybe(0.2)) scope.label = 'vip'
    const def = RuleSchema.parse({
      id: `r${i}`,
      scope,
      when,
      ...(maybe(0.3) ? { never: [pick(['send_message', 'react_to_message'])] } : {}),
      actions: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => pick(ACTIONS)()),
      ...(maybe(0.5) ? { on_match: pick(['stop', 'continue']) } : {}),
      policy: { approval: pick(['auto', 'approve', 'dry_run']) },
      priority: Math.floor(rng() * 10) - 5,
    })
    return compileRule({ definition: def, account: null })
  }
  const genEvent = (i: number): StoredEvent =>
    makeEvent({
      id: `EV${i}`,
      type: pick(['message.received', 'message.sent']),
      isFromMe: maybe(0.2),
      isBackfill: maybe(0.2),
      payload: {
        kind: pick(['text', 'image']),
        body: `${pick(WORDS)} ${pick(WORDS)}`,
        ...(maybe(0.3) ? { mediaRef: 'm' } : {}),
      },
    })

  it('evaluate gives the same Evaluation twice for 300 generated event and rule sets', () => {
    let matched = 0
    for (let i = 0; i < 300; i++) {
      const rules = Array.from({ length: 1 + Math.floor(rng() * 5) }, (_, k) => genRule(i * 10 + k))
      const e = genEvent(i)
      const over: Partial<EvalContext> = {
        labels: maybe(0.5) ? ['vip'] : [],
        counters: { [`rule:${rules[0]?.id}:matches`]: Math.floor(rng() * 4) },
        facts: maybe(0.5) ? { tier: 'gold' } : {},
        lastHumanReplyAt: maybe(0.5) ? new Date(T0.getTime() - 60_000) : null,
        deniedKinds: maybe(0.3) ? ['send_message'] : [],
        suppressed: maybe(0.2) ? 'account is paused' : null,
        now: new Date(T0.getTime() + Math.floor(rng() * 86_400_000)),
      }
      const a = json(evaluate(e, rules, makeCtx({ ...over, rng: seededRng(e.id) })))
      const b = json(evaluate(e, rules, makeCtx({ ...over, rng: seededRng(e.id) })))
      expect(b).toEqual(a)
      matched += a.traces.filter((t) => t.outcome === 'matched').length
    }
    expect(matched).toBeGreaterThan(50)
  })

  it('seededRng is deterministic per seed and uniform-ish', () => {
    const a = seededRng('x')
    const b = seededRng('x')
    const c = seededRng('y')
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs)
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true)
  })
})
