import { RE2JS } from 're2js'
import YAML from 'yaml'
import type { ActionClass } from '../gate/types.js'
import {
  actionClass,
  type BaseAction,
  CONDITION_KEYS,
  type Condition,
  P2_CONDITIONS,
  RULE_ACTION_KINDS,
  type RuleAction,
  type RuleActionKind,
  type RuleDefinition,
  RuleSchema,
  SCOPE_KEYS,
  type ScopeKey,
  type TargetsConfig,
} from './schema.js'
import { isKnownVariable, parseTemplate } from './templates.js'

export interface ValidationIssue {
  /** Dotted path into the YAML document; '' for the document itself. */
  path: string
  message: string
}

export interface ValidateOptions {
  /** Type of the account the rule belongs to; null or undefined for a global rule. */
  accountType?: 'web' | 'cloud' | null
  targets?: TargetsConfig
}

export interface ValidationResult {
  definition: RuleDefinition | null
  issues: ValidationIssue[]
}

export class RuleValidationError extends Error {
  constructor(
    readonly issues: ValidationIssue[],
    readonly file?: string,
  ) {
    super(
      `${file ? `${file}: ` : ''}invalid rule: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`,
    )
    this.name = 'RuleValidationError'
  }
}

export const MAX_ACTIONS = 10
export const MAX_REGEX_LENGTH = 512
export const P2_MESSAGE = 'needs P2 understanding'

const ALL_SCOPE_KEYS: ReadonlySet<ScopeKey> = new Set(SCOPE_KEYS)
/** Scope keys each connector type can match on. Cloud API has no group model. */
export const SCOPE_CAPABILITIES: Record<'web' | 'cloud', ReadonlySet<ScopeKey>> = {
  web: ALL_SCOPE_KEYS,
  cloud: new Set(SCOPE_KEYS.filter((k) => k !== 'group' && k !== 'participant_in_group')),
}

const RISKY: ReadonlySet<ActionClass> = new Set(['counterparty_send', 'side_effecting'])

/** True when the rule has a `counterparty_send` or `side_effecting` action (D4, FR-R8). */
export function hasRiskyAction(def: RuleDefinition): boolean {
  return def.actions.some((a) => RISKY.has(actionClass(a)))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Unknown action kinds get one clear message instead of the schema's union noise. */
function checkActionKinds(raw: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(raw.actions)) return issues
  const check = (item: unknown, path: string) => {
    if (!isRecord(item) || Object.keys(item).length !== 1) {
      issues.push({ path, message: 'an action is a single-key object, e.g. "- set_label: vip"' })
      return
    }
    const kind = Object.keys(item)[0] as string
    if (!RULE_ACTION_KINDS.includes(kind as RuleActionKind)) {
      issues.push({ path, message: `unknown action kind "${kind}"` })
      return
    }
    const inner = (item as { schedule?: { action?: unknown } }).schedule
    if (kind === 'schedule' && isRecord(inner) && 'action' in inner) {
      if (isRecord(inner.action) && 'schedule' in inner.action)
        issues.push({
          path: `${path}.schedule.action`,
          message: 'a schedule cannot schedule another schedule',
        })
      else check(inner.action, `${path}.schedule.action`)
    }
  }
  for (const [i, item] of raw.actions.entries()) check(item, `actions.${i}`)
  return issues
}

/** Every condition in `when`: the top-level keys, then each entry of any_of / all_of / not. */
export function conditionsOf(def: RuleDefinition): Array<{ path: string; condition: Condition }> {
  const top: Record<string, unknown> = {}
  for (const k of CONDITION_KEYS) if (def.when[k] !== undefined) top[k] = def.when[k]
  const out = [{ path: 'when', condition: top as Condition }]
  for (const group of ['any_of', 'all_of', 'not'] as const)
    for (const [i, c] of (def.when[group] ?? []).entries())
      out.push({ path: `when.${group}.${i}`, condition: c })
  return out
}

interface Located {
  path: string
  text: string
}

function stringsIn(v: unknown, path: string, out: Located[]) {
  if (typeof v === 'string') out.push({ path, text: v })
  else if (Array.isArray(v)) for (const [i, x] of v.entries()) stringsIn(x, `${path}.${i}`, out)
  else if (isRecord(v)) for (const [k, x] of Object.entries(v)) stringsIn(x, `${path}.${k}`, out)
}

/** Template strings of one action, by field. */
export function templatesOf(action: RuleAction, path: string): Located[] {
  const out: Located[] = []
  if ('schedule' in action) return templatesOf(action.schedule.action, `${path}.schedule.action`)
  const a = action as BaseAction
  if ('send_message' in a) out.push({ path: `${path}.send_message.text`, text: a.send_message.text })
  if ('notify_operator' in a || 'notify' in a) {
    const kind = 'notify' in a ? 'notify' : 'notify_operator'
    const n = 'notify' in a ? a.notify : a.notify_operator
    out.push({ path: `${path}.${kind}.text`, text: n.text })
    if (n.title !== undefined) out.push({ path: `${path}.${kind}.title`, text: n.title })
  }
  if ('remember_fact' in a) out.push({ path: `${path}.remember_fact.value`, text: a.remember_fact.value })
  if ('escalate' in a && a.escalate !== true && a.escalate.reason !== undefined)
    out.push({ path: `${path}.escalate.reason`, text: a.escalate.reason })
  if ('call_tool' in a) stringsIn(a.call_tool.args, `${path}.call_tool.args`, out)
  return out
}

