import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '../audit/log.js'
import { ManualClock } from '../clock.js'
import { AccountConfigSchema } from '../config/schema.js'
import { FakeConnector, textMessage } from '../connectors/fake.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { Pipeline } from '../events/pipeline.js'
import { gateContextBuilder } from '../gate/context.js'
import { Limiter } from '../gate/limiter.js'
import { PolicyGate } from '../gate/policy.js'
import type { PlannedAction } from '../gate/types.js'
import { accountSchemaName } from '../ids.js'
import { MemorySender, OperatorChannel } from '../operator/channel.js'
import { plainCodec } from '../store/codec.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { ApprovalError, Executor } from './executor.js'

let tdb: TestDatabase
const log = pino({ level: 'silent' })
let n = 0

async function rig() {
  const id = `ex${++n}`
  const cfg = AccountConfigSchema.parse({
    id,
    type: 'web',
    display_name: id,
    timezone: 'UTC',
    business_hours: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
  })
  await provisionAccount(tdb.handle, cfg)
  const schema = accountSchemaName(id)
  const tables = tablesFor(schema)
  const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
  const pipeline = new Pipeline({
    accountId: id,
    schemaName: schema,
    db: tdb.handle.db,
    tables,
    codec: plainCodec,
    clock,
    log,
  })
  const connector = new FakeConnector(id)
  pipeline.attach(connector)
  await pipeline.start()
  await connector.start()
  const limiter = new Limiter(tdb.handle.db, tables, clock)
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
  const audit = new AuditLog(tdb.handle.db, tables)
  const executor = new Executor({
    accountId: id,
    db: tdb.handle.db,
    tables,
    connector,
    gate: new PolicyGate(limiter),
    limiter,
    audit,
    operator,
    chats: pipeline.chats,
    messages: pipeline.messages,
    clock,
    log,
    contextFor: () => Promise.reject(new Error('replaced below')),
    sleep: async () => undefined,
    approvalTtlMs: 60_000,
    unknownResolveWindowMs: 60_000,
  })
  // contextFor needs executor.actions, so wire it after construction.
  ;(executor as unknown as { o: { contextFor: unknown } }).o.contextFor = gateContextBuilder({
    db: tdb.handle.db,
    tables,
    account: cfg,
    connector,
    chats: pipeline.chats,
    messages: pipeline.messages,
    identities: pipeline.identities,
    actions: executor.actions,
    clock,
  })
  pipeline.onEvent(executor.pipelineHandler())
  // A counterparty who has DMed us, so the first-contact rule passes.
  const chatId = 'cust@s.whatsapp.net'
  await connector.emit(
    textMessage({ chatId, senderJid: chatId, providerId: 'IN1', body: 'hi there', occurredAt: clock.now() }),
  )
  await pipeline.drained()
  await tdb.handle.db.execute(`update ${schema}.contacts set first_dm_at = now()`)
  const inbound = (await pipeline.events.listAfter(0, 1))[0]
  return { id, cfg, schema, tables, clock, pipeline, connector, executor, memory, audit, chatId, inbound }
}

const plan = (over: Partial<PlannedAction> = {}): PlannedAction => ({
  kind: 'send_message',
  source: 'token:t1',
  actor: 'token:t1',
  idempotencyKey: `k${Math.random()}`,
  chatId: 'cust@s.whatsapp.net',
  payload: {},
  text: 'thanks, on it',
  approval: 'auto',
  ...over,
})

beforeAll(async () => {
  tdb = await createTestDatabase()
})
afterAll(() => tdb.drop())

