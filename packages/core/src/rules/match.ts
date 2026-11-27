import type { ChatType, MessagePayload, StoredEvent } from '../events/types.js'
import { type BusinessHours, inBusinessHours, inClockWindow } from '../gate/hours.js'
import type { RuleDefinition, ScopeKey } from './schema.js'

/** PRD §7.5 weight table; level 1 (global) is the empty scope and weighs 0. */
export const SCOPE_WEIGHTS: Record<ScopeKey, number> = {
  account: 10,
  phone_number: 15,
  chat_type: 20,
  label: 30,
  group: 40,
  chat: 40,
  contact: 50,
  participant_in_group: 60,
  message_type: 5,
  time_window: 5,
  thread: 70,
}

export type RuleScope = RuleDefinition['scope']

/** What scope matching needs to know beyond the event itself. */
export interface MatchContext {
  accountId: string
  /** The account's own number on the Cloud API; null on Web, so `phone_number` scopes never match there. */
  phoneNumber: string | null
  chatType: ChatType | null
  labels: readonly string[]
  /** The sender's canonical contact id and every JID linked to it, so rules may name either. */
  senderIds: readonly string[]
  now: Date
  zone: string
  businessHours: BusinessHours
}

export function specificity(scope: RuleScope): number {
  let sum = 0
  for (const key of Object.keys(scope) as ScopeKey[]) if (scope[key] !== undefined) sum += SCOPE_WEIGHTS[key]
  return sum
}

/** `business_hours` or `HH:MM-HH:MM`, evaluated in the account zone. */
export function inTimeWindow(window: string, now: Date, zone: string, bh: BusinessHours): boolean {
  if (window === 'business_hours') return inBusinessHours(now, zone, bh)
  const [start, end] = window.split('-') as [string, string]
  return inClockWindow(now, zone, start, end)
}

/** Scopes compose with AND; an empty scope matches every event. */
export function matchesScope(scope: RuleScope, e: StoredEvent, ctx: MatchContext): boolean {
  const p = e.payload as MessagePayload
  for (const key of Object.keys(scope) as ScopeKey[]) {
    const want = scope[key]
    if (want === undefined) continue
    let ok: boolean
    switch (key) {
      case 'account':
        ok = want === ctx.accountId
        break
      case 'phone_number':
        ok = want === ctx.phoneNumber
        break
      case 'chat_type':
        ok = want === ctx.chatType
        break
      case 'label':
        ok = ctx.labels.includes(want)
        break
      case 'group':
        ok = ctx.chatType === 'group' && want === e.chatId
        break
      case 'chat':
        ok = want === e.chatId
        break
      case 'contact':
        ok = ctx.senderIds.includes(want)
        break
      case 'participant_in_group':
        ok = ctx.chatType === 'group' && ctx.senderIds.includes(want)
        break
      case 'message_type':
        ok = want === p.kind
        break
      case 'time_window':
        ok = inTimeWindow(want, ctx.now, ctx.zone, ctx.businessHours)
        break
      case 'thread':
        // shortcut: a thread is its root message and direct replies to it; walk the quote chain when deeper threads matter
        ok = want === e.providerId || want === p.quotedProviderId
        break
    }
    if (!ok) return false
  }
  return true
}

/** Specificity desc, priority desc, id asc (PRD §7.5). Stable for equal keys. */
export function sortRules<T extends { specificity: number; priority: number; id: string }>(rules: T[]): T[] {
  return [...rules].sort(
    (a, b) =>
      b.specificity - a.specificity || b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** Union of `never` and `deny` across scope-matched rules; denies apply on scope match, not condition match. */
export function deniedKinds(rules: ReadonlyArray<{ definition: RuleDefinition }>): string[] {
  const out = new Set<string>()
  for (const r of rules)
    for (const k of [...(r.definition.never ?? []), ...(r.definition.deny ?? [])]) out.add(k)
  return [...out].sort()
}
