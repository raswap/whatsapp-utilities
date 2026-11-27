import Mustache from 'mustache'

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
