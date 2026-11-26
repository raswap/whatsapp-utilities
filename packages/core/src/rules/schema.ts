import { z } from 'zod'
import { EVENT_TYPES } from '../events/types.js'
import { ACTION_CLASS, type ActionClass } from '../gate/types.js'
import { templateVariables } from './templates.js'

/** Rule YAML shape (PRD §7.5) and the `targets:` block (PRD §10.6). The YAML text is the stored source of truth; this is what it parses to. */

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
type Unit = keyof typeof UNIT_MS

export const DURATION_RE = /^(\d+)(s|m|h|d)$/
/** "30s", "2m", "4h", "90d" to milliseconds. */
export function parseDuration(text: string): number {
  const m = DURATION_RE.exec(text)
  if (!m) throw new Error(`invalid duration "${text}": use e.g. 30s, 2m, 4h, 90d`)
  return Number(m[1]) * UNIT_MS[m[2] as Unit]
}

export const RATE_RE = /^(\d+)\/(\d*)(s|m|h|d)$/
/** "1/10m" (one per ten minutes) or "3/h" (three per hour) to a count and an interval in milliseconds. */
export function parseRate(text: string): { count: number; intervalMs: number } {
  const m = RATE_RE.exec(text)
  if (!m) throw new Error(`invalid rate "${text}": use e.g. 1/10m or 3/h`)
  return { count: Number(m[1]), intervalMs: Number(m[2] || 1) * UNIT_MS[m[3] as Unit] }
}

const Duration = z.string().regex(DURATION_RE, 'duration like 30s, 2m, 4h, 90d')
const Rate = z.string().regex(RATE_RE, 'rate like 1/10m or 3/h')
const NonEmpty = z.string().min(1)
const IdList = z.union([NonEmpty, z.array(NonEmpty).min(1)])
const TimeWindow = z
  .string()
  .regex(/^(business_hours|\d{2}:\d{2}-\d{2}:\d{2})$/, 'business_hours or HH:MM-HH:MM')
/** Rendered output is capped at 4 096 chars (FR-R3); a template longer than that can never render. */
const Template = z.string().max(4096)
// shortcut: 5 whitespace-separated fields only, croner parses the expression in PR 3
const CRON_RE = /^\s*\S+(\s+\S+){4}\s*$/

export const RULE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const CHAT_TYPES = ['dm', 'group', 'community', 'broadcast', 'channel', 'status'] as const
export const MESSAGE_KINDS = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'reaction',
  'system',
  'unknown',
] as const

/** Scope keys, PRD §7.5 levels 2 to 12; level 1 (`global`) is an empty scope. */
export const SCOPE_KEYS = [
  'account',
  'phone_number',
  'chat_type',
  'label',
  'group',
  'chat',
  'contact',
  'participant_in_group',
  'message_type',
  'time_window',
  'thread',
] as const
export type ScopeKey = (typeof SCOPE_KEYS)[number]

export const ScopeSchema = z
  .object({
    account: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,30}$/, 'account id')
      .optional(),
    phone_number: NonEmpty.optional(),
    chat_type: z.enum(CHAT_TYPES).optional(),
    label: NonEmpty.optional(),
    group: NonEmpty.optional(),
    chat: NonEmpty.optional(),
    contact: NonEmpty.optional(),
    participant_in_group: NonEmpty.optional(),
    message_type: z.enum(MESSAGE_KINDS).optional(),
    time_window: TimeWindow.optional(),
    thread: NonEmpty.optional(),
  })
  .strict()

/** Conditions the schema accepts but P1 validation rejects with `needs P2 understanding` (design §1, T31). */
export const P2_CONDITIONS = ['understand', 'llm_condition', 'language'] as const

const conditionShape = {
  sender: IdList.optional(),
  allow_list: z.array(NonEmpty).min(1).optional(),
  deny_list: z.array(NonEmpty).min(1).optional(),
  group: IdList.optional(),
  keywords: z.array(NonEmpty).min(1).optional(),
  regex: NonEmpty.optional(),
  message_type: z.union([z.enum(MESSAGE_KINDS), z.array(z.enum(MESSAGE_KINDS)).min(1)]).optional(),
  has_media: z.boolean().optional(),
  mentions_me: z.boolean().optional(),
  reply_to_me: z.boolean().optional(),
  quoted: z
    .object({
      from_me: z.boolean().optional(),
      keywords: z.array(NonEmpty).min(1).optional(),
      regex: NonEmpty.optional(),
    })
    .strict()
    .optional(),
  facts: z.record(NonEmpty, z.string()).optional(),
  counter: z
    .object({
      name: NonEmpty,
      min: z.number().int().min(0).optional(),
      max: z.number().int().min(0).optional(),
    })
    .strict()
    .optional(),
  sample: z.number().gt(0).lte(1).optional(),
  time_window: TimeWindow.optional(),
  not_time_window: TimeWindow.optional(),
  skip_if_human_replied_within: Duration.optional(),
  language: IdList.optional(),
  understand: z.record(z.string(), z.unknown()).optional(),
  llm_condition: NonEmpty.optional(),
}

