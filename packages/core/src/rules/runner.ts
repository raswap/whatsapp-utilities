import { and, eq, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Clock } from '../clock.js'
import type { AccountConfig } from '../config/schema.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import { accounts, operatorSettings } from '../db/schema/operator.js'
import type { EventHandler } from '../events/pipeline.js'
import type { ChatType, StoredEvent } from '../events/types.js'
import type { Executor } from '../executor/executor.js'
import { GLOBAL_KILL_KEY } from '../gate/context.js'
import { newId } from '../ids.js'
import type { IdentityStore } from '../store/identities.js'
import type { ChatStore, MessageStore } from '../store/messages.js'
import type { EvalContext } from './conditions.js'
import {
  type CompiledRule,
  compileRule,
  type Evaluation,
  evaluate,
  fetch,
  type Plan,
  type PlanState,
  plan,
  type RememberFactEffect,
  RULE_COUNTER_WINDOW,
  type RuleTrace,
  type ScheduleEffect,
} from './engine.js'
import type { RuleStore, StoredRule } from './store.js'

export interface RunnerDeps {
  db: Db
  tables: AccountTables
  account: AccountConfig
  chats: ChatStore
  messages: MessageStore
  identities: IdentityStore
  executor: Executor
  /** The account's rules and, when given, the operator's global rules. */
  rules: RuleStore
  globalRules?: RuleStore
  clock: Clock
  log: Logger
}

/** Row id of the per-event `not_matched` summary in `rule_traces` (FR-R11). */
export const NOT_MATCHED_SUMMARY_ID = '_not_matched'

interface Loaded {
  stamp: string
  rules: CompiledRule[]
  stored: Map<string, StoredRule>
}

/**
 * Pipeline handler for the rule engine (design §3): plan → fetch → evaluate per event, then apply
 * counter deltas, write traces, hand actions to the executor and run fact and schedule effects.
 */
export class RuleRunner {
  private readonly log: Logger
  private cache: Loaded | null = null

  constructor(private readonly d: RunnerDeps) {
    this.log = d.log.child({ component: 'rules', account: d.account.id })
  }

  handler(): EventHandler {
    return (e) => this.handle(e)
  }

  private storeFor(rule: StoredRule): RuleStore {
    return rule.account === null && this.d.globalRules ? this.d.globalRules : this.d.rules
  }

  /** Enabled, non-suspended rules from both stores; reloaded only when a store's stamp changes. */
  async loadRules(): Promise<CompiledRule[]> {
    return (await this.load()).rules
  }

  private async load(): Promise<Loaded> {
    const stores = [this.d.rules, ...(this.d.globalRules ? [this.d.globalRules] : [])]
    const stamp = (await Promise.all(stores.map((s) => s.stamp()))).join('|')
    if (this.cache && this.cache.stamp === stamp) return this.cache
    const rules: CompiledRule[] = []
    const stored = new Map<string, StoredRule>()
    for (const s of stores) {
      for (const r of await s.listActive()) {
        // Validation compiled every regex and template on save, so compileRule cannot fail here.
        rules.push(compileRule(r))
        stored.set(r.id, r)
      }
    }
    this.cache = { stamp, rules, stored }
    return this.cache
  }

  private async planState(e: StoredEvent): Promise<PlanState> {
    const d = this.d
    const now = d.clock.now()
    const chat = e.chatId ? await d.chats.get(e.chatId) : null
    const labels = e.chatId
      ? (
          await d.db
            .select({ label: d.tables.chatLabels.label })
            .from(d.tables.chatLabels)
            .where(eq(d.tables.chatLabels.chatId, e.chatId))
        ).map((r) => r.label)
      : []
    const senderIds = e.senderId ? [e.senderId, ...(await d.identities.jidsFor(e.senderId))] : []
    const contact = e.senderId ? (await d.identities.contactsByIds([e.senderId]))[0] : undefined
    const [kill] = await d.db
      .select({ v: operatorSettings.value })
      .from(operatorSettings)
      .where(eq(operatorSettings.key, GLOBAL_KILL_KEY))
    const [acct] = await d.db.select().from(accounts).where(eq(accounts.id, d.account.id))
    return {
      accountId: d.account.id,
      phoneNumber: null,
      chatType: (chat?.type as ChatType | undefined) ?? null,
      labels,
      senderIds,
      now,
      zone: d.account.timezone,
      businessHours: d.account.business_hours,
      chat,
      senderBlocked: !e.isFromMe && contact?.blocked === true,
      accountPaused: acct?.paused === true,
      throttled: acct?.throttledUntil != null && acct.throttledUntil > now,
      globalKill: kill?.v === true,
    }
  }

