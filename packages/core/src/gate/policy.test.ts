import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '../clock.js'
import { AccountConfigSchema } from '../config/schema.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { Limiter } from './limiter.js'
import { type GateContext, PolicyGate } from './policy.js'
import type { PlannedAction } from './types.js'

let tdb: TestDatabase
let gate: PolicyGate
let limiter: Limiter
const clock = new ManualClock(new Date('2026-06-01T05:00:00Z')) // Monday 10:30 Kolkata
void pino

beforeAll(async () => {
  tdb = await createTestDatabase()
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id: 'gate', type: 'web', display_name: 'G', timezone: 'Asia/Kolkata' }),
  )
  limiter = new Limiter(tdb.handle.db, tablesFor('acct_gate'), clock)
  gate = new PolicyGate(limiter)
})
afterAll(() => tdb.drop())

const cfg = AccountConfigSchema.parse({
  id: 'gate',
  type: 'web',
  display_name: 'G',
  timezone: 'Asia/Kolkata',
})
const msg = (over: Partial<GateContext['recentMessages'][number]>) =>
  ({
    id: 'm',
    providerId: 'p',
    chatId: 'c',
    senderId: null,
    eventId: 'e',
    type: 'text',
    body: null,
    bodyTsv: '',
    mediaId: null,
    quotedProviderId: null,
    isFromMe: false,
    origin: null,
    occurredAt: clock.now(),
    deletedAt: null,
    editedAt: null,
    bodyHash: null,
    ...over,
  }) as GateContext['recentMessages'][number]

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    accountId: 'gate',
    timezone: cfg.timezone,
    businessHours: cfg.business_hours,
    limits: cfg.limits,
    capabilities: new Set(['reactions']),
    globalKill: false,
    accountPaused: false,
    throttled: null,
    chat: {
      id: 'c@s.whatsapp.net',
      type: 'dm',
      name: null,
      automationState: 'active',
      pausedUntil: null,
      llmEnabled: true,
      lastSeq: 0,
      archived: false,
      pinned: false,
      unreadCount: 0,
      lastMessageAt: null,
      updatedAt: clock.now(),
    },
    recipient: {
      id: 'r',
      displayName: null,
      pushName: null,
      phoneEnc: null,
      phoneHash: null,
      llmEnabled: true,
      blocked: false,
      allowInitiate: false,
      firstDmAt: clock.now(),
      createdAt: clock.now(),
      updatedAt: clock.now(),
    },
    recentMessages: [],
    lastIdenticalSendAt: null,
    now: clock.now(),
    ...over,
  }
}
function act(over: Partial<PlannedAction> = {}): PlannedAction {
  return {
    kind: 'send_message',
    source: 'cli',
    actor: 'op',
    idempotencyKey: `k${Math.random()}`,
    chatId: 'c@s.whatsapp.net',
    recipientContactId: 'r',
    payload: {},
    text: 'hello',
    approval: 'auto',
    ...over,
  }
}

