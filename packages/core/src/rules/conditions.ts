import type { RE2JS } from 're2js'
import type { AccountConfig } from '../config/schema.js'
import type { AccountTables } from '../db/schema/account.js'
import type { MessagePayload, StoredEvent } from '../events/types.js'
import type { BusinessHours } from '../gate/hours.js'
import type { ChatRow, MessageRow } from '../store/messages.js'
import { inTimeWindow } from './match.js'
import { type Condition, type MESSAGE_KINDS, parseDuration } from './schema.js'

type MessageKind = (typeof MESSAGE_KINDS)[number]

export type ContactRow = AccountTables['contacts']['$inferSelect']

/** The snapshot `evaluate` reads (design §4). Everything deterministic; `rng` is seeded with the event id. */
export interface EvalContext {
  now: Date
  zone: string
  businessHours: BusinessHours
  account: AccountConfig
  chat: ChatRow | null
  contact: ContactRow | null
  labels: string[]
  /** The sender's canonical contact id and its JIDs. */
  senderIds: string[]
  /** Our own contact id and JIDs, for `mentions_me`. */
  me: string[]
  /** The message this event quotes, when stored. */
  quoted: MessageRow | null
  /** Decrypted phone of the contact, only when a candidate rule sets `policy.expose_phone`. */
  contactPhone: string | null
  lastHumanReplyAt: Date | null
  /** Keyed `rule:<id>:<name>`. */
  counters: Record<string, number>
  /** Subject = chat or contact; contact facts win on a key clash. */
  facts: Record<string, string>
  /** Union of `never`/`deny` from every scope-matched rule (plan output). */
  deniedKinds: string[]
  /** Set when a kill switch or pause suppresses sends (plan output). */
  suppressed: string | null
  rng: () => number
  llm: Record<string, unknown>
}

export interface ConditionResult {
  name: string
  passed: boolean
  detail?: string
}

/** Regexes compiled once per rule, keyed by pattern. */
export type CompiledRegexes = ReadonlyMap<string, RE2JS>

export const MAX_REGEX_INPUT = 65_536
const MEDIA_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker'])

/** T34: case-insensitive, NFKC-normalised, diacritics stripped, substring. */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function containsKeyword(text: string, keywords: readonly string[]): string | null {
  const hay = normalizeText(text)
  return keywords.find((k) => hay.includes(normalizeText(k))) ?? null
}

export function regexMatches(regexes: CompiledRegexes, pattern: string, text: string): boolean {
  const re = regexes.get(pattern)
  if (!re) throw new Error(`regex not compiled: ${pattern}`)
  // `test` skips capture tracking: an order of magnitude faster than matcher().find() on long inputs.
  return re.test(text.length > MAX_REGEX_INPUT ? text.slice(0, MAX_REGEX_INPUT) : text)
}

function bodyOf(e: StoredEvent): string {
  const p = e.payload as MessagePayload
  return p.body ?? p.caption ?? ''
}

const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v])
const hit = (ids: readonly string[], list: readonly string[]) => list.find((x) => ids.includes(x)) ?? null

/** Cheapest first (PRD §7.5 phase 3); regexes last. */
export const CONDITION_ORDER = [
  'message_type',
  'has_media',
  'sender',
  'allow_list',
  'deny_list',
  'group',
  'time_window',
  'not_time_window',
  'skip_if_human_replied_within',
  'counter',
  'sample',
  'facts',
  'mentions_me',
  'reply_to_me',
  'quoted',
  'keywords',
  'regex',
] as const satisfies ReadonlyArray<keyof Condition>
type KnownKey = (typeof CONDITION_ORDER)[number]
const KNOWN: ReadonlySet<string> = new Set(CONDITION_ORDER)

export interface ConditionDeps {
  ruleId: string
  regexes: CompiledRegexes
}

/**
 * Evaluates one condition object (all keys must hold) over an event and context, cheapest key first,
 * stopping at the first failing key. P2 conditions never reach here: validation rejects them.
 */
