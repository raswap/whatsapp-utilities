import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import {
  actionClass,
  parseDuration,
  parseRate,
  type RuleAction,
  RuleSchema,
  TargetsSchema,
} from './schema.js'
import { isKnownVariable, parseTemplate } from './templates.js'
import {
  conditionsOf,
  P2_MESSAGE,
  parseRuleYaml,
  RuleValidationError,
  type ValidateOptions,
  validateRule,
} from './validate.js'

const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rules', 'starter')

const PRD_EXAMPLE = `
id: refund-triage
enabled: true
scope:
  account: business
  chat_type: dm
when:
  event: message.received
  from_me: false
  ignore_backfill: true
  any_of:
    - keywords: ["refund", "money back", "chargeback"]
    - understand: { intent: [refund_request, complaint], min_confidence: 0.8 }
  time_window: business_hours
  skip_if_human_replied_within: 2m
never: [send_media, forward_message]
actions:
  - set_label: needs-attention
  - send_message:
      text: "Hi {{contact.display_name}}, sorry about that. I've flagged this and will reply within {{account.sla_reply_minutes}} minutes."
      typing_delay: natural
      rate_limit: { per_chat: "1/10m" }
  - remember_fact: { key: last_refund_request_at, value: "{{event.occurred_at}}", ttl: 90d }
  - notify_operator:
      text: "Refund request from {{contact.display_name}}: {{understand.summary}}"
on_match: stop
policy:
  approval: approve
  max_sends_per_day: 50
`

const targets = TargetsSchema.parse({
  crm: {
    kind: 'http',
    url: 'https://crm.example.com/h',
    auth: { header: 'Authorization', secret_ref: 'CRM_TOKEN' },
  },
  bot: {
    kind: 'mcp',
    url: 'http://127.0.0.1:8732/mcp',
    tools: { place_signal: { side_effecting: true }, get_positions: { side_effecting: false } },
  },
})

const base = { id: 'r', when: { event: 'message.received' }, actions: [{ set_label: 'x' }] }
const rule = (over: Record<string, unknown>) => ({ ...base, ...over })
const when = (over: Record<string, unknown>) => rule({ when: { ...base.when, ...over } })
const issues = (raw: unknown, opts: ValidateOptions = { targets }) =>
  validateRule(raw, opts).issues.map((i) => `${i.path}: ${i.message}`)