describe('policy gate', () => {
  const cases: Array<{
    name: string
    action?: Partial<PlannedAction>
    ctx?: Partial<GateContext>
    outcome: string
    check?: string
  }> = [
    { name: 'clean send executes', outcome: 'execute' },
    { name: 'global kill blocks', ctx: { globalKill: true }, outcome: 'blocked', check: 'kill_switch' },
    { name: 'account paused blocks', ctx: { accountPaused: true }, outcome: 'blocked', check: 'kill_switch' },
    {
      name: 'escalated chat blocks sends',
      ctx: { chat: { ...ctx().chat, automationState: 'escalated' } as GateContext['chat'] },
      outcome: 'blocked',
      check: 'kill_switch',
    },
    {
      name: 'paused chat with elapsed paused_until executes',
      ctx: {
        chat: {
          ...ctx().chat,
          automationState: 'paused',
          pausedUntil: new Date(clock.now().getTime() - 1000),
        } as GateContext['chat'],
      },
      outcome: 'execute',
    },
    {
      name: 'escalated chat still allows observe actions',
      action: { kind: 'set_label', payload: { label: 'x' } },
      ctx: { chat: { ...ctx().chat, automationState: 'escalated' } as GateContext['chat'] },
      outcome: 'execute',
    },
    {
      name: 'missing capability blocks',
      action: { kind: 'react_to_message', payload: { providerId: 'p', emoji: '👍' } },
      ctx: { capabilities: new Set() },
      outcome: 'blocked',
      check: 'capability',
    },
    {
      name: 'blocked recipient',
      ctx: { recipient: { ...ctx().recipient, blocked: true } as GateContext['recipient'] },
      outcome: 'blocked',
      check: 'deny_list',
    },
    {
      name: 'rule-denied kind',
      action: { deniedKinds: ['send_message'] },
      outcome: 'blocked',
      check: 'deny_list',
    },
    {
      name: 'first contact: never DMed us and not allowlisted',
      ctx: { recipient: { ...ctx().recipient, firstDmAt: null } as GateContext['recipient'] },
      outcome: 'blocked',
      check: 'first_contact',
    },
    {
      name: 'first contact: allow_initiate passes',
      ctx: {
        recipient: { ...ctx().recipient, firstDmAt: null, allowInitiate: true } as GateContext['recipient'],
      },
      outcome: 'execute',
    },
    {
      name: 'first contact rule does not apply in groups',
      ctx: {
        chat: { ...ctx().chat, type: 'group' } as GateContext['chat'],
        recipient: { ...ctx().recipient, firstDmAt: null } as GateContext['recipient'],
      },
      outcome: 'execute',
    },
    {
      name: 'loop: trigger was our own message',
      action: { inboundOrigin: 'self_system' },
      outcome: 'blocked',
      check: 'loop_protection',
    },
    {
      name: 'loop: three automated in a row',
      ctx: { recentMessages: [1, 2, 3].map(() => msg({ isFromMe: true, origin: 'self_system' })) },
      outcome: 'blocked',
      check: 'loop_protection',
    },
    {
      name: 'loop: human message in between resets',
      ctx: {
        recentMessages: [
          msg({ isFromMe: true, origin: 'self_system' }),
          msg({ isFromMe: false }),
          msg({ isFromMe: true, origin: 'self_system' }),
        ],
      },
      outcome: 'execute',
    },
    {
      name: 'loop: identical text within 10 min',
      ctx: { lastIdenticalSendAt: new Date(clock.now().getTime() - 60_000) },
      outcome: 'blocked',
      check: 'loop_protection',
    },
    {
      name: 'quiet hours block outside business hours',
      ctx: { now: new Date('2026-06-01T20:00:00Z') },
      outcome: 'blocked',
      check: 'quiet_hours',
    },
    {
      name: 'quiet hours override needs scope permission',
      action: { overrideQuietHours: true },
      ctx: { now: new Date('2026-06-01T20:00:00Z') },
      outcome: 'blocked',
      check: 'quiet_hours',
    },
    {
      name: 'quiet hours override with permission passes',
      action: { overrideQuietHours: true, allowQuietOverride: true },
      ctx: { now: new Date('2026-06-01T20:00:00Z') },
      outcome: 'execute',
    },
    { name: 'approve mode awaits', action: { approval: 'approve' }, outcome: 'await_approval' },
    { name: 'dry run', action: { approval: 'dry_run' }, outcome: 'dry_run' },
    {
      name: 'throttled account forces approval on sends',
      ctx: { throttled: { until: new Date(clock.now().getTime() + 3600_000), reason: 'spam signal' } },
      outcome: 'await_approval',
    },
    {
      name: 'observe action in dry run',
      action: { kind: 'notify_operator', approval: 'dry_run', payload: { title: 't' } },
      outcome: 'dry_run',
    },
  ]
  for (const c of cases) {
    it(c.name, async () => {
      const d = await gate.evaluate(act(c.action), ctx(c.ctx))
      expect(d.outcome).toBe(c.outcome)
      if (c.check) expect(d.check).toBe(c.check)
      expect(d.trace.length).toBeGreaterThan(0)
    })
  }

  it('rate limit peek blocks after the bucket is consumed, with retry_after', async () => {
    const a = act({ chatId: 'rl@s.whatsapp.net' })
    await limiter.bucket('chat:rl@s.whatsapp.net', 30, 1, 'consume')
    const d = await gate.evaluate(
      a,
      ctx({ chat: { ...ctx().chat, id: 'rl@s.whatsapp.net' } as GateContext['chat'] }),
    )
    expect(d.outcome).toBe('blocked')
    expect(d.check).toBe('rate_limit')
    expect(d.trace.at(-1)?.retryAfterMs).toBeGreaterThan(0)
  })
})
