import type { Capability } from '../connectors/types.js'
import type { AccountTables } from '../db/schema/account.js'
import type { BusinessHours } from './hours.js'
import { inBusinessHours } from './hours.js'
import { DAY_MS, HOUR_MS, type Limiter, startOfDayInZone, startOfHour } from './limiter.js'
import {
  ACTION_CAPABILITY,
  ACTION_CLASS,
  type CheckResult,
  type GateDecision,
  type PlannedAction,
} from './types.js'

export interface AccountLimits {
  sends_per_chat_interval_seconds: number
  sends_per_hour: number
  sends_per_day: number
  sends_per_contact_per_day: number
  max_consecutive_automated: number
}

export interface GateContext {
  accountId: string
  timezone: string
  businessHours: BusinessHours
  limits: AccountLimits
  capabilities: ReadonlySet<Capability>
  globalKill: boolean
  accountPaused: boolean
  throttled: { until: Date; reason: string } | null
  chat: AccountTables['chats']['$inferSelect'] | null
  recipient: AccountTables['contacts']['$inferSelect'] | null
  /** Oldest first. */
  recentMessages: AccountTables['messages']['$inferSelect'][]
  /** When the same outbound text was last sent to this chat. */
  lastIdenticalSendAt: Date | null
  now: Date
}

export interface LimitKeys {
  chatBucket: { key: string; intervalSeconds: number } | null
  windows: Array<{ key: string; windowStart: Date; windowMs: number; limit: number; label: string }>
}

export const IDENTICAL_SEND_WINDOW_MS = 10 * 60_000

export function limitKeysFor(action: PlannedAction, ctx: GateContext): LimitKeys {
  const l = ctx.limits
  const factor = ctx.throttled && ctx.throttled.until > ctx.now ? 0.5 : 1
  const scale = (n: number) => Math.max(1, Math.ceil(n * factor))
  const windows: LimitKeys['windows'] = [
    {
      key: 'account:hour',
      windowStart: startOfHour(ctx.now),
      windowMs: HOUR_MS,
      limit: scale(l.sends_per_hour),
      label: 'account per hour',
    },
    {
      key: 'account:day',
      windowStart: startOfDayInZone(ctx.now, ctx.timezone),
      windowMs: DAY_MS,
      limit: scale(l.sends_per_day),
      label: 'account per day',
    },
  ]
  if (action.recipientContactId) {
    windows.push({
      key: `contact:${action.recipientContactId}:day`,
      windowStart: startOfDayInZone(ctx.now, ctx.timezone),
      windowMs: DAY_MS,
      limit: scale(l.sends_per_contact_per_day),
      label: 'contact per day',
    })
  }
  return {
    chatBucket: action.chatId
      ? { key: `chat:${action.chatId}`, intervalSeconds: l.sends_per_chat_interval_seconds }
      : null,
    windows,
  }
}

/**
 * The ten-check policy gate (PRD §7.6). Observe-class actions and notify_operator skip checks 3 to 9.
 * Rate limits are peeked here and consumed by the executor at execution time.
 */
export class PolicyGate {
  constructor(private readonly limiter: Limiter) {}