function regexesOf(def: RuleDefinition): Located[] {
  const out: Located[] = []
  for (const { path, condition } of conditionsOf(def)) {
    if (condition.regex !== undefined) out.push({ path: `${path}.regex`, text: condition.regex })
    if (condition.quoted?.regex !== undefined)
      out.push({ path: `${path}.quoted.regex`, text: condition.quoted.regex })
  }
  return out
}

/** A `call_tool` rule must name who may trigger it: a sender or allow-list condition that always applies. */
function hasDeterministicSender(def: RuleDefinition): boolean {
  if (def.scope.contact !== undefined) return true
  const always = [def.when, ...(def.when.all_of ?? [])]
  return always.some((c) => c.sender !== undefined || c.allow_list !== undefined)
}

/** FR-R4 checks on a parsed YAML document. */
export function validateRule(raw: unknown, opts: ValidateOptions = {}): ValidationResult {
  if (!isRecord(raw)) return { definition: null, issues: [{ path: '', message: 'a rule is a YAML mapping' }] }
  const kindIssues = checkActionKinds(raw)
  if (kindIssues.length > 0) return { definition: null, issues: kindIssues }
  const parsed = RuleSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      definition: null,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  const def = parsed.data
  const issues: ValidationIssue[] = []
  const targets = opts.targets ?? {}

  for (const { path, condition } of conditionsOf(def))
    for (const key of P2_CONDITIONS)
      if (condition[key] !== undefined) issues.push({ path: `${path}.${key}`, message: P2_MESSAGE })

  if (opts.accountType === 'cloud') {
    const allowed = SCOPE_CAPABILITIES.cloud
    for (const key of Object.keys(def.scope) as ScopeKey[])
      if (!allowed.has(key)) issues.push({ path: `scope.${key}`, message: `not available on cloud accounts` })
    if (def.scope.chat_type === 'group')
      issues.push({ path: 'scope.chat_type', message: 'cloud accounts have no group chats' })
  }

  if (def.actions.length > MAX_ACTIONS)
    issues.push({ path: 'actions', message: `at most ${MAX_ACTIONS} actions, got ${def.actions.length}` })

  for (const { path, text } of regexesOf(def)) {
    if (text.length > MAX_REGEX_LENGTH) {
      issues.push({ path, message: `pattern longer than ${MAX_REGEX_LENGTH} chars` })
      continue
    }
    try {
      RE2JS.compile(text)
    } catch (e) {
      issues.push({ path, message: `regex does not compile: ${(e as Error).message}` })
    }
  }

  for (const [i, action] of def.actions.entries()) {
    for (const { path, text } of templatesOf(action, `actions.${i}`)) {
      const t = parseTemplate(text)
      if (t.error) {
        issues.push({ path, message: `template does not parse: ${t.error}` })
        continue
      }
      for (const p of t.partials) issues.push({ path, message: `partial "${p}" is not allowed` })
      for (const v of t.variables) {
        if (!isKnownVariable(v)) issues.push({ path, message: `unknown template variable "${v}"` })
        else if (v === 'contact.phone' && def.policy.expose_phone !== true)
          issues.push({ path, message: 'contact.phone requires policy.expose_phone: true' })
      }
    }
  }

  for (const [i, action] of def.actions.entries()) {
    const inner = 'schedule' in action ? action.schedule.action : action
    const path = 'schedule' in action ? `actions.${i}.schedule.action` : `actions.${i}`
    if ('notify' in inner && !(inner.notify.target in targets) && !inner.notify.target.includes('@'))
      issues.push({ path: `${path}.notify.target`, message: `unknown target "${inner.notify.target}"` })
    if ('call_tool' in inner) {
      const { target, tool } = inner.call_tool
      const t = targets[target]
      if (!t) issues.push({ path: `${path}.call_tool.target`, message: `unknown target "${target}"` })
      else if (t.kind === 'mcp') {
        if (tool === undefined)
          issues.push({ path: `${path}.call_tool.tool`, message: 'mcp targets need a tool' })
        else if (!(tool in t.tools))
          issues.push({
            path: `${path}.call_tool.tool`,
            message: `tool "${tool}" is not allowed on target "${target}"`,
          })
      } else if (tool !== undefined)
        issues.push({ path: `${path}.call_tool.tool`, message: 'http targets take no tool' })
    }
  }

  if (def.actions.some((a) => actionKind(a) === 'call_tool') && !hasDeterministicSender(def))
    issues.push({ path: 'when', message: 'call_tool rules need a sender or allow_list condition' })

  const usesLlm = conditionsOf(def).some((c) => c.condition.llm_condition !== undefined)
  if (usesLlm && hasRiskyAction(def) && def.policy.approval !== 'approve')
    issues.push({
      path: 'policy.approval',
      message: 'llm_condition with a sending or side-effecting action requires approve',
    })

  return { definition: def, issues }
}

function actionKind(a: RuleAction): RuleActionKind {
  if ('schedule' in a) return actionKind(a.schedule.action)
  return Object.keys(a)[0] as RuleActionKind
}

/** Parses YAML text and runs every check. */
export function parseRuleYaml(text: string, opts: ValidateOptions = {}): ValidationResult {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch (e) {
    return {
      definition: null,
      issues: [{ path: '', message: `YAML does not parse: ${(e as Error).message}` }],
    }
  }
  return validateRule(raw, opts)
}