export const ConditionSchema = z
  .object(conditionShape)
  .strict()
  .refine((c) => Object.keys(c).length > 0, 'a condition needs at least one key')
export type Condition = z.infer<typeof ConditionSchema>
export const CONDITION_KEYS = Object.keys(conditionShape) as Array<keyof Condition>

export const TRIGGERS = [...EVENT_TYPES, 'schedule.cron', 'schedule.no_reply_within', 'manual'] as const
export type Trigger = (typeof TRIGGERS)[number]

// shortcut: any_of/all_of/not hold flat condition lists, no nesting; add z.lazy when a rule needs it
export const WhenSchema = z
  .object({
    event: z.enum(TRIGGERS),
    from_me: z.boolean().optional(),
    ignore_backfill: z.boolean().default(true),
    allow_backfill_sends: z.boolean().optional(),
    cron: z.string().regex(CRON_RE, 'cron expression with 5 fields').optional(),
    no_reply_within: Duration.optional(),
    any_of: z.array(ConditionSchema).min(1).optional(),
    all_of: z.array(ConditionSchema).min(1).optional(),
    not: z.array(ConditionSchema).min(1).optional(),
    ...conditionShape,
  })
  .strict()
  .superRefine((w, ctx) => {
    if (w.event === 'schedule.cron' && !w.cron)
      ctx.addIssue({ code: 'custom', path: ['cron'], message: 'schedule.cron needs a cron expression' })
    if (w.event === 'schedule.no_reply_within' && !w.no_reply_within)
      ctx.addIssue({
        code: 'custom',
        path: ['no_reply_within'],
        message: 'schedule.no_reply_within needs a duration',
      })
  })
export type When = z.infer<typeof WhenSchema>

const Toggle = z.union([z.literal(true), z.object({}).strict()])
const Notification = z.object({ title: Template.optional(), text: Template.min(1) }).strict()

export const SendMessageSchema = z
  .object({
    text: Template.min(1),
    /** Recipient chat when not the inbound chat; must then be on `destinations` (PRD §7.6). */
    to: NonEmpty.optional(),
    destinations: z.array(NonEmpty).optional(),
    reply: z.boolean().optional(),
    typing_delay: z.enum(['natural', 'none']).optional(),
    rate_limit: z
      .object({ per_chat: Rate.optional(), per_contact: Rate.optional(), per_rule: Rate.optional() })
      .strict()
      .optional(),
  })
  .strict()

export const RememberFactSchema = z
  .object({
    key: z.string().min(1).max(64),
    value: Template,
    ttl: Duration.optional(),
    subject: z.enum(['chat', 'contact']).optional(),
  })
  .strict()

export const CallToolSchema = z
  .object({ target: NonEmpty, tool: NonEmpty.optional(), args: z.record(z.string(), z.unknown()).optional() })
  .strict()

/** Every action is a single-key object; the key is the action kind. */
export const BaseActionSchema = z.union([
  z.object({ send_message: SendMessageSchema }).strict(),
  z.object({ react_to_message: z.object({ emoji: z.string().min(1).max(16) }).strict() }).strict(),
  z.object({ mark_read: Toggle }).strict(),
  z.object({ set_label: z.string().min(1).max(64) }).strict(),
  z.object({ remove_label: z.string().min(1).max(64) }).strict(),
  z
    .object({ escalate: z.union([z.literal(true), z.object({ reason: Template.optional() }).strict()]) })
    .strict(),
  z.object({ notify_operator: Notification }).strict(),
  z
    .object({
      set_chat_automation: z
        .object({ state: z.enum(['paused', 'active']), duration: Duration.optional() })
        .strict(),
    })
    .strict(),
  z.object({ remember_fact: RememberFactSchema }).strict(),
  z.object({ notify: Notification.extend({ target: NonEmpty }) }).strict(),
  z.object({ call_tool: CallToolSchema }).strict(),
])
export type BaseAction = z.infer<typeof BaseActionSchema>

