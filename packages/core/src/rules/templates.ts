import Mustache from 'mustache'
import type { AccountConfig } from '../config/schema.js'
import { MESSAGE_TYPES, type MessagePayload, type StoredEvent } from '../events/types.js'
import { inBusinessHours, wallClock } from '../gate/hours.js'

/**
 * Template variable namespace (PRD §7.5, published in docs/templates.md). A namespace mapped to '*'
 * accepts any field under it; otherwise only the listed fields exist. Unknown variables fail
 * validation (FR-R4); they never render empty.
 */
export const TEMPLATE_VARIABLES: Readonly<Record<string, readonly string[] | '*'>> = {
  event: [
    'id',
    'type',
    'chat_id',
    'sender_id',
    'occurred_at',
    'received_at',
    'is_backfill',
    'is_from_me',
    'origin',
  ],
  message: ['id', 'provider_id', 'body', 'type', 'media_mime', 'quoted_body', 'is_from_me', 'occurred_at'],
  /** `contact.phone` additionally requires `policy.expose_phone: true` on the rule. */
  contact: ['id', 'display_name', 'phone'],
  chat: ['id', 'name', 'type', 'automation_state', 'unread_count'],
  group: ['id', 'name', 'description', 'participant_count'],
  understand: '*',
  facts: '*',
  /** name, timezone, persona, sla_reply_minutes plus any custom setting. */
  account: '*',
  now: ['iso', 'date', 'time', 'weekday', 'hour', 'business_hours'],
}

export function isKnownVariable(name: string): boolean {
  const dot = name.indexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  const fields = TEMPLATE_VARIABLES[name.slice(0, dot)]
  if (fields === undefined) return false
  return fields === '*' || fields.includes(name.slice(dot + 1))
}

export interface ParsedTemplate {
  /** Every variable and section name referenced, in order of appearance. */
  variables: string[]
  /** Partials (`{{> x}}`) are never allowed: they load other templates. */
  partials: string[]
  error?: string
}

type Span = [string, string, number, number, Span[]?]

function walk(spans: Span[], out: ParsedTemplate) {
  for (const s of spans) {
    const [type, name, , , children] = s
    if (type === 'name' || type === '&' || type === '#' || type === '^') out.variables.push(name)
    else if (type === '>') out.partials.push(name)
    if (Array.isArray(children)) walk(children, out)
  }
}

/** Parses a Mustache template without rendering it. */
export function parseTemplate(text: string): ParsedTemplate {
  const out: ParsedTemplate = { variables: [], partials: [] }
  try {
    walk(Mustache.parse(text) as Span[], out)
  } catch (e) {
    out.error = (e as Error).message
  }
  return out
}

/** Variables referenced by a template; empty when it does not parse. */
export function templateVariables(text: string): string[] {
  return parseTemplate(text).variables
}

/** Destination channel of a rendered template (FR-R3). */
export type TemplateChannel = 'whatsapp' | 'markdown' | 'json'
export const MAX_RENDERED_LENGTH = 4096
export const MAX_NAME_LENGTH = 64
/** Fields that are capped at MAX_NAME_LENGTH before rendering. */
const NAME_FIELDS: ReadonlyArray<[string, string]> = [
  ['contact', 'display_name'],
  ['chat', 'name'],
  ['group', 'name'],
  ['account', 'name'],
]