  async evaluate(action: PlannedAction, ctx: GateContext): Promise<GateDecision> {
    const trace: CheckResult[] = []
    const cls = ACTION_CLASS[action.kind]
    const gated = cls !== 'observe'
    const fail = (check: string, reason: string, extra: Partial<CheckResult> = {}): GateDecision => {
      trace.push({ check, passed: false, reason, ...extra })
      return { outcome: 'blocked', check, reason, trace }
    }
    const pass = (check: string, reason?: string) =>
      trace.push({ check, passed: true, ...(reason ? { reason } : {}) })

    // 1. kill switches
    if (ctx.globalKill) return fail('kill_switch', 'global kill switch is on')
    if (ctx.accountPaused) return fail('kill_switch', 'account is paused')
    const chatState = ctx.chat?.automationState ?? 'active'
    const pausedUntil = ctx.chat?.pausedUntil ?? null
    const chatPaused =
      chatState === 'escalated' || (chatState === 'paused' && (!pausedUntil || pausedUntil > ctx.now))
    if (gated && chatPaused) return fail('kill_switch', `chat automation is ${chatState}`)
    pass('kill_switch')

    // 2. capability
    const cap = ACTION_CAPABILITY[action.kind]
    if (cap && !ctx.capabilities.has(cap)) return fail('capability', `connector lacks capability ${cap}`)
    pass('capability')

    if (!gated) {
      trace.push({ check: 'observe_class', passed: true, reason: 'checks 3-9 skipped for observe actions' })
      return { outcome: action.approval === 'dry_run' ? 'dry_run' : 'execute', trace }
    }

    // 3. deny lists
    if (ctx.recipient?.blocked) return fail('deny_list', 'recipient is blocked')
    if (action.deniedKinds?.includes(action.kind))
      return fail('deny_list', `action kind ${action.kind} denied by a matching rule`)
    pass('deny_list')

    // 4. first contact (DMs only)
    if (cls === 'counterparty_send' && ctx.chat?.type === 'dm' && ctx.recipient) {
      if (!ctx.recipient.firstDmAt && !ctx.recipient.allowInitiate) {
        return fail(
          'first_contact',
          'recipient has never sent this account a DM and is not on allow_initiate',
        )
      }
    }
    pass('first_contact')

    // 5. loop protection
    if (action.inboundOrigin === 'self_system')
      return fail('loop_protection', 'triggering message was sent by this system')
    const recent = ctx.recentMessages
    const maxAuto = ctx.limits.max_consecutive_automated
    if (recent.length >= maxAuto) {
      const tail = recent.slice(-maxAuto)
      if (tail.every((m) => m.isFromMe && m.origin === 'self_system')) {
        return fail(
          'loop_protection',
          `last ${maxAuto} messages in chat were automated with no human message between`,
        )
      }
    }
    if (
      ctx.lastIdenticalSendAt &&
      ctx.now.getTime() - ctx.lastIdenticalSendAt.getTime() < IDENTICAL_SEND_WINDOW_MS
    ) {
      return fail('loop_protection', 'identical text was sent to this chat within 10 minutes')
    }
    pass('loop_protection')

    // 6. quiet hours
    const open = inBusinessHours(ctx.now, ctx.timezone, ctx.businessHours)
    if (!open) {
      if (action.overrideQuietHours && action.allowQuietOverride)
        pass('quiet_hours', 'outside business hours; override permitted by rule scope')
      else return fail('quiet_hours', 'outside business hours')
    } else pass('quiet_hours')

    // 7. rate limits (peek)
    const keys = limitKeysFor(action, ctx)
    if (keys.chatBucket) {
      const r = await this.limiter.bucket(keys.chatBucket.key, keys.chatBucket.intervalSeconds, 1, 'peek')
      if (!r.allowed) return fail('rate_limit', 'per-chat send interval', { retryAfterMs: r.retryAfterMs })
    }
    for (const w of keys.windows) {
      const r = await this.limiter.window(w.key, w.windowStart, w.windowMs, w.limit, 'peek')
      if (!r.allowed) return fail('rate_limit', `${w.label} limit reached`, { retryAfterMs: r.retryAfterMs })
    }
    pass('rate_limit')

    // 8. content guard (P2)
    pass('content_guard', 'not configured')

    // 9. approval mode
    const forcedApprove = ctx.throttled && ctx.throttled.until > ctx.now && cls === 'counterparty_send'
    const mode = forcedApprove ? 'approve' : action.approval
    trace.push({
      check: 'approval_mode',
      passed: true,
      reason: forcedApprove ? `account throttled: ${ctx.throttled?.reason}` : mode,
    })
    if (mode === 'dry_run') return { outcome: 'dry_run', trace }
    if (mode === 'approve') return { outcome: 'await_approval', trace }
    return { outcome: 'execute', trace }
  }
}