export const ActionSchema = z.union([
  ...BaseActionSchema.options,
  z.object({ schedule: z.object({ after: Duration, action: BaseActionSchema }).strict() }).strict(),
])
export type RuleAction = z.infer<typeof ActionSchema>

export const RULE_ACTION_KINDS = [
  'send_message',
  'react_to_message',
  'mark_read',
  'set_label',
  'remove_label',
  'escalate',
  'notify_operator',
  'set_chat_automation',
  'remember_fact',
  'notify',
  'call_tool',
  'schedule',
] as const
export type RuleActionKind = (typeof RULE_ACTION_KINDS)[number]
export type BaseActionKind = Exclude<RuleActionKind, 'schedule'>

export const RULE_ACTION_CLASS: Record<BaseActionKind, ActionClass> = {
  ...ACTION_CLASS,
  remember_fact: 'observe',
  notify: 'side_effecting',
  call_tool: 'side_effecting',
}

export function actionKind(action: RuleAction): RuleActionKind {
  return Object.keys(action)[0] as RuleActionKind
}

/** Variables that make a remembered fact message- or model-derived (FR-R10). */
const TAINTED_FACT_SOURCES = /^(message\.|understand\.|contact\.display_name$)/

/** Class of one action; `schedule` inherits its inner action's class (PRD §7.3). */
export function actionClass(action: RuleAction): ActionClass {
  if ('schedule' in action) return actionClass(action.schedule.action)
  if ('remember_fact' in action) {
    const tainted = templateVariables(action.remember_fact.value).some((v) => TAINTED_FACT_SOURCES.test(v))
    return tainted ? 'side_effecting' : 'observe'
  }
  return RULE_ACTION_CLASS[actionKind(action) as BaseActionKind]
}

export const APPROVAL_MODES = ['auto', 'approve', 'dry_run'] as const

export const PolicySchema = z
  .object({
    approval: z.enum(APPROVAL_MODES).optional(),
    max_sends_per_day: z.number().int().min(1).optional(),
    max_sends_per_hour: z.number().int().min(1).optional(),
    quiet_hours_override: z.boolean().optional(),
    /** Required to reference `contact.phone` in a template (PRD §7.5). */
    expose_phone: z.boolean().optional(),
  })
  .strict()

export const RuleSchema = z
  .object({
    id: z.string().regex(RULE_ID_RE, 'rule id: lowercase letters, digits, - and _'),
    enabled: z.boolean().default(false),
    description: z.string().max(500).optional(),
    scope: ScopeSchema.default({}),
    when: WhenSchema,
    /** Sugar for `deny`. */
    never: z.array(NonEmpty).optional(),
    deny: z.array(NonEmpty).optional(),
    actions: z.array(ActionSchema).min(1),
    on_match: z.enum(['stop', 'continue']).optional(),
    policy: PolicySchema.default({}),
    priority: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict()
export type RuleDefinition = z.infer<typeof RuleSchema>

/** Registered outbound targets (PRD §10.6). Validated here; the bridge that calls them is PR 5. */
const DataPolicySchema = z
  .object({
    fields: z.array(NonEmpty).default([]),
    pseudonymise_phones: z.boolean().default(true),
    honour_llm_optout: z.boolean().default(true),
    max_bytes: z.number().int().min(256).max(1_048_576).default(16_384),
  })
  .strict()
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'environment variable name')
const targetBase = {
  url: z.string().url(),
  timeout_ms: z.number().int().min(500).max(30_000).default(5000),
  data_policy: DataPolicySchema.default({}),
  /** Lets the target resolve to a private address (T32). */
  allow_private: z.boolean().default(false),
}
export const TargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('http'),
      ...targetBase,
      auth: z.object({ header: NonEmpty, secret_ref: EnvName }).strict().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mcp'),
      ...targetBase,
      token_ref: EnvName.optional(),
      tools: z.record(NonEmpty, z.object({ side_effecting: z.boolean().default(true) }).strict()).default({}),
    })
    .strict(),
])
export const TargetsSchema = z.record(z.string().regex(RULE_ID_RE, 'target name'), TargetSchema)
export type TargetConfig = z.infer<typeof TargetSchema>
export type TargetsConfig = z.infer<typeof TargetsSchema>