const ESCAPE: Record<TemplateChannel, (s: string) => string> = {
  whatsapp: (s) => s,
  // Every Markdown punctuation character, so a value can never open formatting, a link or a heading.
  markdown: (s) => s.replace(/[\\`*_{}[\]()#+\-.!|>~=]/g, '\\$&'),
  json: (s) => JSON.stringify(s).slice(1, -1),
}

export type TemplateVars = Record<string, Record<string, unknown>>

/**
 * Logic-less Mustache render (T30) with HTML escaping off and the channel's escaping in its place.
 * Unescaped tags (`{{{x}}}`, `{{&x}}`) are rewritten to escaped ones so no value bypasses the channel
 * escaping; name fields are capped at 64 chars and the output at 4 096 (FR-R3).
 */
export function renderTemplate(template: string, vars: TemplateVars, channel: TemplateChannel): string {
  // Linear rewrites (no backtracking regex on template text): `{{{x}}}` -> `{{x}}`, `{{&x}}` -> `{{x}}`.
  const safe = template
    .replaceAll('{{{', '{{')
    .replaceAll('}}}', '}}')
    .split('{{')
    .map((chunk, i) => (i === 0 ? chunk : chunk.replace(/^\s*&/, '')))
    .join('{{')
  const view: TemplateVars = { ...vars }
  for (const [ns, field] of NAME_FIELDS) {
    const v = view[ns]?.[field]
    if (typeof v === 'string' && v.length > MAX_NAME_LENGTH)
      view[ns] = { ...view[ns], [field]: v.slice(0, MAX_NAME_LENGTH) }
  }
  const escapeValue = (value: unknown) =>
    ESCAPE[channel](value === null || value === undefined ? '' : String(value))
  const out = Mustache.render(safe, view, undefined, { escape: escapeValue })
  return out.length > MAX_RENDERED_LENGTH ? out.slice(0, MAX_RENDERED_LENGTH) : out
}

export interface TemplateInput {
  event: StoredEvent
  /** The quoted message, when the event quotes one. */
  quoted: { body: string | null } | null
  contact: { id: string; displayName: string | null; pushName: string | null } | null
  /** Decrypted phone, only when the rule sets `policy.expose_phone: true`. */
  contactPhone: string | null
  chat: {
    id: string
    name: string | null
    type: string
    automationState: string
    unreadCount: number
  } | null
  account: AccountConfig
  facts: Record<string, string>
  now: Date
}

/** The template variable object, exactly the namespace in docs/templates.md. */
export function templateVars(i: TemplateInput): TemplateVars {
  const e = i.event
  const p = e.payload as MessagePayload
  const isMessage = MESSAGE_TYPES.has(e.type)
  const wall = wallClock(i.now, i.account.timezone)
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: i.account.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(i.now)
  const part = (t: string) => local.find((x) => x.type === t)?.value ?? ''
  const group = i.chat?.type === 'group' ? i.chat : null
  return {
    event: {
      id: e.id,
      type: e.type,
      chat_id: e.chatId,
      sender_id: e.senderId,
      occurred_at: e.occurredAt.toISOString(),
      received_at: e.receivedAt.toISOString(),
      is_backfill: e.isBackfill,
      is_from_me: e.isFromMe,
      origin: e.origin,
    },
    message: isMessage
      ? {
          id: e.id,
          provider_id: e.providerId,
          body: p.body ?? p.caption ?? '',
          type: p.kind ?? 'unknown',
          media_mime: p.mimeType ?? null,
          quoted_body: i.quoted?.body ?? null,
          is_from_me: e.isFromMe,
          occurred_at: e.occurredAt.toISOString(),
        }
      : {},
    contact: i.contact
      ? {
          id: i.contact.id,
          display_name: i.contact.displayName ?? i.contact.pushName ?? '',
          phone: i.contactPhone,
        }
      : {},
    chat: i.chat
      ? {
          id: i.chat.id,
          name: i.chat.name ?? '',
          type: i.chat.type,
          automation_state: i.chat.automationState,
          unread_count: i.chat.unreadCount,
        }
      : {},
    // shortcut: group description and participant count are not stored yet; add when the group store lands
    group: group ? { id: group.id, name: group.name ?? '', description: null, participant_count: null } : {},
    understand: {},
    facts: i.facts,
    account: { name: i.account.display_name, timezone: i.account.timezone, persona: i.account.persona },
    now: {
      iso: i.now.toISOString(),
      date: `${part('year')}-${part('month')}-${part('day')}`,
      time: `${part('hour')}:${part('minute')}`,
      weekday: WEEKDAYS[wall.weekday - 1] ?? 'Mon',
      hour: Math.floor(wall.minutes / 60),
      business_hours: inBusinessHours(i.now, i.account.timezone, i.account.business_hours),
    },
  }
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
