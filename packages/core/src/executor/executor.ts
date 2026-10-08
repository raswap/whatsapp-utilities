import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { AuditLog } from '../audit/log.js'
import type { Clock } from '../clock.js'
import type { Connector, SendCommand } from '../connectors/types.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import type { EventHandler } from '../events/pipeline.js'
import type { StoredEvent } from '../events/types.js'
import type { Limiter } from '../gate/limiter.js'
import { type GateContext, limitKeysFor, type PolicyGate } from '../gate/policy.js'
import type { PlannedAction } from '../gate/types.js'
import { newMessageId } from '../ids.js'
import type { OperatorChannel } from '../operator/channel.js'
import type { ChatStore, MessageStore } from '../store/messages.js'
import { type ActionRow, ActionStore } from './actions.js'

export interface ExecutorOptions {
  accountId: string
  db: Db
  tables: AccountTables
  connector: Connector
  gate: PolicyGate
  limiter: Limiter
  audit: AuditLog
  operator: OperatorChannel
  chats: ChatStore
  messages: MessageStore
  clock: Clock
  log: Logger
  /** Builds the gate context for an action; injected so account settings stay outside the executor. */
  contextFor: (action: PlannedAction) => Promise<GateContext>
  approvalTtlMs?: number
  unknownResolveWindowMs?: number
  maxAttempts?: number
  /** Replaces real sleeping in tests. */
  sleep?: (ms: number) => Promise<void>
}

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'EXPIRED' | 'SELF_APPROVAL' | 'WRONG_STATE',
  ) {
    super(message)
    this.name = 'ApprovalError'
  }
}

const RETRY_BACKOFF_MS = [5_000, 30_000, 120_000]

function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Drives actions through the lifecycle in PRD §8.3: gate → approval → execute with a pre-generated
 * message id → sent / failed / unknown, with unknown auto-resolved by the observed from-me event.
 */
