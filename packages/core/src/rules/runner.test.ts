import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '../clock.js'
import { AccountConfigSchema } from '../config/schema.js'
import { FakeConnector, textMessage } from '../connectors/fake.js'
import { provisionAccount } from '../db/provision.js'
import { operatorRules, operatorRuleVersions } from '../db/schema/operator.js'
import type { StoredEvent } from '../events/types.js'
import { MemorySender, OperatorChannel } from '../operator/channel.js'
import { OperatorState } from '../operator/state.js'
import { type AccountRuntime, createAccountRuntime } from '../runtime.js'
import { plainCodec } from '../store/codec.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { importRules } from './import.js'
import { NOT_MATCHED_SUMMARY_ID, RuleRunner } from './runner.js'
import { MAX_CONSECUTIVE_ERRORS, RuleStore } from './store.js'

/** Reads a jsonb column of a row that must exist. */
const field = <T>(
  row: { trace?: unknown; stateSnapshot?: unknown; payload?: unknown; gate?: unknown } | undefined,
  k: 'trace' | 'stateSnapshot' | 'payload' | 'gate',
): T => {
  if (!row) throw new Error('missing row')
  return row[k] as T
}

const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rules', 'starter')
const log = pino({ level: 'silent' })
let tdb: TestDatabase
let n = 0

async function rig() {
  const id = `rr${++n}`
  const cfg = AccountConfigSchema.parse({
    id,
    type: 'web',
    display_name: 'Rig',
    timezone: 'UTC',
    business_hours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  })
  await provisionAccount(tdb.handle, cfg)
  const clock = new ManualClock(new Date('2026-06-01T10:00:00Z')) // Monday, in business hours
  const memory = new MemorySender()
  const operator = new OperatorChannel({
    config: {
      numbers: [],
      channels: [],
      rate_limit_per_minute: 100,
      digest_after: 10,
      digest_window_minutes: 1,
    },
    env: {},
    log,
    clock,
    extraSenders: [memory],
  })
  const connector = new FakeConnector(id)
  const globalRules = new RuleStore(
    tdb.handle.db,
    { rules: operatorRules, ruleVersions: operatorRuleVersions },
    { accountId: null, clock },
  )
  // The operator store is shared by every rig in this database: start each test with no global rule enabled.
  for (const g of await globalRules.list()) if (g.enabled) await globalRules.disable(g.id)
  const rt: AccountRuntime = createAccountRuntime({
    handle: tdb.handle,
    config: cfg,
    connector,
    codec: plainCodec,
    clock,
    log,
    operator,
    globalRules,
    sleep: async () => undefined,
  })
  await rt.start()
  const tables = rt.pipeline.events
    ? (await import('../db/schema/account.js')).tablesFor(rt.schemaName)
    : null
  if (!tables) throw new Error('no tables')
  const chatId = 'cust@s.whatsapp.net'
  const say = async (body: string, over: Partial<Parameters<typeof textMessage>[0]> = {}) => {
    const providerId = `M${Date.now()}${Math.random()}`
    await connector.emit(
      textMessage({
        chatId,
        senderJid: chatId,
        providerId,
        body,
        occurredAt: clock.now(),
        identityHints: [{ jid: chatId, kind: 'phone', pushName: 'Asha' }],
        ...over,
      }),
    )
    await rt.pipeline.drained()
    const evs = await rt.pipeline.events.listAfter(0, 1000)
    return evs.find((e) => e.providerId === providerId) as StoredEvent
  }
  const traces = (eventId: string) =>
    tdb.handle.db.select().from(tables.ruleTraces).where(eq(tables.ruleTraces.eventId, eventId))
  return { id, cfg, clock, memory, connector, rt, globalRules, tables, chatId, say, traces }
}

beforeAll(async () => {
  tdb = await createTestDatabase()
})
afterAll(() => tdb.drop())