describe('rule schema', () => {
  it('accepts the three starter rules and the PRD example', () => {
    const files = readdirSync(STARTER).filter((f) => f.endsWith('.yaml'))
    expect(files).toHaveLength(3)
    for (const f of files) {
      const r = parseRuleYaml(readFileSync(resolve(STARTER, f), 'utf8'))
      expect(r.issues, f).toEqual([])
      expect(r.definition?.id).toBe(f.replace('.yaml', ''))
    }
    const prd = parseRuleYaml(PRD_EXAMPLE)
    expect(prd.definition).toMatchObject({
      id: 'refund-triage',
      priority: 0,
      policy: { approval: 'approve' },
    })
    expect(prd.issues).toEqual([{ path: 'when.any_of.1.understand', message: P2_MESSAGE }])
  })

  it('applies defaults and rejects unknown keys', () => {
    const d = RuleSchema.parse(base)
    expect(d).toMatchObject({
      enabled: false,
      scope: {},
      priority: 0,
      policy: {},
      when: { ignore_backfill: true },
    })
    expect(issues(rule({ bogus: 1 }))).toEqual([": Unrecognized key(s) in object: 'bogus'"])
    expect(issues(when({ event: 'nope' }))[0]).toMatch(/^when\.event: /)
    expect(issues(rule({ id: 'Bad Id' }))).toEqual(['id: rule id: lowercase letters, digits, - and _'])
    expect(issues(when({ any_of: [{}] }))).toEqual(['when.any_of.0: a condition needs at least one key'])
    expect(issues(rule({ scope: { chat_type: 'dm', weird: 1 } }))[0]).toMatch(/^scope: Unrecognized/)
    expect(issues('text')).toEqual([': a rule is a YAML mapping'])
    expect(issues(null)).toEqual([': a rule is a YAML mapping'])
  })

  it('needs a cron for schedule.cron and a duration for schedule.no_reply_within', () => {
    expect(issues(when({ event: 'schedule.cron' }))).toEqual([
      'when.cron: schedule.cron needs a cron expression',
    ])
    expect(issues(when({ event: 'schedule.cron', cron: '0 18 * *' }))).toEqual([
      'when.cron: cron expression with 5 fields',
    ])
    expect(issues(when({ event: 'schedule.cron', cron: '0 18 * * *' }))).toEqual([])
    expect(issues(when({ event: 'schedule.no_reply_within' }))).toEqual([
      'when.no_reply_within: schedule.no_reply_within needs a duration',
    ])
    expect(issues(when({ event: 'schedule.no_reply_within', no_reply_within: '5m' }))).toEqual([])
    expect(issues(when({ skip_if_human_replied_within: '5 minutes' }))).toEqual([
      'when.skip_if_human_replied_within: duration like 30s, 2m, 4h, 90d',
    ])
  })

  it('parses durations and rates', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('2m')).toBe(120_000)
    expect(parseDuration('4h')).toBe(14_400_000)
    expect(parseDuration('90d')).toBe(90 * 86_400_000)
    expect(() => parseDuration('2 min')).toThrow(/invalid duration/)
    expect(parseRate('1/10m')).toEqual({ count: 1, intervalMs: 600_000 })
    expect(parseRate('3/h')).toEqual({ count: 3, intervalMs: 3_600_000 })
    expect(parseRate('1/1d')).toEqual({ count: 1, intervalMs: 86_400_000 })
    expect(() => parseRate('often')).toThrow(/invalid rate/)
  })

  it('classes actions; schedule inherits, remember_fact is side-effecting when message-derived (FR-R10)', () => {
    const cls = (a: unknown) => actionClass(a as RuleAction)
    expect(cls({ set_label: 'x' })).toBe('observe')
    expect(cls({ send_message: { text: 'hi' } })).toBe('counterparty_send')
    expect(cls({ call_tool: { target: 'crm' } })).toBe('side_effecting')
    expect(cls({ notify: { target: 'crm', text: 'x' } })).toBe('side_effecting')
    expect(cls({ schedule: { after: '5m', action: { send_message: { text: 'hi' } } } })).toBe(
      'counterparty_send',
    )
    expect(cls({ remember_fact: { key: 'k', value: '{{event.occurred_at}}' } })).toBe('observe')
    expect(cls({ remember_fact: { key: 'k', value: '{{message.body}}' } })).toBe('side_effecting')
    expect(cls({ remember_fact: { key: 'k', value: '{{contact.display_name}}' } })).toBe('side_effecting')
    expect(cls({ remember_fact: { key: 'k', value: '{{understand.intent}}' } })).toBe('side_effecting')
  })

  it('validates the targets block (PRD §10.6) with defaults', () => {
    expect(targets.crm).toMatchObject({
      kind: 'http',
      timeout_ms: 5000,
      allow_private: false,
      data_policy: { fields: [], pseudonymise_phones: true, honour_llm_optout: true, max_bytes: 16_384 },
    })
    expect(targets.bot).toMatchObject({ kind: 'mcp', tools: { get_positions: { side_effecting: false } } })
    expect(TargetsSchema.safeParse({ x: { kind: 'http', url: 'nope' } }).success).toBe(false)
    expect(
      TargetsSchema.safeParse({
        x: { kind: 'http', url: 'https://a.b', auth: { header: 'A', secret_ref: 'lower' } },
      }).success,
    ).toBe(false)
    expect(TargetsSchema.safeParse({ 'Bad Name': { kind: 'mcp', url: 'https://a.b' } }).success).toBe(false)
  })
})