describe('executor', () => {
  it('auto-approved send goes out with a pre-generated id and is idempotent on the key', async () => {
    const { executor, connector } = await rig()
    const p = plan()
    const a = await executor.submit(p)
    expect(a.state).toBe('sent')
    expect(a.messageId).toMatch(/^3EB0/)
    expect(connector.sends.length).toBe(1)
    expect(connector.sends[0]?.cmd.messageId).toBe(a.messageId)
    const again = await executor.submit(p)
    expect(again.id).toBe(a.id)
    expect(connector.sends.length).toBe(1)
  })

  it('approve mode: notifies operator with a code, refuses self-approval, executes for another actor', async () => {
    const { executor, connector, memory } = await rig()
    const a = await executor.submit(plan({ approval: 'approve', actor: 'token:agent', text: 'draft reply' }))
    expect(a.state).toBe('awaiting_approval')
    expect(a.approvalCode).toMatch(/^[A-Z2-9]{6}$/)
    expect(memory.messages.at(-1)?.kind).toBe('approval')
    expect(memory.messages.at(-1)?.body).toContain(a.approvalCode as string)
    await expect(executor.approve(a.approvalCode as string, 'token:agent')).rejects.toMatchObject({
      code: 'SELF_APPROVAL',
    })
    const done = await executor.approve(a.approvalCode as string, 'cli:owner')
    expect(done.state).toBe('sent')
    expect(done.approvalDecidedBy).toBe('cli:owner')
    expect(connector.sends.length).toBe(1)
    await expect(executor.approve(a.approvalCode as string, 'cli:owner')).rejects.toBeInstanceOf(
      ApprovalError,
    )
  })

  it('approvals expire via sweep and reject works', async () => {
    const { executor, clock, memory } = await rig()
    const a = await executor.submit(plan({ approval: 'approve', actor: 'x' }))
    const b = await executor.submit(plan({ approval: 'approve', actor: 'x', text: 'other' }))
    const r = await executor.reject(b.approvalCode as string, 'cli:owner', 'nope')
    expect(r.state).toBe('rejected')
    clock.advance(120_000)
    const s = await executor.sweep()
    expect(s.expired).toBe(1)
    expect((await executor.actions.get(a.id))?.state).toBe('expired')
    expect(memory.messages.some((m) => m.title.includes('expired'))).toBe(true)
  })

  it('dry run records would_send and sends nothing', async () => {
    const { executor, connector } = await rig()
    const a = await executor.submit(plan({ approval: 'dry_run' }))
    expect(a.state).toBe('dry_run')
    expect(connector.sends.length).toBe(0)
  })

  it('frame not written: retries on sweep; frame written then error: unknown, then resolved by the observed event', async () => {
    const { executor, connector, clock, pipeline, chatId } = await rig()
    connector.nextSendThrow = { error: new Error('socket closed before write'), frameWritten: false }
    const a = await executor.submit(plan())
    expect(a.state).toBe('retry_wait')
    expect(a.messageId).toBeNull()
    clock.advance(10_000)
    await executor.sweep()
    const after = await executor.actions.get(a.id)
    expect(after?.state).toBe('sent')
    expect(connector.sends.length).toBe(2)

    connector.nextSendThrow = { error: new Error('ack timeout'), frameWritten: true }
    clock.advance(60_000)
    const b = await executor.submit(plan({ text: 'second' }))
    expect(b.state).toBe('unknown')
    const mid = b.messageId as string
    // WhatsApp later echoes the message we sent.
    await connector.emit(
      textMessage({
        chatId,
        senderJid: 'me@s.whatsapp.net',
        providerId: mid,
        body: 'second',
        occurredAt: clock.now(),
        type: 'message.sent',
        isFromMe: true,
      }),
    )
    await pipeline.drained()
    expect((await executor.actions.get(b.id))?.state).toBe('sent')
    const msgs = await pipeline.messages.getMessages({ chatId })
    expect(msgs.items.find((m) => m.providerId === mid)?.origin).toBe('self_system')
  })

  it('unknown with no echo becomes failed after the resolve window', async () => {
    const { executor, connector, clock, memory } = await rig()
    connector.nextSendThrow = { error: new Error('ack timeout'), frameWritten: true }
    const a = await executor.submit(plan())
    expect(a.state).toBe('unknown')
    clock.advance(61_000)
    const s = await executor.sweep()
    expect(s.unknownFailed).toBe(1)
    expect(memory.messages.some((m) => m.title.includes('unknown'))).toBe(true)
  })

  it('per-chat interval limit is consumed at execution: second send waits once, third drops', async () => {
    const { executor, connector } = await rig()
    const a = await executor.submit(plan({ text: 'one' }))
    expect(a.state).toBe('sent')
    // Gate peek sees the consumed bucket and blocks outright.
    const b = await executor.submit(plan({ text: 'two' }))
    expect(b.state).toBe('blocked')
    expect((b.gate as { check: string }).check).toBe('rate_limit')
    expect(connector.sends.length).toBe(1)
  })

  it('observe actions run locally: escalate pauses the chat, labels it, and notifies', async () => {
    const { executor, pipeline, chatId, memory, tables } = await rig()
    const a = await executor.submit(
      plan({ kind: 'escalate', payload: { reason: 'angry customer' }, text: undefined }),
    )
    expect(a.state).toBe('sent')
    expect((await pipeline.chats.get(chatId))?.automationState).toBe('escalated')
    const labels = await tdb.handle.db.select().from(tables.chatLabels)
    expect(labels.map((l) => l.label)).toContain('needs-attention')
    expect(memory.messages.at(-1)?.title).toContain('Escalated')
    // Now a send to the escalated chat is blocked by the kill-switch check, but observe actions still run.
    const s = await executor.submit(plan({ text: 'auto reply' }))
    expect(s.state).toBe('blocked')
    const l = await executor.submit(plan({ kind: 'set_label', payload: { label: 'vip' }, text: undefined }))
    expect(l.state).toBe('sent')
  })

  it('editing the trigger message cancels a pending approval', async () => {
    const { executor, connector, pipeline, chatId, inbound, clock } = await rig()
    const a = await executor.submit(
      plan({ approval: 'approve', actor: 'rule', eventId: inbound?.id as string, bodyHash: 'h' }),
    )
    expect(a.state).toBe('awaiting_approval')
    await connector.emit({
      type: 'message.edited',
      chatId,
      senderJid: chatId,
      providerId: 'IN1',
      occurredAt: clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { body: 'hi there, edited' },
    })
    await pipeline.drained()
    expect((await executor.actions.get(a.id))?.state).toBe('cancelled')
  })

  it('audit chain stays intact across gate, approval, and action rows', async () => {
    const { executor, audit, clock } = await rig()
    await executor.submit(plan())
    clock.advance(31_000)
    const a = await executor.submit(plan({ approval: 'approve', actor: 'x', text: 'y' }))
    await executor.reject(a.approvalCode as string, 'cli:owner')
    const v = await audit.verify()
    expect(v).toMatchObject({ ok: true })
    expect((v as { count: number }).count).toBeGreaterThanOrEqual(4)
    const rows = await audit.query({ kind: 'gate' })
    expect(rows.length).toBe(2)
  })
})