describe('rule runner end to end (design §8 PR 2)', () => {
  it('urgent-notify labels and notifies; away-ack sends outside business hours once per chat per day into approval', async () => {
    const r = await rig()
    // Import the starter rules into the operator store; both are global (no scope.account).
    const imported = await importRules(STARTER, {
      stores: { global: r.globalRules, accounts: new Map([[r.id, r.rt.rules]]) },
      actor: 'test',
    })
    expect(imported.ok).toBe(true)
    // Nothing enabled yet: an event produces no traces and no actions.
    const quiet = await r.say('hello')
    expect(await r.traces(quiet.id)).toEqual([])
    await r.globalRules.enable('urgent-notify')
    await r.globalRules.enable('away-ack')

    // In business hours: urgent-notify fires (observe actions, auto), away-ack does not.
    const urgent = await r.say('This is *URGENT*, please call')
    const labels = await tdb.handle.db.select().from(r.tables.chatLabels)
    expect(labels.map((l) => l.label)).toEqual(['needs-attention'])
    expect(r.memory.messages.at(-1)).toMatchObject({
      kind: 'info',
      title: 'Urgent message from Asha',
      body: 'This is \\*URGENT\\*, please call',
    })
    const t1 = await r.traces(urgent.id)
    expect(t1.map((t) => [t.ruleId, t.outcome]).sort()).toEqual([
      [NOT_MATCHED_SUMMARY_ID, 'not_matched'],
      ['urgent-notify', 'matched'],
    ])
    expect(
      field<{ rules: unknown[] }>(
        t1.find((t) => t.ruleId === NOT_MATCHED_SUMMARY_ID),
        'trace',
      ).rules,
    ).toEqual([{ ruleId: 'away-ack', reason: 'conditions' }])
    const matchedTrace = t1.find((t) => t.ruleId === 'urgent-notify')?.trace as {
      conditions: unknown[]
      actions: unknown[]
    }
    expect(matchedTrace.conditions).toEqual([{ name: 'any_of.0.keywords', passed: true, detail: 'urgent' }])
    expect(matchedTrace.actions).toEqual([
      { index: 0, kind: 'set_label', status: 'planned' },
      { index: 1, kind: 'notify_operator', status: 'planned' },
    ])
    const sent = await r.rt.executor.actions.list({ state: 'sent' })
    expect(sent.map((a) => [a.kind, a.source, a.idempotencyKey])).toEqual([
      ['set_label', 'rule:urgent-notify', `rule:urgent-notify:${urgent.id}:0`],
      ['notify_operator', 'rule:urgent-notify', `rule:urgent-notify:${urgent.id}:1`],
    ])
    const counters = await tdb.handle.db.select().from(r.tables.counters)
    expect(counters.map((c) => [c.key, c.value])).toEqual([['rule:urgent-notify:matches', 1]])

    // Outside business hours: away-ack plans a send; its policy is approve, so it waits for a human.
    r.clock.set(new Date('2026-06-01T20:00:00Z'))
    const evening = await r.say('anyone there?')
    const pending = await r.rt.executor.actions.list({ state: 'awaiting_approval' })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      kind: 'send_message',
      ruleId: 'away-ack',
      eventId: evening.id,
      idempotencyKey: `rule:away-ack:${evening.id}:0`,
    })
    expect(field<{ text: string }>(pending[0], 'payload').text).toContain("I'm away right now")
    expect(
      field<{ trace: Array<{ check: string; reason?: string }> }>(pending[0], 'gate').trace,
    ).toContainEqual({
      check: 'quiet_hours',
      passed: true,
      reason: 'outside business hours; queued for human approval',
    })
    expect(r.memory.messages.at(-1)).toMatchObject({ kind: 'approval' })
    expect((await r.traces(evening.id)).map((t) => [t.ruleId, t.outcome]).sort()).toEqual([
      [NOT_MATCHED_SUMMARY_ID, 'not_matched'],
      ['away-ack', 'matched'],
    ])
    expect(r.connector.sends).toHaveLength(0)

    // Same chat, same day: the per-chat 1/1d rate limit skips the send; the trace says why.
    r.clock.advance(60_000)
    const again = await r.say('still there?')
    expect(await r.rt.executor.actions.list({ state: 'awaiting_approval' })).toHaveLength(1)
    const t3 = (await r.traces(again.id)).find((t) => t.ruleId === 'away-ack')?.trace as {
      actions: unknown[]
    }
    expect(t3.actions).toEqual([{ index: 0, kind: 'send_message', status: 'rate_limited', reason: 'chat' }])
    // Another contact gets its own away reply.
    const other = 'other@s.whatsapp.net'
    await r.say('hi', { chatId: other, senderJid: other, identityHints: [] })
    expect(await r.rt.executor.actions.list({ state: 'awaiting_approval' })).toHaveLength(2)
    // A human approving after hours is the quiet-hours override: the send goes out.
    const code = pending[0]?.approvalCode as string
    const done = await r.rt.executor.approve(code, 'cli:owner')
    expect(done.state).toBe('sent')
    expect(r.connector.sends.map((s) => s.cmd.kind)).toEqual(['set_typing', 'send_message'])
  })

  it('suppresses sends when the chat is paused or the global kill is on; observe actions still run', async () => {
    const r = await rig()
    await r.rt.rules.save(
      'ack',
      `id: ack\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\nactions:\n  - send_message:\n      text: "got it"\n  - set_label: seen\non_match: continue\npolicy:\n  approval: auto\n`,
      'test',
    )
    await r.say('warm up') // first-contact and a baseline send
    expect(r.connector.sends.map((s) => s.cmd.kind)).toEqual(['send_message'])
    await r.rt.pipeline.chats.setAutomation(r.chatId, 'paused')
    r.clock.advance(60_000)
    const e = await r.say('paused now')
    const [t] = await r.traces(e.id)
    expect(t).toMatchObject({ ruleId: 'ack', outcome: 'matched' })
    expect(field<{ actions: unknown[] }>(t, 'trace').actions).toEqual([
      { index: 0, kind: 'send_message', status: 'suppressed_by_state', reason: 'chat automation is paused' },
      { index: 1, kind: 'set_label', status: 'planned' },
    ])
    expect(field<{ chatState: string }>(t, 'stateSnapshot').chatState).toBe('paused')
    expect(r.connector.sends).toHaveLength(1)
    // a rule with only a send is suppressed_by_state as a whole
    await r.rt.rules.save(
      'only',
      `id: only\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\nactions:\n  - send_message:\n      text: "x"\npolicy:\n  approval: auto\n`,
      'test',
    )
    await r.rt.rules.disable('ack')
    await new OperatorState(tdb.handle.db).setGlobalKill(true)
    r.clock.advance(60_000)
    const k = await r.say('killed')
    expect((await r.traces(k.id)).map((x) => [x.ruleId, x.outcome])).toEqual([
      ['only', 'suppressed_by_state'],
    ])
    expect((await r.traces(k.id))[0]?.stateSnapshot).toMatchObject({ suppressed: 'global kill switch is on' })
    await new OperatorState(tdb.handle.db).setGlobalKill(false)
    // account paused, then throttled: both short-circuit the same way
    await r.rt.setPaused(true, 'test')
    r.clock.advance(60_000)
    const p = await r.say('paused account')
    expect((await r.traces(p.id))[0]?.stateSnapshot).toMatchObject({ suppressed: 'account is paused' })
    await r.rt.setPaused(false, 'test')
    const state = new OperatorState(tdb.handle.db)
    await state.setThrottled(r.id, new Date(r.clock.now().getTime() + 3_600_000), 'spam signal')
    r.clock.advance(60_000)
    const th = await r.say('throttled account')
    expect((await r.traces(th.id))[0]?.stateSnapshot).toMatchObject({ suppressed: 'account is throttled' })
    await state.setThrottled(r.id, null, null)
    // a human reply from the phone shows up in the snapshot
    await r.connector.emit(
      textMessage({
        chatId: r.chatId,
        senderJid: 'me@s.whatsapp.net',
        providerId: 'PHONE1',
        body: 'typed on my phone',
        occurredAt: r.clock.now(),
        type: 'message.sent',
        isFromMe: true,
      }),
    )
    r.clock.advance(60_000)
    const after = await r.say('after human reply')
    expect((await r.traces(after.id))[0]?.stateSnapshot).toMatchObject({
      suppressed: 'chat automation is paused',
      lastHumanReplyAt: new Date(r.clock.now().getTime() - 60_000).toISOString(),
    })
  })

  it('handles chat-less events and marks the rule when the executor rejects an action', async () => {
    const r = await rig()
    await r.rt.rules.save(
      'cu',
      `id: cu\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: contact.updated\nactions:\n  - set_label: renamed\n`,
      'test',
    )
    await r.connector.emit({
      type: 'contact.updated',
      senderJid: r.chatId,
      occurredAt: r.clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { pushName: 'New Name' },
    })
    await r.rt.pipeline.drained()
    const [e] = await r.rt.pipeline.events.listAfter(0, 1)
    expect(await r.traces(e?.id as string)).toMatchObject([
      { ruleId: 'cu', outcome: 'matched', stateSnapshot: { chatState: null, labels: [] } },
    ])
    const [a] = await r.rt.executor.actions.list()
    expect(a).toMatchObject({ kind: 'set_label', chatId: null, state: 'sent' })
    const failing = new RuleRunner({
      db: tdb.handle.db,
      tables: r.tables,
      account: r.cfg,
      chats: r.rt.pipeline.chats,
      messages: r.rt.pipeline.messages,
      identities: r.rt.pipeline.identities,
      executor: {
        submit: () => Promise.reject(new Error('executor down')),
      } as unknown as typeof r.rt.executor,
      rules: r.rt.rules,
      globalRules: r.globalRules,
      clock: r.clock,
      log,
    })
    await failing.handle(e as StoredEvent)
    expect(await r.rt.rules.get('cu')).toMatchObject({ errorCount: 1, suspendedReason: null })
  })

  it('deny union and specificity ordering across the account and operator stores', async () => {
    const r = await rig()
    await r.globalRules.save(
      'never-react',
      'id: never-react\nenabled: true\nwhen:\n  event: message.received\nnever: [react_to_message]\nactions:\n  - set_label: global-seen\non_match: continue\n',
      'test',
    )
    await r.rt.rules.save(
      'react',
      `id: react\nenabled: true\nscope:\n  account: ${r.id}\n  chat_type: dm\nwhen:\n  event: message.received\nactions:\n  - react_to_message: { emoji: "👍" }\n  - set_label: local-seen\npolicy:\n  approval: auto\n`,
      'test',
    )
    const e = await r.say('hey')
    const ts = await r.traces(e.id)
    const react = ts.find((t) => t.ruleId === 'react')
    expect(react?.outcome).toBe('matched')
    expect(field<{ actions: unknown[] }>(react, 'trace').actions).toEqual([
      {
        index: 0,
        kind: 'react_to_message',
        status: 'denied',
        reason: 'react_to_message denied by a scope-matched rule',
      },
      { index: 1, kind: 'set_label', status: 'planned' },
    ])
    // the more specific account rule ran first and stopped the walk (default stop: it has a counterparty send)
    expect(ts.find((t) => t.ruleId === NOT_MATCHED_SUMMARY_ID)?.trace).toEqual({
      rules: [{ ruleId: 'never-react', reason: 'stopped by react' }],
    })
    expect(field<{ deniedKinds: string[] }>(react, 'stateSnapshot').deniedKinds).toEqual(['react_to_message'])
    expect(r.connector.sends).toHaveLength(0)
  })

  it('remember_fact writes facts with source and TTL; schedule inserts a delayed_action job; replays are idempotent', async () => {
    const r = await rig()
    await r.rt.rules.save(
      'memo',
      `id: memo\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\nactions:\n  - remember_fact: { key: last_words, value: "{{message.body}}", ttl: 2h }\n  - remember_fact: { key: chat_seen, value: "{{now.iso}}", subject: chat }\n  - schedule:\n      after: 10m\n      action:\n        send_message:\n          text: "Still need help, {{contact.display_name}}?"\npolicy:\n  approval: approve\n`,
      'test',
    )
    const e = await r.say('call me back')
    const facts = await tdb.handle.db.select().from(r.tables.facts)
    expect(
      facts.map((f) => [f.subjectType, f.key, f.value, f.source, f.expiresAt?.toISOString() ?? null]).sort(),
    ).toEqual([
      ['chat', 'chat_seen', r.clock.now().toISOString(), 'rule:memo', null],
      [
        'contact',
        'last_words',
        'call me back',
        'rule:memo',
        new Date(r.clock.now().getTime() + 7_200_000).toISOString(),
      ],
    ])
    const jobs = await tdb.handle.db.select().from(r.tables.scheduledJobs)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      ruleId: 'memo',
      kind: 'delayed_action',
      chatId: r.chatId,
      eventId: e.id,
      runAt: new Date(r.clock.now().getTime() + 600_000),
      claimedAt: null,
    })
    expect(jobs[0]?.bodyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(jobs[0]?.payload as { index: number; planned: { text: string; approval: string } }).toMatchObject({
      index: 2,
      planned: { text: 'Still need help, Asha?', approval: 'approve', idempotencyKey: `rule:memo:${e.id}:2` },
    })
    // The next message overwrites the contact fact; facts are read back into the context.
    await r.rt.rules.save(
      'gold',
      `id: gold\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\n  facts: { last_words: "call me back" }\nactions:\n  - set_label: callback\n`,
      'test',
    )
    r.clock.advance(1000)
    const e2 = await r.say('thanks')
    expect((await r.traces(e2.id)).map((t) => [t.ruleId, t.outcome]).sort()).toEqual([
      ['gold', 'matched'],
      ['memo', 'matched'],
    ])
    expect(
      (await tdb.handle.db.select().from(r.tables.facts)).find((f) => f.key === 'last_words')?.value,
    ).toBe('thanks')
    // Replaying the same event (restart) adds no second job, action or trace.
    const runner = new RuleRunner({
      db: tdb.handle.db,
      tables: r.tables,
      account: r.cfg,
      chats: r.rt.pipeline.chats,
      messages: r.rt.pipeline.messages,
      identities: r.rt.pipeline.identities,
      executor: r.rt.executor,
      rules: r.rt.rules,
      globalRules: r.globalRules,
      clock: r.clock,
      log,
    })
    await runner.handle(e2)
    expect(await tdb.handle.db.select().from(r.tables.scheduledJobs)).toHaveLength(2)
    // memo's own fact write changed what `gold` sees, so the replay adds a not_matched summary and nothing else.
    expect((await r.traces(e2.id)).map((t) => t.ruleId).sort()).toEqual([
      NOT_MATCHED_SUMMARY_ID,
      'gold',
      'memo',
    ])
    expect(await r.rt.executor.actions.list()).toHaveLength(1)
  })

  it('a rule that throws is traced as error and suspended after five strikes; a match clears the count', async () => {
    const r = await rig()
    // remember_fact with a contact subject on an event that has no sender throws in evaluate.
    await r.rt.rules.save(
      'bad',
      `id: bad\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: group.subject_changed\nactions:\n  - remember_fact: { key: k, value: v, subject: contact }\n`,
      'test',
    )
    const emitSubject = async (i: number) => {
      await r.connector.emit({
        type: 'group.subject_changed',
        chatId: '120@g.us',
        providerId: `S${i}`,
        occurredAt: r.clock.now(),
        isFromMe: false,
        source: 'live',
        payload: { subject: `S${i}` },
      })
      await r.rt.pipeline.drained()
    }
    await emitSubject(0)
    const evs = await r.rt.pipeline.events.listAfter(0, 10)
    const [t] = await r.traces(evs[0]?.id as string)
    expect(t).toMatchObject({ ruleId: 'bad', outcome: 'error' })
    expect(field<{ reason: string }>(t, 'trace').reason).toBe('remember_fact: event has no contact subject')
    expect((await r.rt.rules.get('bad'))?.errorCount).toBe(1)
    for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i++) await emitSubject(i)
    expect(await r.rt.rules.get('bad')).toMatchObject({
      errorCount: 5,
      suspendedReason: 'remember_fact: event has no contact subject',
    })
    // Suspended: the rule is no longer loaded, so the next event has no traces.
    await emitSubject(9)
    const last = (await r.rt.pipeline.events.listAfter(0, 10)).at(-1) as StoredEvent
    expect(await r.traces(last.id)).toEqual([])
    // A rule with errors that then matches has its count cleared.
    await r.rt.rules.save(
      'flaky',
      `id: flaky\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\nactions:\n  - set_label: ok\n`,
      'test',
    )
    await r.rt.rules.markError('flaky', 'earlier')
    expect((await r.rt.rules.get('flaky'))?.errorCount).toBe(1)
    await r.say('hello')
    expect((await r.rt.rules.get('flaky'))?.errorCount).toBe(0)
  })

  it('drops events from a blocked sender before rules and records one summary row', async () => {
    const r = await rig()
    await r.rt.rules.save(
      'tag',
      `id: tag\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\nactions:\n  - set_label: seen\n`,
      'test',
    )
    const first = await r.say('hello')
    await tdb.handle.db
      .update(r.tables.contacts)
      .set({ blocked: true })
      .where(eq(r.tables.contacts.id, first.senderId as string))
    const blocked = await r.say('spam')
    expect(await r.traces(blocked.id)).toMatchObject([
      {
        ruleId: NOT_MATCHED_SUMMARY_ID,
        outcome: 'not_matched',
        trace: { rules: [{ ruleId: 'tag', reason: 'sender_blocked' }] },
        stateSnapshot: { dropped: 'sender_blocked' },
      },
    ])
    expect(await r.rt.executor.actions.list()).toHaveLength(1)
  })

  it('reloads rules only when a store stamp changes and tolerates a store without global rules', async () => {
    const r = await rig()
    const runner = new RuleRunner({
      db: tdb.handle.db,
      tables: r.tables,
      account: r.cfg,
      chats: r.rt.pipeline.chats,
      messages: r.rt.pipeline.messages,
      identities: r.rt.pipeline.identities,
      executor: r.rt.executor,
      rules: r.rt.rules,
      clock: r.clock,
      log,
    })
    expect(await runner.loadRules()).toEqual([])
    const first = await runner.loadRules()
    await r.rt.rules.save(
      'late',
      `id: late\nenabled: true\nscope:\n  account: ${r.id}\nwhen:\n  event: message.received\nactions:\n  - set_label: late\n`,
      'test',
    )
    const second = await runner.loadRules()
    expect(second.map((x) => x.id)).toEqual(['late'])
    expect(await runner.loadRules()).toBe(second)
    expect(first).not.toBe(second)
    await r.rt.rules.disable('late')
    expect(await runner.loadRules()).toEqual([])
  })
})