export class Executor {
  readonly actions: ActionStore
  private readonly log: Logger
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly o: ExecutorOptions) {
    this.actions = new ActionStore(o.db, o.tables, o.clock)
    this.log = o.log.child({ component: 'executor', account: o.accountId })
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Entry point for rules and tools. Idempotent on (key, day). */
  async submit(p: PlannedAction): Promise<ActionRow> {
    const { row, created } = await this.actions.create(p)
    if (!created) return row
    const ctx = await this.o.contextFor(p)
    const decision = await this.o.gate.evaluate(p, ctx)
    await this.o.audit.append({
      actor: p.actor,
      kind: 'gate',
      subjectId: row.id,
      eventId: p.eventId ?? null,
      ruleId: p.ruleId ?? null,
      chatId: p.chatId ?? null,
      decision: decision.outcome,
      detail: {
        check: decision.check ?? null,
        reason: decision.reason ?? null,
        trace: decision.trace,
        kind: p.kind,
      },
    })
    const gatePatch = {
      gate: {
        outcome: decision.outcome,
        check: decision.check ?? null,
        reason: decision.reason ?? null,
        trace: decision.trace,
      },
    }
    switch (decision.outcome) {
      case 'blocked':
        return this.actions.update(row.id, {
          ...gatePatch,
          state: 'blocked',
          result: { check: decision.check, reason: decision.reason },
        })
      case 'dry_run':
        return this.actions.update(row.id, { ...gatePatch, state: 'dry_run', result: { would: p.kind } })
      case 'await_approval': {
        await this.actions.update(row.id, gatePatch)
        const pending = await this.actions.markAwaitingApproval(row.id, this.o.approvalTtlMs ?? 4 * 3600_000)
        await this.notifyApproval(pending, p)
        return pending
      }
      case 'execute': {
        const approved = await this.actions.update(row.id, { ...gatePatch, state: 'approved' })
        return this.execute(approved)
      }
    }
  }

  private async notifyApproval(row: ActionRow, p: PlannedAction) {
    const preview = (p.text ?? '').slice(0, 300)
    const lines = [
      `Code: ${row.approvalCode}`,
      `Action: ${p.kind}${p.chatId ? ` → ${p.chatId}` : ''}`,
      p.ruleId ? `Rule: ${p.ruleId}` : `Source: ${p.source}`,
      preview ? `Text: ${preview}` : '',
      `Expires: ${row.expiresAt?.toISOString() ?? ''}`,
      `Reply with: wamcp approvals approve ${row.approvalCode}`,
    ].filter(Boolean)
    await this.o.operator.notify({
      kind: 'approval',
      title: `Approval needed: ${p.kind}`,
      body: lines.join('\n'),
      accountId: this.o.accountId,
      data: { actionId: row.id, code: row.approvalCode },
    })
  }

  async approve(code: string, actor: string): Promise<ActionRow> {
    const row = await this.actions.byApprovalCode(code)
    if (!row) throw new ApprovalError('no pending approval with that code', 'NOT_FOUND')
    if (row.expiresAt && row.expiresAt < this.o.clock.now()) {
      await this.actions.transition(row.id, ['awaiting_approval'], 'expired')
      throw new ApprovalError('approval has expired', 'EXPIRED')
    }
    if (row.approvalCreatedBy === actor)
      throw new ApprovalError('an action cannot be approved by the actor that created it', 'SELF_APPROVAL')
    const p = this.plannedFrom(row)
    // Re-run the gate: kill switches and limits may have changed since the request (PRD §8.4).
    const decision = await this.o.gate.evaluate({ ...p, approval: 'auto' }, await this.o.contextFor(p))
    await this.o.audit.append({
      actor,
      kind: 'approval',
      subjectId: row.id,
      chatId: row.chatId,
      ruleId: row.ruleId,
      eventId: row.eventId,
      decision: decision.outcome === 'execute' ? 'approved' : 'blocked_on_approval',
      detail: { check: decision.check ?? null, reason: decision.reason ?? null },
    })
    if (decision.outcome !== 'execute') {
      const blocked = await this.actions.transition(row.id, ['awaiting_approval'], 'blocked', {
        approvalDecidedBy: actor,
        approvalDecidedAt: this.o.clock.now(),
        result: { check: decision.check, reason: decision.reason },
      })
      return blocked ?? row
    }
    const approved = await this.actions.transition(row.id, ['awaiting_approval'], 'approved', {
      approvalDecidedBy: actor,
      approvalDecidedAt: this.o.clock.now(),
    })
    if (!approved) throw new ApprovalError('approval was decided concurrently', 'WRONG_STATE')
    return this.execute(approved)
  }

  async reject(code: string, actor: string, reason = ''): Promise<ActionRow> {
    const row = await this.actions.byApprovalCode(code)
    if (!row) throw new ApprovalError('no pending approval with that code', 'NOT_FOUND')
    const rejected = await this.actions.transition(row.id, ['awaiting_approval'], 'rejected', {
      approvalDecidedBy: actor,
      approvalDecidedAt: this.o.clock.now(),
      result: { reason },
    })
    await this.o.audit.append({
      actor,
      kind: 'approval',
      subjectId: row.id,
      chatId: row.chatId,
      decision: 'rejected',
      detail: { reason },
    })
    return rejected ?? row
  }

  private plannedFrom(row: ActionRow): PlannedAction {
    const payload = row.payload as Record<string, unknown>
    return {
      kind: row.kind as PlannedAction['kind'],
      source: row.source,
      actor: row.approvalCreatedBy ?? row.source,
      idempotencyKey: row.idempotencyKey,
      ...(row.chatId ? { chatId: row.chatId } : {}),
      ...(payload.recipientContactId ? { recipientContactId: payload.recipientContactId as string } : {}),
      payload,
      ...(row.ruleId ? { ruleId: row.ruleId } : {}),
      ...(row.eventId ? { eventId: row.eventId } : {}),
      ...(typeof payload.text === 'string' ? { text: payload.text } : {}),
      approval: 'auto',
    }
  }

  /** Consumes limits, pre-generates the id, calls the connector, records the outcome. */
  async execute(row: ActionRow): Promise<ActionRow> {
    const p = this.plannedFrom(row)
    const ctx = await this.o.contextFor(p)
    // Limits were consumed on the first attempt; a transport retry of an unwritten frame does not pay again.
    const transportRetry =
      row.state === 'retry_wait' &&
      (row.result as { transportRetry?: boolean } | null)?.transportRetry === true
    if (row.class !== 'observe' && !transportRetry) {
      const keys = limitKeysFor(p, ctx)
      const blockers: string[] = []
      if (keys.chatBucket) {
        const r = await this.o.limiter.bucket(
          keys.chatBucket.key,
          keys.chatBucket.intervalSeconds,
          1,
          'consume',
        )
        if (!r.allowed) blockers.push(`chat interval (retry in ${r.retryAfterMs} ms)`)
      }
      if (blockers.length === 0) {
        for (const w of keys.windows) {
          const r = await this.o.limiter.window(w.key, w.windowStart, w.windowMs, w.limit, 'consume')
          if (!r.allowed) {
            blockers.push(w.label)
            break
          }
        }
      }
      if (blockers.length) {
        // Re-queued once after the limiter refills, then dropped with a notification (PRD §7.6 check 7).
        if (row.attempts === 0) {
          const next = await this.actions.transition(row.id, ['approved', 'retry_wait'], 'retry_wait', {
            attempts: 1,
            result: {
              reason: `rate limited: ${blockers.join(', ')}`,
              retryAt: new Date(this.o.clock.now().getTime() + 30_000).toISOString(),
            },
          })
          return next ?? row
        }
        const failed = await this.actions.transition(row.id, ['approved', 'retry_wait'], 'failed', {
          result: { reason: `rate limited twice: ${blockers.join(', ')}` },
        })
        await this.o.operator.notify({
          kind: 'alert',
          title: 'Action dropped: rate limited',
          body: `${row.kind} to ${row.chatId ?? '?'} was rate limited twice and dropped.`,
          accountId: this.o.accountId,
        })
        return failed ?? row
      }
    }
    const cmd = this.toSendCommand(p)
    if (!cmd) return this.executeLocal(row, p)

    const messageId = newMessageId()
    const executing = await this.actions.transition(row.id, ['approved', 'retry_wait'], 'executing', {
      messageId,
      attempts: row.attempts + 1,
      payload: { ...(row.payload as object), textHash: p.text ? textHash(p.text) : null },
    })
    if (!executing) return row
    if (p.kind === 'send_message' && (p.payload as { typing_delay?: string }).typing_delay === 'natural') {
      const len = (p.text ?? '').length
      await this.o.connector
        .send({
          kind: 'set_typing',
          chatId: p.chatId as string,
          typing: true,
          messageId: `${messageId}-typing`,
        })
        .catch(() => undefined)
      await this.sleep(Math.min(8000, 1000 + Math.round(len * 25)))
    }
    try {
      const res = await this.o.connector.send({ ...cmd, messageId })
      if (res.outcome === 'accepted') {
        const sent = await this.actions.transition(row.id, ['executing'], 'sent', {
          result: { messageId, frameWritten: res.frameWritten },
        })
        await this.o.audit.append({
          actor: p.actor,
          kind: 'action',
          subjectId: row.id,
          chatId: row.chatId,
          ruleId: row.ruleId,
          eventId: row.eventId,
          decision: 'sent',
          detail: { kind: row.kind, messageId, textHash: p.text ? textHash(p.text) : null },
        })
        return sent ?? executing
      }
      const failed = await this.actions.transition(row.id, ['executing'], 'failed', {
        result: { error: res.error ?? null, frameWritten: res.frameWritten },
      })
      await this.o.audit.append({
        actor: p.actor,
        kind: 'action',
        subjectId: row.id,
        chatId: row.chatId,
        decision: 'failed',
        detail: { kind: row.kind, error: res.error?.kind ?? 'rejected' },
      })
      await this.o.operator.notify({
        kind: 'alert',
        title: 'Action failed',
        body: `${row.kind} to ${row.chatId ?? '?'}: ${res.error?.message ?? 'rejected by connector'}`,
        accountId: this.o.accountId,
      })
      return failed ?? executing
    } catch (e) {
      const err = e as Error & { frameWritten?: boolean }
      const frameWritten = err.frameWritten === true
      const attempts = executing.attempts
      if (!frameWritten && attempts < (this.o.maxAttempts ?? 3)) {
        const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] as number
        const wait = await this.actions.transition(row.id, ['executing'], 'retry_wait', {
          messageId: null,
          result: {
            error: err.message,
            transportRetry: true,
            retryAt: new Date(this.o.clock.now().getTime() + backoff).toISOString(),
          },
        })
        return wait ?? executing
      }
      const unknown = await this.actions.transition(row.id, ['executing'], 'unknown', {
        result: {
          error: err.message,
          frameWritten,
          resolveBy: new Date(
            this.o.clock.now().getTime() + (this.o.unknownResolveWindowMs ?? 15 * 60_000),
          ).toISOString(),
        },
      })
      await this.o.audit.append({
        actor: p.actor,
        kind: 'action',
        subjectId: row.id,
        chatId: row.chatId,
        decision: 'unknown',
        detail: { kind: row.kind, messageId, error: err.message },
      })
      return unknown ?? executing
    }
  }

  private toSendCommand(p: PlannedAction): SendCommand | null {
    const chatId = p.chatId
    if (!chatId) return null
    switch (p.kind) {
      case 'send_message':
        return {
          kind: 'send_message',
          chatId,
          text: p.text ?? String(p.payload.text ?? ''),
          ...(p.payload.quotedProviderId ? { quotedProviderId: String(p.payload.quotedProviderId) } : {}),
        }
      case 'react_to_message':
        return {
          kind: 'react_to_message',
          chatId,
          providerId: String(p.payload.providerId),
          emoji: (p.payload.emoji as string | null) ?? null,
        }
      case 'mark_read':
        return { kind: 'mark_read', chatId, providerIds: (p.payload.providerIds as string[]) ?? [] }
      default:
        return null
    }
  }

  /** Observe-class actions that do not touch the wire. */
  private async executeLocal(row: ActionRow, p: PlannedAction): Promise<ActionRow> {
    const executing = await this.actions.transition(row.id, ['approved'], 'executing', {
      attempts: row.attempts + 1,
    })
    if (!executing) return row
    try {
      switch (p.kind) {
        case 'set_label':
          if (p.chatId)
            await this.o.db
              .insert(this.o.tables.chatLabels)
              .values({ chatId: p.chatId, label: String(p.payload.label) })
              .onConflictDoNothing()
          break
        case 'remove_label':
          if (p.chatId)
            await this.o.db
              .delete(this.o.tables.chatLabels)
              .where(
                and(
                  eq(this.o.tables.chatLabels.chatId, p.chatId),
                  eq(this.o.tables.chatLabels.label, String(p.payload.label)),
                ),
              )
          break
        case 'escalate':
          if (p.chatId) {
            await this.o.chats.setAutomation(p.chatId, 'escalated')
            await this.o.db
              .insert(this.o.tables.chatLabels)
              .values({ chatId: p.chatId, label: 'needs-attention' })
              .onConflictDoNothing()
          }
          await this.o.operator.notify({
            kind: 'alert',
            title: `Escalated: ${p.chatId ?? ''}`,
            body: String(p.payload.reason ?? p.text ?? 'chat escalated to human'),
            accountId: this.o.accountId,
            data: { chatId: p.chatId ?? null },
          })
          break
        case 'notify_operator':
          await this.o.operator.notify({
            kind: (p.payload.level as 'alert' | 'info') ?? 'info',
            title: String(p.payload.title ?? 'Notification'),
            body: p.text ?? String(p.payload.text ?? ''),
            accountId: this.o.accountId,
          })
          break
        case 'set_chat_automation':
          if (p.chatId)
            await this.o.chats.setAutomation(
              p.chatId,
              p.payload.state as 'active' | 'paused' | 'escalated',
              (p.payload.pausedUntil as Date | null) ?? null,
            )
          break
        default:
          throw new Error(`no local handler for ${p.kind}`)
      }
      const done = await this.actions.transition(row.id, ['executing'], 'sent', { result: { local: true } })
      await this.o.audit.append({
        actor: p.actor,
        kind: 'action',
        subjectId: row.id,
        chatId: row.chatId,
        ruleId: row.ruleId,
        eventId: row.eventId,
        decision: 'sent',
        detail: { kind: row.kind },
      })
      return done ?? executing
    } catch (e) {
      const failed = await this.actions.transition(row.id, ['executing'], 'failed', {
        result: { error: (e as Error).message },
      })
      return failed ?? executing
    }
  }

  /** Pipeline handler: resolves `unknown` sends and cancels approvals whose trigger changed. */
  pipelineHandler(): EventHandler {
    return async (e: StoredEvent) => {
      if (e.isFromMe && e.providerId && (e.type === 'message.sent' || e.type === 'message.received')) {
        const row = await this.actions.byMessageId(e.providerId)
        if (row && (row.state === 'unknown' || row.state === 'executing')) {
          await this.actions.transition(row.id, ['unknown', 'executing'], 'sent', {
            result: { ...(row.result as object), resolvedBy: 'observed_event', eventId: e.id },
          })
          await this.o.audit.append({
            actor: 'system',
            kind: 'action',
            subjectId: row.id,
            chatId: row.chatId,
            decision: 'sent',
            detail: { resolvedBy: 'observed_event', eventId: e.id },
          })
        }
      }
      if ((e.type === 'message.edited' || e.type === 'message.deleted') && e.chatId && e.providerId) {
        const [msg] = await this.o.db
          .select({ eventId: this.o.tables.messages.eventId })
          .from(this.o.tables.messages)
          .where(
            and(
              eq(this.o.tables.messages.chatId, e.chatId),
              eq(this.o.tables.messages.providerId, e.providerId),
            ),
          )
        if (msg) {
          const n = await this.actions.cancelForTrigger(msg.eventId, `trigger message ${e.type}`)
          if (n)
            this.log.info({ n, providerId: e.providerId }, 'cancelled pending actions for changed trigger')
        }
      }
    }
  }

  /** Periodic maintenance: expire approvals, retry waits that are due, resolve stale unknowns. */
  async sweep(): Promise<{ expired: number; retried: number; unknownFailed: number }> {
    const now = this.o.clock.now()
    let expired = 0
    for (const row of await this.actions.expiredApprovals(now)) {
      if (await this.actions.transition(row.id, ['awaiting_approval'], 'expired')) expired++
    }
    let retried = 0
    for (const row of await this.actions.list({ state: 'retry_wait' })) {
      const retryAt = (row.result as { retryAt?: string } | null)?.retryAt
      if (!retryAt || new Date(retryAt) <= now) {
        await this.execute(row)
        retried++
      }
    }
    let unknownFailed = 0
    for (const row of await this.actions.list({ state: 'unknown' })) {
      const resolveBy = (row.result as { resolveBy?: string } | null)?.resolveBy
      if (resolveBy && new Date(resolveBy) <= now) {
        if (
          await this.actions.transition(row.id, ['unknown'], 'failed', {
            result: { ...(row.result as object), resolvedBy: 'window_elapsed' },
          })
        ) {
          unknownFailed++
          await this.o.operator.notify({
            kind: 'alert',
            title: 'Send outcome unknown, marked failed',
            body: `${row.kind} to ${row.chatId ?? '?'} (action ${row.id}) was never observed on WhatsApp within the resolve window.`,
            accountId: this.o.accountId,
            data: { actionId: row.id },
          })
        }
      }
    }
    if (expired)
      await this.o.operator.notify({
        kind: 'alert',
        title: `${expired} approval(s) expired`,
        body: 'Run `wamcp approvals ls` to review.',
        accountId: this.o.accountId,
      })
    return { expired, retried, unknownFailed }
  }
}
