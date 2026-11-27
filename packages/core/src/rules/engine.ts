import { createHash } from 'node:crypto'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { RE2JS } from 're2js'
import type { AccountConfig } from '../config/schema.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import type { MessagePayload, StoredEvent } from '../events/types.js'
import type { ActionKind, ApprovalMode, PlannedAction } from '../gate/types.js'
import type { IdentityStore } from '../store/identities.js'
import type { ChatRow, MessageStore } from '../store/messages.js'
import {
  type CompiledRegexes,
  type ConditionResult,
  type EvalContext,
  evaluateCondition,
} from './conditions.js'
import { deniedKinds as denyUnion, type MatchContext, matchesScope, sortRules, specificity } from './match.js'
import {
  actionClass,
  actionKind,
  type BaseAction,
  CONDITION_KEYS,
  type Condition,
  MESSAGE_DERIVED_VARIABLE,
  parseDuration,
  parseRate,
  type RuleActionKind,
  type RuleDefinition,
} from './schema.js'
import {
  renderTemplate,
  type TemplateChannel,
  type TemplateVars,
  templateVariables,
  templateVars,
} from './templates.js'
import { conditionsOf, hasRiskyAction, templatesOf } from './validate.js'

/** A validated rule with its regexes compiled and template taint computed once at load (design §4). */
export interface CompiledRule {
  id: string
  definition: RuleDefinition
  /** Null for a global rule from the operator store. */
  account: string | null
  specificity: number
  priority: number
  regexes: CompiledRegexes
  /** Per action: whether any of its templates uses a message-derived variable (FR-R10, PRD §7.6). */
  tainted: boolean[]
}

