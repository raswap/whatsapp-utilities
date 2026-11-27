import { AccountConfigSchema } from '../../config/schema.js'
import type { EventType, StoredEvent } from '../../events/types.js'
import type { EvalContext } from '../conditions.js'
import { type CompiledRule, compileRule, seededRng } from '../engine.js'
import type { TargetsConfig } from '../schema.js'
import { parseRuleYaml } from '../validate.js'

export const T0 = new Date('2026-06-01T10:00:00Z') // a Monday
export const CHAT = 'cust@s.whatsapp.net'
export const SENDER = 'C1'

export const ACCOUNT = AccountConfigSchema.parse({
  id: 'main',
  type: 'web',
  display_name: 'Main Account',
  timezone: 'UTC',
  business_hours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
})

export function makeEvent(over: Partial<StoredEvent> & { type?: string } = {}): StoredEvent {
  return {
    cursor: 1,
    id: '01EVENT',
    accountId: 'main',
    providerId: 'P1',
    discriminator: '',
    chatId: CHAT,
    senderId: SENDER,
    seq: 1,
    occurredAt: T0,
    receivedAt: T0,
    isBackfill: false,
    isFromMe: false,
    origin: null,
    payload: { kind: 'text', body: 'hello' },
    ...over,
    type: (over.type ?? 'message.received') as EventType,
  }
}

export function makeCtx(over: Partial<EvalContext> = {}): EvalContext {
  return {
    now: T0,
    zone: 'UTC',
    businessHours: ACCOUNT.business_hours,
    account: ACCOUNT,
    chat: {
      id: CHAT,
      type: 'dm',
      name: 'Cust Chat',
      automationState: 'active',
      pausedUntil: null,
      llmEnabled: true,
      lastSeq: 1,
      archived: false,
      pinned: false,
      unreadCount: 2,
      lastMessageAt: T0,
      updatedAt: T0,
    },
    contact: {
      id: SENDER,
      displayName: null,
      pushName: 'Asha',
      phoneEnc: null,
      phoneHash: null,
      llmEnabled: true,
      blocked: false,
      allowInitiate: false,
      firstDmAt: T0,
      createdAt: T0,
      updatedAt: T0,
    },
    labels: [],
    senderIds: [SENDER, CHAT],
    me: [],
    quoted: null,
    contactPhone: null,
    lastHumanReplyAt: null,
    counters: {},
    facts: {},
    deniedKinds: [],
    suppressed: null,
    rng: seededRng('01EVENT'),
    llm: {},
    ...over,
  }
}

/** Parses, validates and compiles a rule; throws on validation issues. */
export function compileYaml(yaml: string, opts: { targets?: TargetsConfig } = {}): CompiledRule {
  const { definition, issues } = parseRuleYaml(yaml, { accountType: 'web', ...opts })
  if (!definition || issues.length) throw new Error(`fixture rule invalid: ${JSON.stringify(issues)}`)
  return compileRule({ definition, account: definition.scope.account ?? null })
}

/** Dates to ISO strings, undefined dropped: what a JSON golden holds. */
export function json<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