export function evaluateCondition(
  c: Condition,
  e: StoredEvent,
  ctx: EvalContext,
  deps: ConditionDeps,
): ConditionResult[] {
  const out: ConditionResult[] = []
  const p = e.payload as MessagePayload
  for (const key of Object.keys(c))
    if (!KNOWN.has(key)) throw new Error(`condition ${key} needs P2 understanding`)
  for (const key of CONDITION_ORDER) {
    const want = c[key]
    if (want === undefined) continue
    const r = one(key, c, e, p, ctx, deps)
    out.push(r)
    if (!r.passed) break
  }
  return out
}

function one(
  key: KnownKey,
  c: Condition,
  e: StoredEvent,
  p: MessagePayload,
  ctx: EvalContext,
  deps: ConditionDeps,
): ConditionResult {
  const res = (passed: boolean, detail?: string): ConditionResult => ({
    name: key,
    passed,
    ...(detail !== undefined ? { detail } : {}),
  })
  switch (key) {
    case 'sender':
    case 'allow_list': {
      const found = hit(ctx.senderIds, asList(c[key] as string | string[]))
      return res(found !== null, found ?? 'sender not listed')
    }
    case 'deny_list': {
      const found = hit(ctx.senderIds, c.deny_list as string[])
      return res(found === null, found ?? undefined)
    }
    case 'group':
      return res(e.chatId !== null && asList(c.group as string | string[]).includes(e.chatId))
    case 'keywords': {
      const k = containsKeyword(bodyOf(e), c.keywords as string[])
      return res(k !== null, k ?? undefined)
    }
    case 'regex':
      return res(regexMatches(deps.regexes, c.regex as string, bodyOf(e)))
    case 'message_type': {
      const kinds = asList(c.message_type as MessageKind | MessageKind[])
      return res(kinds.includes((p.kind ?? 'unknown') as MessageKind), p.kind ?? 'unknown')
    }
    case 'has_media': {
      const has = MEDIA_KINDS.has(p.kind ?? '') || p.mediaRef !== undefined
      return res(has === c.has_media)
    }
    case 'mentions_me': {
      // shortcut: `me` is derived from our own from-me messages; read it from the connector when it exposes the self JID
      const mentioned = (p.mentions ?? []).some((m) => ctx.me.includes(m))
      return res(mentioned === c.mentions_me)
    }
    case 'reply_to_me':
      return res((ctx.quoted?.isFromMe ?? false) === c.reply_to_me)
    case 'quoted': {
      const q = c.quoted as NonNullable<Condition['quoted']>
      if (!ctx.quoted) return res(false, 'no quoted message')
      if (q.from_me !== undefined && ctx.quoted.isFromMe !== q.from_me) return res(false, 'quoted.from_me')
      const body = ctx.quoted.body ?? ''
      if (q.keywords && containsKeyword(body, q.keywords) === null) return res(false, 'quoted.keywords')
      if (q.regex !== undefined && !regexMatches(deps.regexes, q.regex, body))
        return res(false, 'quoted.regex')
      return res(true)
    }
    case 'facts': {
      const miss = Object.entries(c.facts as Record<string, string>).find(([k, v]) => ctx.facts[k] !== v)
      return res(miss === undefined, miss ? `facts.${miss[0]}` : undefined)
    }
    case 'counter': {
      const { name, min, max } = c.counter as NonNullable<Condition['counter']>
      const v = ctx.counters[`rule:${deps.ruleId}:${name}`] ?? 0
      return res((min === undefined || v >= min) && (max === undefined || v <= max), `${name}=${v}`)
    }
    case 'sample': {
      const draw = ctx.rng()
      return res(draw < (c.sample as number), draw.toFixed(6))
    }
    case 'time_window':
      return res(inTimeWindow(c.time_window as string, ctx.now, ctx.zone, ctx.businessHours))
    case 'not_time_window':
      return res(!inTimeWindow(c.not_time_window as string, ctx.now, ctx.zone, ctx.businessHours))
    case 'skip_if_human_replied_within': {
      const within = parseDuration(c.skip_if_human_replied_within as string)
      const last = ctx.lastHumanReplyAt
      const recent = last !== null && ctx.now.getTime() - last.getTime() < within
      return res(!recent, last ? last.toISOString() : 'no human reply')
    }
  }
}