export function compileRule(rule: { definition: RuleDefinition; account: string | null }): CompiledRule {
  const def = rule.definition
  const regexes = new Map<string, RE2JS>()
  for (const { condition } of conditionsOf(def))
    for (const pattern of [condition.regex, condition.quoted?.regex])
      if (pattern !== undefined && !regexes.has(pattern)) regexes.set(pattern, RE2JS.compile(pattern))
  return {
    id: def.id,
    definition: def,
    account: rule.account,
    specificity: specificity(def.scope),
    priority: def.priority,
    regexes,
    tainted: def.actions.map((a) =>
      templatesOf(a, '').some((t) => templateVariables(t.text).some((v) => MESSAGE_DERIVED_VARIABLE.test(v))),
    ),
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 1: plan (pure)

export interface PlanState extends MatchContext {
  chat: ChatRow | null
  /** PRD §7.6 check 0: inbound from a blocked contact is dropped before rules. */
  senderBlocked: boolean
  accountPaused: boolean
  throttled: boolean
  globalKill: boolean
}

export interface Plan {
  /** Scope-matched rules in evaluation order. */
  candidates: CompiledRule[]
  /** Rules not evaluated, with why (scope mismatch, blocked sender). */
  skipped: Array<{ ruleId: string; reason: string }>
  deniedKinds: string[]
  /** Set when sends are suppressed; `observe` actions still run. */
  suppressed: string | null
  /** Set when nothing is evaluated at all. */
  dropped: string | null
}

export function plan(e: StoredEvent, rules: readonly CompiledRule[], s: PlanState): Plan {
  if (s.senderBlocked) {
    return {
      candidates: [],
      skipped: rules.map((r) => ({ ruleId: r.id, reason: 'sender_blocked' })),
      deniedKinds: [],
      suppressed: null,
      dropped: 'sender_blocked',
    }
  }
  const matched: CompiledRule[] = []
  const skipped: Plan['skipped'] = []
  for (const r of rules) {
    if (matchesScope(r.definition.scope, e, s)) matched.push(r)
    else skipped.push({ ruleId: r.id, reason: 'scope' })
  }
  const chatState = s.chat?.automationState ?? 'active'
  const pausedUntil = s.chat?.pausedUntil ?? null
  const chatPaused =
    chatState === 'escalated' || (chatState === 'paused' && (pausedUntil === null || pausedUntil > s.now))
  const suppressed = s.globalKill
    ? 'global kill switch is on'
    : s.accountPaused
      ? 'account is paused'
      : s.throttled
        ? 'account is throttled'
        : chatPaused
          ? `chat automation is ${chatState}`
          : null
  return {
    candidates: sortRules(matched),
    skipped,
    deniedKinds: denyUnion(matched),
    suppressed,
    dropped: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 2: fetch (read-only)

export interface FetchDeps {
  db: Db
  tables: AccountTables
  account: AccountConfig
  messages: MessageStore
  identities: IdentityStore
}

/** Rule counters live in `counters` with this window start; the period is part of the key. */
export const RULE_COUNTER_WINDOW = new Date(0)

export interface RateKey {
  key: string
  limit: number
}

/** Fixed-window keys for a send action's `rate_limit` (PRD §7.5), one per dimension. */
export function rateKeys(rule: CompiledRule, index: number, e: StoredEvent, now: Date): RateKey[] {
  const action = rule.definition.actions[index]
  const inner = action && 'schedule' in action ? action.schedule.action : action
  if (!inner || !('send_message' in inner) || !inner.send_message.rate_limit) return []
  const rl = inner.send_message.rate_limit
  const out: RateKey[] = []
  const add = (dim: string, subject: string | null, rate: string | undefined) => {
    if (rate === undefined || subject === null) return
    const { count, intervalMs } = parseRate(rate)
    const period = Math.floor(now.getTime() / intervalMs)
    out.push({ key: `rule:${rule.id}:rate:${index}:${dim}:${subject}:${period}`, limit: count })
  }
  // shortcut: windows are fixed and UTC-aligned and counted when the action is planned; move to the gate limiter for send-time accounting
  add('chat', e.chatId, rl.per_chat)
  add('contact', e.senderId, rl.per_contact)
  add('rule', '-', rl.per_rule)
  return out
}

/** Every counter key the candidate rules may read. */
export function counterKeys(rules: readonly CompiledRule[], e: StoredEvent, now: Date): string[] {
  const keys = new Set<string>()
  for (const r of rules) {
    keys.add(`rule:${r.id}:matches`)
    for (const { condition } of conditionsOf(r.definition))
      if (condition.counter) keys.add(`rule:${r.id}:${condition.counter.name}`)
    r.definition.actions.forEach((_, i) => {
      for (const k of rateKeys(r, i, e, now)) keys.add(k.key)
    })
  }
  return [...keys]
}

/** Deterministic RNG (mulberry32) seeded from a string. */
export function seededRng(seed: string): () => number {
  let h = 2166136261
  for (const ch of seed) {
    h ^= ch.codePointAt(0) as number
    h = Math.imul(h, 16777619)
  }
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const needsMe = (r: CompiledRule) =>
  conditionsOf(r.definition).some((c) => c.condition.mentions_me !== undefined)

export async function fetch(e: StoredEvent, planned: Plan, s: PlanState, d: FetchDeps): Promise<EvalContext> {
  const rules = planned.candidates
  const p = e.payload as MessagePayload
  const contact = e.senderId ? ((await d.identities.contactsByIds([e.senderId]))[0] ?? null) : null
  const lastHumanReplyAt = e.chatId ? await d.messages.lastHumanReplyAt(e.chatId) : null
  const quoted =
    e.chatId && p.quotedProviderId ? await d.messages.getByProviderId(e.chatId, p.quotedProviderId) : null
  const contactPhone =
    e.senderId && rules.some((r) => r.definition.policy.expose_phone)
      ? await d.identities.phoneOf(e.senderId)
      : null
  let me: string[] = []
  if (rules.some(needsMe)) {
    // shortcut: our own identity is whoever sent our from-me messages; take it from the connector when it exposes the self JID
    const [own] = await d.db
      .select({ id: d.tables.messages.senderId })
      .from(d.tables.messages)
      .where(and(eq(d.tables.messages.isFromMe, true), sql`${d.tables.messages.senderId} is not null`))
      .orderBy(sql`${d.tables.messages.occurredAt} desc`)
      .limit(1)
    if (own?.id) me = [own.id, ...(await d.identities.jidsFor(own.id))]
  }
  const keys = counterKeys(rules, e, s.now)
  const counters: Record<string, number> = {}
  if (keys.length) {
    const rows = await d.db
      .select({ key: d.tables.counters.key, value: d.tables.counters.value })
      .from(d.tables.counters)
      .where(
        and(eq(d.tables.counters.windowStart, RULE_COUNTER_WINDOW), inArray(d.tables.counters.key, keys)),
      )
    for (const r of rows) counters[r.key] = r.value
  }
  const subjects = []
  if (e.chatId)
    subjects.push(and(eq(d.tables.facts.subjectType, 'chat'), eq(d.tables.facts.subjectId, e.chatId)))
  if (e.senderId)
    subjects.push(and(eq(d.tables.facts.subjectType, 'contact'), eq(d.tables.facts.subjectId, e.senderId)))
  const facts: Record<string, string> = {}
  if (subjects.length) {
    const rows = await d.db
      .select({ key: d.tables.facts.key, value: d.tables.facts.value })
      .from(d.tables.facts)
      .where(
        and(
          or(...subjects),
          or(sql`${d.tables.facts.expiresAt} is null`, sql`${d.tables.facts.expiresAt} > ${s.now}`),
        ),
      )
      // 'chat' sorts before 'contact', so contact facts overwrite chat facts on a clash.
      .orderBy(d.tables.facts.subjectType)
    for (const r of rows) facts[r.key] = r.value
  }
  return {
    now: s.now,
    zone: s.zone,
    businessHours: s.businessHours,
    account: d.account,
    chat: s.chat,
    contact,
    labels: [...s.labels],
    senderIds: [...s.senderIds],
    me,
    quoted,
    contactPhone,
    lastHumanReplyAt,
    counters,
    facts,
    deniedKinds: planned.deniedKinds,
    suppressed: planned.suppressed,
    rng: seededRng(e.id),
    llm: {},
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 3: evaluate (pure)

export type Outcome = 'matched' | 'not_matched' | 'blocked' | 'suppressed_by_state' | 'error'

export type ActionStatus =
  | 'planned'
  | 'denied'
  | 'suppressed_by_state'
  | 'backfill'
  | 'rate_limited'
  | 'destination_not_allowed'
  | 'unsupported'

export interface ActionTrace {
  index: number
  kind: RuleActionKind
  status: ActionStatus
  reason?: string
}

export interface RuleTrace {
  ruleId: string
  outcome: Outcome
  reason?: string
  specificity: number
  conditions: ConditionResult[]
  actions: ActionTrace[]
}

export interface RememberFactEffect {
  kind: 'remember_fact'
  ruleId: string
  index: number
  subjectType: 'chat' | 'contact'
  subjectId: string
  key: string
  value: string
  expiresAt: Date | null
}

export interface ScheduleEffect {
  kind: 'schedule'
  ruleId: string
  index: number
  runAt: Date
  chatId: string | null
  eventId: string
  bodyHash: string | null
  /** What to run when due: an executor action or a fact write. */
  payload: { planned: PlannedAction } | { effect: RememberFactEffect }
}

export type RuleEffect = RememberFactEffect | ScheduleEffect

export interface Delta {
  counter: string
  by: number
}

export interface Evaluation {
  traces: RuleTrace[]
  actions: PlannedAction[]
  effects: RuleEffect[]
  deltas: Delta[]
}

const QUIET_OVERRIDE_SCOPES = ['contact', 'chat', 'participant_in_group', 'thread'] as const

/** Deterministic: the same event, rules and context give the same Evaluation (G5). */
export function evaluate(e: StoredEvent, rules: readonly CompiledRule[], ctx: EvalContext): Evaluation {
  const out: Evaluation = { traces: [], actions: [], effects: [], deltas: [] }
  let stoppedBy: string | null = null
  for (const rule of rules) {
    const base = { ruleId: rule.id, specificity: rule.specificity }
    if (stoppedBy !== null) {
      out.traces.push({
        ...base,
        outcome: 'not_matched',
        reason: `stopped by ${stoppedBy}`,
        conditions: [],
        actions: [],
      })
      continue
    }
    try {
      const r = evaluateRule(e, rule, ctx)
      out.traces.push(r.trace)
      out.actions.push(...r.actions)
      out.effects.push(...r.effects)
      out.deltas.push(...r.deltas)
      if (r.matched && onMatch(rule.definition) === 'stop') stoppedBy = rule.id
    } catch (err) {
      out.traces.push({
        ...base,
        outcome: 'error',
        reason: (err as Error).message,
        conditions: [],
        actions: [],
      })
    }
  }
  return out
}

/** Default `stop` when the rule has a counterparty_send action, else `continue` (PRD §7.5). */
export function onMatch(def: RuleDefinition): 'stop' | 'continue' {
  if (def.on_match) return def.on_match
  return def.actions.some((a) => actionClass(a) === 'counterparty_send') ? 'stop' : 'continue'
}

interface RuleResult {
  trace: RuleTrace
  matched: boolean
  actions: PlannedAction[]
  effects: RuleEffect[]
  deltas: Delta[]
}

function evaluateRule(e: StoredEvent, rule: CompiledRule, ctx: EvalContext): RuleResult {
  const def = rule.definition
  const base = { ruleId: rule.id, specificity: rule.specificity }
  const miss = (reason: string, conditions: ConditionResult[] = []): RuleResult => ({
    trace: { ...base, outcome: 'not_matched', reason, conditions, actions: [] },
    matched: false,
    actions: [],
    effects: [],
    deltas: [],
  })
  if (def.when.event !== e.type) return miss('trigger')
  if (def.when.from_me !== undefined && def.when.from_me !== e.isFromMe) return miss('from_me')
  if (def.when.ignore_backfill && e.isBackfill) return miss('backfill')

  const conditions: ConditionResult[] = []
  const deps = { ruleId: rule.id, regexes: rule.regexes }
  const run = (c: Condition, prefix: string) => {
    const rs = evaluateCondition(c, e, ctx, deps)
    for (const r of rs) conditions.push({ ...r, name: prefix + r.name })
    return rs.every((r) => r.passed)
  }
  const top: Record<string, unknown> = {}
  for (const k of CONDITION_KEYS) if (def.when[k] !== undefined) top[k] = def.when[k]
  if (!run(top as Condition, '')) return miss('conditions', conditions)
  for (const [i, c] of (def.when.all_of ?? []).entries())
    if (!run(c, `all_of.${i}.`)) return miss('conditions', conditions)
  for (const [i, c] of (def.when.not ?? []).entries())
    if (run(c, `not.${i}.`)) return miss('conditions', conditions)
  if (def.when.any_of && !def.when.any_of.some((c, i) => run(c, `any_of.${i}.`)))
    return miss('conditions', conditions)

  const vars = templateVars({
    event: e,
    quoted: ctx.quoted,
    contact: ctx.contact,
    contactPhone: def.policy.expose_phone ? ctx.contactPhone : null,
    chat: ctx.chat,
    account: ctx.account,
    facts: ctx.facts,
    now: ctx.now,
  })
  const actions: PlannedAction[] = []
  const effects: RuleEffect[] = []
  const deltas: Delta[] = [{ counter: `rule:${rule.id}:matches`, by: 1 }]
  const traces: ActionTrace[] = []
  for (const [i, action] of def.actions.entries()) {
    const kind = actionKind(action)
    const cls = actionClass(action)
    const inner: BaseAction = 'schedule' in action ? action.schedule.action : action
    const innerKind = actionKind(inner)
    const t = (status: ActionStatus, reason?: string) =>
      traces.push({ index: i, kind, status, ...(reason !== undefined ? { reason } : {}) })
    if (ctx.deniedKinds.includes(innerKind)) {
      t('denied', `${innerKind} denied by a scope-matched rule`)
      continue
    }
    if (ctx.suppressed !== null && cls !== 'observe') {
      t('suppressed_by_state', ctx.suppressed)
      continue
    }
    if (e.isBackfill && cls === 'counterparty_send' && !def.when.allow_backfill_sends) {
      t('backfill', 'sends are off for backfill events')
      continue
    }
    if (innerKind === 'notify' || innerKind === 'call_tool') {
      // shortcut: external targets are the bridge in PR 5; until then these actions are traced and skipped
      t('unsupported', `${innerKind} needs the target bridge`)
      continue
    }
    const limits = rateKeys(rule, i, e, ctx.now)
    const exhausted = limits.find((k) => (ctx.counters[k.key] ?? 0) >= k.limit)
    if (exhausted) {
      t('rate_limited', exhausted.key.split(':')[4])
      continue
    }
    if (
      'send_message' in inner &&
      inner.send_message.to !== undefined &&
      inner.send_message.to !== e.chatId
    ) {
      const { to, destinations } = inner.send_message
      const taintedOffChat = rule.tainted[i] === true
      if ((taintedOffChat || destinations !== undefined) && !(destinations ?? []).includes(to)) {
        t('destination_not_allowed', `${to} is not on destinations`)
        continue
      }
    }
    const built = buildAction(inner, i, e, rule, ctx, vars)
    if ('schedule' in action) {
      const ms = parseDuration(action.schedule.after)
      effects.push({
        kind: 'schedule',
        ruleId: rule.id,
        index: i,
        runAt: new Date(ctx.now.getTime() + ms),
        chatId: e.chatId,
        eventId: e.id,
        bodyHash: bodyHashOf(e),
        payload: built.kind === 'remember_fact' ? { effect: built } : { planned: built },
      })
    } else if (built.kind === 'remember_fact') effects.push(built)
    else actions.push(built)
    for (const k of limits) deltas.push({ counter: k.key, by: 1 })
    t('planned')
  }
  const planned = traces.filter((a) => a.status === 'planned').length
  const outcome: Outcome =
    planned > 0
      ? 'matched'
      : traces.some((a) => a.status === 'suppressed_by_state')
        ? 'suppressed_by_state'
        : traces.length > 0 && traces.every((a) => a.status === 'denied')
          ? 'blocked'
          : 'matched'
  return {
    trace: { ...base, outcome, conditions, actions: traces },
    matched: true,
    actions,
    effects,
    deltas,
  }
}

function bodyHashOf(e: StoredEvent): string | null {
  const p = e.payload as MessagePayload
  const body = p.body ?? p.caption
  return body ? createHash('sha256').update(body).digest('hex') : null
}

/** Maps one rule action onto the executor's PlannedAction, or a fact write for `remember_fact`. */
function buildAction(
  a: BaseAction,
  index: number,
  e: StoredEvent,
  rule: CompiledRule,
  ctx: EvalContext,
  vars: TemplateVars,
): PlannedAction | RememberFactEffect {
  const def = rule.definition
  const render = (text: string, channel: TemplateChannel) => renderTemplate(text, vars, channel)
  if ('remember_fact' in a) {
    const f = a.remember_fact
    const subjectType = f.subject ?? (e.senderId ? 'contact' : 'chat')
    const subjectId = subjectType === 'contact' ? e.senderId : e.chatId
    if (!subjectId) throw new Error(`remember_fact: event has no ${subjectType} subject`)
    return {
      kind: 'remember_fact',
      ruleId: rule.id,
      index,
      subjectType,
      subjectId,
      key: f.key,
      value: render(f.value, 'whatsapp'),
      expiresAt: f.ttl ? new Date(ctx.now.getTime() + parseDuration(f.ttl)) : null,
    }
  }
  const kind = actionKind(a) as ActionKind
  let approval: ApprovalMode = def.policy.approval ?? (hasRiskyAction(def) ? 'approve' : 'auto')
  let chatId = e.chatId
  let recipientContactId = e.senderId
  let text: string | undefined
  let payload: Record<string, unknown> = {}
  if ('send_message' in a) {
    const s = a.send_message
    text = render(s.text, 'whatsapp')
    payload = {
      text,
      ...(s.typing_delay ? { typing_delay: s.typing_delay } : {}),
      ...(s.reply && e.providerId ? { quotedProviderId: e.providerId } : {}),
    }
    if (s.to !== undefined && s.to !== e.chatId) {
      chatId = s.to
      recipientContactId = null
      // PRD §7.6 additional rule: message-derived text to someone other than the inbound sender needs approval.
      if (rule.tainted[index]) approval = 'approve'
    }
  } else if ('react_to_message' in a) payload = { providerId: e.providerId, emoji: a.react_to_message.emoji }
  else if ('mark_read' in a) payload = { providerIds: e.providerId ? [e.providerId] : [] }
  else if ('set_label' in a) payload = { label: a.set_label }
  else if ('remove_label' in a) payload = { label: a.remove_label }
  else if ('escalate' in a) {
    text =
      a.escalate !== true && a.escalate.reason !== undefined
        ? render(a.escalate.reason, 'markdown')
        : undefined
    payload = { reason: text ?? 'escalated by rule' }
  } else if ('notify_operator' in a) {
    text = render(a.notify_operator.text, 'markdown')
    payload = {
      title:
        a.notify_operator.title !== undefined
          ? render(a.notify_operator.title, 'markdown')
          : `Rule ${rule.id}`,
      level: 'info',
    }
  } else if ('set_chat_automation' in a) {
    const s = a.set_chat_automation
    payload = {
      state: s.state,
      pausedUntil: s.duration ? new Date(ctx.now.getTime() + parseDuration(s.duration)).toISOString() : null,
    }
  }
  const bodyHash = bodyHashOf(e)
  const allowQuietOverride = QUIET_OVERRIDE_SCOPES.some((k) => def.scope[k] !== undefined)
  return {
    kind,
    source: `rule:${rule.id}`,
    actor: `rule:${rule.id}`,
    idempotencyKey: `rule:${rule.id}:${e.id}:${index}`,
    ...(chatId ? { chatId } : {}),
    ...(recipientContactId ? { recipientContactId } : {}),
    payload,
    ruleId: rule.id,
    eventId: e.id,
    inboundOrigin: e.origin,
    ...(bodyHash ? { bodyHash } : {}),
    approval,
    ...(def.policy.quiet_hours_override ? { overrideQuietHours: true } : {}),
    allowQuietOverride,
    deniedKinds: ctx.deniedKinds,
    ...(text !== undefined ? { text } : {}),
  }
}

export type { ConditionResult, EvalContext } from './conditions.js'