  async handle(e: StoredEvent): Promise<void> {
    const loaded = await this.load()
    if (loaded.rules.length === 0) return
    const state = await this.planState(e)
    const planned = plan(e, loaded.rules, state)
    if (planned.dropped !== null) {
      await this.writeTraces(e, planned, { traces: [], actions: [], effects: [], deltas: [] }, null)
      return
    }
    const ctx = await fetch(e, planned, state, this.d)
    const result = evaluate(e, planned.candidates, ctx)
    await this.applyDeltas(result)
    await this.writeTraces(e, planned, result, ctx)
    const storedOf = (ruleId: string) => loaded.stored.get(ruleId) as StoredRule
    for (const t of result.traces) {
      if (t.outcome === 'error') await this.fail(storedOf(t.ruleId), String(t.reason), 'rule threw')
      else if (t.outcome === 'matched' && storedOf(t.ruleId).errorCount > 0) {
        await this.storeFor(storedOf(t.ruleId)).clearErrors(t.ruleId)
        this.cache = null
      }
    }
    // One rule's failure never blocks the others: each action and effect is guarded on its own.
    const guard = async (ruleId: string, what: string, run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (err) {
        await this.fail(storedOf(ruleId), (err as Error).message, what)
      }
    }
    for (const a of result.actions)
      await guard(a.ruleId as string, 'action submit failed', () => this.d.executor.submit(a))
    for (const f of result.effects)
      await guard(f.ruleId, `${f.kind} failed`, () =>
        f.kind === 'remember_fact' ? this.rememberFact(f) : this.schedule(f),
      )
  }

  /** Counts the error on the rule (five strikes suspend it, store.ts) and drops the cache so a suspension takes effect. */
  private async fail(rule: StoredRule, reason: string, what: string) {
    this.log.error({ rule: rule.id, err: reason }, what)
    await this.storeFor(rule).markError(rule.id, reason)
    this.cache = null
  }

  private async applyDeltas(result: Evaluation) {
    const { counters } = this.d.tables
    for (const delta of result.deltas) {
      await this.d.db
        .insert(counters)
        .values({ key: delta.counter, windowStart: RULE_COUNTER_WINDOW, value: delta.by })
        .onConflictDoUpdate({
          target: [counters.key, counters.windowStart],
          set: { value: sql`${counters.value} + ${delta.by}` },
        })
    }
  }

  private async writeTraces(e: StoredEvent, planned: Plan, result: Evaluation, ctx: EvalContext | null) {
    const { ruleTraces } = this.d.tables
    const snapshot = ctx
      ? {
          now: ctx.now.toISOString(),
          chatState: ctx.chat?.automationState ?? null,
          labels: ctx.labels,
          lastHumanReplyAt: ctx.lastHumanReplyAt?.toISOString() ?? null,
          counters: ctx.counters,
          facts: ctx.facts,
          deniedKinds: ctx.deniedKinds,
          suppressed: ctx.suppressed,
        }
      : { dropped: planned.dropped }
    const createdAt = this.d.clock.now()
    const rows = result.traces
      .filter((t) => t.outcome !== 'not_matched')
      .map((t) => ({
        eventId: e.id,
        ruleId: t.ruleId,
        outcome: t.outcome,
        trace: t,
        stateSnapshot: snapshot,
        createdAt,
      }))
    const notMatched = [
      ...planned.skipped,
      ...result.traces
        .filter((t) => t.outcome === 'not_matched')
        .map((t) => ({ ruleId: t.ruleId, reason: t.reason ?? '' })),
    ]
    if (notMatched.length)
      rows.push({
        eventId: e.id,
        ruleId: NOT_MATCHED_SUMMARY_ID,
        outcome: 'not_matched',
        trace: { rules: notMatched } as unknown as RuleTrace,
        stateSnapshot: snapshot,
        createdAt,
      })
    if (rows.length) await this.d.db.insert(ruleTraces).values(rows).onConflictDoNothing()
  }

  /** `remember_fact`: upsert into `facts` with `source = rule:<id>` and the TTL (design §5). */
  private async rememberFact(f: RememberFactEffect) {
    const { facts } = this.d.tables
    const values = {
      value: f.value,
      source: `rule:${f.ruleId}`,
      createdAt: this.d.clock.now(),
      expiresAt: f.expiresAt,
    }
    await this.d.db
      .insert(facts)
      .values({ id: newId(), subjectType: f.subjectType, subjectId: f.subjectId, key: f.key, ...values })
      .onConflictDoUpdate({ target: [facts.subjectType, facts.subjectId, facts.key], set: values })
  }

  /** `schedule`: a `delayed_action` job bound to (event_id, body_hash); the scheduler that fires it is PR 3. */
  private async schedule(s: ScheduleEffect) {
    const { scheduledJobs } = this.d.tables
    const [dup] = await this.d.db
      .select({ id: scheduledJobs.id })
      .from(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.ruleId, s.ruleId),
          eq(scheduledJobs.eventId, s.eventId),
          sql`${scheduledJobs.payload}->>'index' = ${String(s.index)}`,
        ),
      )
    if (dup) return
    await this.d.db.insert(scheduledJobs).values({
      id: newId(),
      ruleId: s.ruleId,
      kind: 'delayed_action',
      runAt: s.runAt,
      chatId: s.chatId,
      eventId: s.eventId,
      bodyHash: s.bodyHash,
      payload: { index: s.index, ...s.payload },
      createdAt: this.d.clock.now(),
    })
  }
}