describe('templates', () => {
  it('knows the namespace', () => {
    expect(isKnownVariable('message.body')).toBe(true)
    expect(isKnownVariable('facts.anything')).toBe(true)
    expect(isKnownVariable('account.custom_setting')).toBe(true)
    expect(isKnownVariable('contact.push_name')).toBe(false)
    expect(isKnownVariable('rule.id')).toBe(false)
    expect(isKnownVariable('message')).toBe(false)
    expect(isKnownVariable('message.')).toBe(false)
    expect(isKnownVariable('.body')).toBe(false)
  })

  it('collects variables, sections and partials; reports parse errors', () => {
    expect(parseTemplate('Hi {{contact.display_name}} {{{message.body}}} {{&chat.name}} {{> p}}')).toEqual({
      variables: ['contact.display_name', 'message.body', 'chat.name'],
      partials: ['p'],
    })
    expect(
      parseTemplate('{{#facts.vip}}VIP {{contact.id}}{{/facts.vip}}{{^chat.name}}x{{/chat.name}}'),
    ).toEqual({
      variables: ['facts.vip', 'contact.id', 'chat.name'],
      partials: [],
    })
    expect(parseTemplate('{{#a}}').error).toMatch(/Unclosed section/)
  })
})

describe('FR-R4 validation', () => {
  it('scope keys against connector capabilities', () => {
    const r = rule({ scope: { group: 'g@g.us', participant_in_group: 'g@g.us', chat_type: 'group' } })
    expect(issues(r, { accountType: 'web' })).toEqual([])
    expect(issues(r, { accountType: null })).toEqual([])
    expect(issues(r, { accountType: 'cloud' })).toEqual([
      'scope.group: not available on cloud accounts',
      'scope.participant_in_group: not available on cloud accounts',
      'scope.chat_type: cloud accounts have no group chats',
    ])
    expect(
      issues(rule({ scope: { chat_type: 'dm', phone_number: '+1' } }), { accountType: 'cloud' }),
    ).toEqual([])
  })

  it('at most 10 actions', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ set_label: `l${i}` }))
    expect(issues(rule({ actions: eleven }))).toEqual(['actions: at most 10 actions, got 11'])
    expect(issues(rule({ actions: eleven.slice(1) }))).toEqual([])
  })

  it('action kinds', () => {
    expect(issues(rule({ actions: [{ send_media: { url: 'x' } }] }))).toEqual([
      'actions.0: unknown action kind "send_media"',
    ])
    expect(issues(rule({ actions: [{ set_label: 'a', mark_read: true }] }))).toEqual([
      'actions.0: an action is a single-key object, e.g. "- set_label: vip"',
    ])
    expect(issues(rule({ actions: ['set_label'] }))).toEqual([
      'actions.0: an action is a single-key object, e.g. "- set_label: vip"',
    ])
    expect(issues(rule({ actions: [{ schedule: { after: '1m', action: { nope: 1 } } }] }))).toEqual([
      'actions.0.schedule.action: unknown action kind "nope"',
    ])
    expect(
      issues(
        rule({ actions: [{ schedule: { after: '1m', action: { schedule: { after: '1m', action: {} } } } }] }),
      ),
    ).toEqual(['actions.0.schedule.action: a schedule cannot schedule another schedule'])
    expect(issues(rule({ actions: [{ schedule: { after: '1m', action: { mark_read: {} } } }] }))).toEqual([])
    expect(
      issues(rule({ actions: [{ escalate: true }, { escalate: { reason: 'x' } }, { mark_read: true }] })),
    ).toEqual([])
  })

  it('regexes compile under RE2 and stay under 512 chars', () => {
    expect(issues(when({ regex: '(' }))).toEqual([
      expect.stringMatching(/^when\.regex: regex does not compile: .*missing closing/),
    ])
    expect(issues(when({ any_of: [{ quoted: { regex: 'a'.repeat(513) } }] }))).toEqual([
      'when.any_of.0.quoted.regex: pattern longer than 512 chars',
    ])
    expect(issues(when({ regex: '(?i)refund|chargeback', all_of: [{ regex: '\\d{3,}' }] }))).toEqual([])
    expect(issues(when({ regex: '(?<=a)b' }))).toEqual([
      expect.stringMatching(/^when\.regex: regex does not compile/),
    ])
  })

  it('templates parse and reference only known variables', () => {
    const send = (text: string) => rule({ actions: [{ send_message: { text } }] })
    expect(issues(send('{{#a}}'))).toEqual([
      expect.stringMatching(/^actions\.0\.send_message\.text: template does not parse: Unclosed section/),
    ])
    expect(issues(send('Hi {{contact.nmae}} {{nope}}'))).toEqual([
      'actions.0.send_message.text: unknown template variable "contact.nmae"',
      'actions.0.send_message.text: unknown template variable "nope"',
    ])
    expect(issues(send('{{> header}}'))).toEqual([
      'actions.0.send_message.text: partial "header" is not allowed',
    ])
    expect(issues(send('{{#facts.vip}}{{contact.display_name}}{{/facts.vip}}'))).toEqual([])
    expect(issues(send('{{contact.phone}}'))).toEqual([
      'actions.0.send_message.text: contact.phone requires policy.expose_phone: true',
    ])
    expect(issues({ ...send('{{contact.phone}}'), policy: { expose_phone: true } })).toEqual([])
    const everywhere = rule({
      when: { ...base.when, sender: 'c1' },
      actions: [
        { notify_operator: { title: '{{bad.title}}', text: '{{bad.text}}' } },
        { notify: { target: 'crm', title: '{{bad.ntitle}}', text: '{{bad.ntext}}' } },
        { remember_fact: { key: 'k', value: '{{bad.fact}}' } },
        { escalate: { reason: '{{bad.reason}}' } },
        {
          call_tool: {
            target: 'bot',
            tool: 'get_positions',
            args: { a: '{{bad.arg}}', list: ['{{bad.item}}', 1] },
          },
        },
        { schedule: { after: '1m', action: { send_message: { text: '{{bad.later}}' } } } },
      ],
    })
    expect(issues(everywhere)).toEqual([
      'actions.0.notify_operator.text: unknown template variable "bad.text"',
      'actions.0.notify_operator.title: unknown template variable "bad.title"',
      'actions.1.notify.text: unknown template variable "bad.ntext"',
      'actions.1.notify.title: unknown template variable "bad.ntitle"',
      'actions.2.remember_fact.value: unknown template variable "bad.fact"',
      'actions.3.escalate.reason: unknown template variable "bad.reason"',
      'actions.4.call_tool.args.a: unknown template variable "bad.arg"',
      'actions.4.call_tool.args.list.0: unknown template variable "bad.item"',
      'actions.5.schedule.action.send_message.text: unknown template variable "bad.later"',
    ])
  })

  it('notify and call_tool targets are registered and tools allowed', () => {
    expect(issues(rule({ actions: [{ notify: { target: 'slack', text: 'x' } }] }))).toEqual([
      'actions.0.notify.target: unknown target "slack"',
    ])
    expect(issues(rule({ actions: [{ notify: { target: '123@g.us', text: 'x' } }] }))).toEqual([])
    expect(issues(rule({ actions: [{ notify: { target: 'crm', text: 'x' } }] }))).toEqual([])
    const call = (call_tool: Record<string, unknown>) =>
      rule({ when: { ...base.when, sender: 'c1' }, actions: [{ call_tool }] })
    expect(issues(call({ target: 'nope', tool: 'x' }))).toEqual([
      'actions.0.call_tool.target: unknown target "nope"',
    ])
    expect(issues(call({ target: 'bot' }))).toEqual(['actions.0.call_tool.tool: mcp targets need a tool'])
    expect(issues(call({ target: 'bot', tool: 'rm_rf' }))).toEqual([
      'actions.0.call_tool.tool: tool "rm_rf" is not allowed on target "bot"',
    ])
    expect(issues(call({ target: 'crm', tool: 'x' }))).toEqual([
      'actions.0.call_tool.tool: http targets take no tool',
    ])
    expect(issues(call({ target: 'crm' }))).toEqual([])
    expect(issues(call({ target: 'bot', tool: 'place_signal' }))).toEqual([])
    expect(
      issues(
        rule({
          when: { ...base.when, sender: 'c1' },
          actions: [{ schedule: { after: '1m', action: { call_tool: { target: 'nope' } } } }],
        }),
      ),
    ).toEqual(['actions.0.schedule.action.call_tool.target: unknown target "nope"'])
    expect(issues(call({ target: 'crm' }), {})).toEqual(['actions.0.call_tool.target: unknown target "crm"'])
  })

  it('call_tool rules need a deterministic sender or allow-list condition', () => {
    const call = (w: Record<string, unknown>, scope: Record<string, unknown> = {}) =>
      rule({ when: { ...base.when, ...w }, scope, actions: [{ call_tool: { target: 'crm' } }] })
    const msg = 'when: call_tool rules need a sender or allow_list condition'
    expect(issues(call({ keywords: ['buy'] }))).toEqual([msg])
    expect(issues(call({ any_of: [{ sender: 'c1' }, { keywords: ['buy'] }] }))).toEqual([msg])
    expect(issues(call({ sender: 'c1' }))).toEqual([])
    expect(issues(call({ allow_list: ['c1', 'c2'] }))).toEqual([])
    expect(issues(call({ all_of: [{ keywords: ['buy'] }, { sender: ['c1'] }] }))).toEqual([])
    expect(issues(call({}, { contact: 'c1' }))).toEqual([])
  })

  it('llm_condition with a sending or side-effecting action requires approve', () => {
    const r = (actions: unknown[], policy: Record<string, unknown> = {}) =>
      rule({ when: { ...base.when, llm_condition: 'is the customer angry?' }, actions, policy })
    expect(issues(r([{ send_message: { text: 'hi' } }]))).toEqual([
      `when.llm_condition: ${P2_MESSAGE}`,
      'policy.approval: llm_condition with a sending or side-effecting action requires approve',
    ])
    expect(issues(r([{ send_message: { text: 'hi' } }], { approval: 'auto' }))).toHaveLength(2)
    expect(issues(r([{ send_message: { text: 'hi' } }], { approval: 'approve' }))).toEqual([
      `when.llm_condition: ${P2_MESSAGE}`,
    ])
    expect(issues(r([{ set_label: 'angry' }]))).toEqual([`when.llm_condition: ${P2_MESSAGE}`])
  })

  it('P2-only conditions are rejected with one message', () => {
    expect(issues(when({ language: 'de' }))).toEqual([`when.language: ${P2_MESSAGE}`])
    expect(issues(when({ any_of: [{ understand: { intent: ['x'] } }] }))).toEqual([
      `when.any_of.0.understand: ${P2_MESSAGE}`,
    ])
    expect(issues(when({ not: [{ llm_condition: 'spam?' }] }))).toEqual([
      `when.not.0.llm_condition: ${P2_MESSAGE}`,
    ])
  })

  it('lists conditions with their paths', () => {
    const def = RuleSchema.parse(
      when({ keywords: ['a'], all_of: [{ sender: 's' }], not: [{ has_media: true }] }),
    )
    expect(conditionsOf(def)).toEqual([
      { path: 'when', condition: { keywords: ['a'] } },
      { path: 'when.all_of.0', condition: { sender: 's' } },
      { path: 'when.not.0', condition: { has_media: true } },
    ])
  })

  it('reports YAML parse errors and formats validation errors', () => {
    expect(parseRuleYaml('a: b: c').issues).toEqual([
      { path: '', message: expect.stringMatching(/^YAML does not parse/) },
    ])
    expect(parseRuleYaml(YAML.stringify(base)).issues).toEqual([])
    const e = new RuleValidationError(
      [
        { path: 'id', message: 'bad' },
        { path: '', message: 'worse' },
      ],
      'x.yaml',
    )
    expect(e.message).toBe('x.yaml: invalid rule: id: bad; worse')
    expect(new RuleValidationError([{ path: 'id', message: 'bad' }]).message).toBe('invalid rule: id: bad')
    expect(e.name).toBe('RuleValidationError')
  })
})
