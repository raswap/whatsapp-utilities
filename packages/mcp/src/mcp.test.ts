import { type ServerType, serve } from '@hono/node-server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  AccountConfigSchema,
  createAccountRuntime,
  FakeConnector,
  ManualClock,
  MemorySender,
  OperatorChannel,
  OperatorState,
  plainCodec,
  provisionAccount,
  TokenStore,
  textMessage,
} from '@wamcp/core'
import { createTestDatabase, type TestDatabase } from '@wamcp/core/testing'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Registry } from './context.js'
import { createHttpApp } from './http.js'
import { runProxy } from './proxy.js'

const log = pino({ level: 'silent' })
let tdb: TestDatabase
let httpServer: ServerType
let baseUrl = ''
let connector: FakeConnector
let tokens: { reader: string; sender: string; approver: string; other: string }
const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
const chatId = 'cust@s.whatsapp.net'
let registry: Registry
let httpApp: ReturnType<typeof createHttpApp>

async function mcpClient(token: string, name = 'test-client') {
  const client = new Client({ name, version: '0.0.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport as unknown as Transport)
  return client
}

function parse<T = Record<string, unknown>>(r: Awaited<ReturnType<Client['callTool']>>): T {
  const c = (r.content as Array<{ type: string; text: string }>)[0]
  return JSON.parse(c?.text ?? '{}') as T
}

beforeAll(async () => {
  tdb = await createTestDatabase()
  const cfg = AccountConfigSchema.parse({
    id: 'm1',
    type: 'web',
    display_name: 'M1',
    timezone: 'UTC',
    business_hours: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
    tool_send_approval: 'approve',
  })
  await provisionAccount(tdb.handle, cfg)
  connector = new FakeConnector('m1')
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
    extraSenders: [new MemorySender()],
  })
  const rt = createAccountRuntime({
    handle: tdb.handle,
    config: cfg,
    connector,
    codec: plainCodec,
    clock,
    log,
    operator,
    sleep: async () => undefined,
  })
  await rt.start()
  const state = new OperatorState(tdb.handle.db)
  registry = { accounts: new Map([['m1', rt]]), globalKill: () => state.globalKill() }
  const store = new TokenStore(tdb.handle.db, clock)
  tokens = {
    reader: (
      await store.create({ name: 'reader', scopes: ['read:messages', 'read:audit'], accountIds: ['m1'] })
    ).plaintext,
    sender: (
      await store.create({
        name: 'sender',
        scopes: ['read:messages', 'read:audit', 'send'],
        accountIds: ['m1'],
      })
    ).plaintext,
    approver: (
      await store.create({ name: 'approver', scopes: ['approver', 'read:audit'], accountIds: ['m1'] })
    ).plaintext,
    other: (await store.create({ name: 'other', scopes: ['admin'], accountIds: ['someone_else'] })).plaintext,
  }
  httpApp = createHttpApp({ registry, tokens: store, log, callsPerMinute: 30 })
  httpServer = serve({ fetch: httpApp.app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => httpServer.once('listening', r))
  const addr = httpServer.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  // One inbound DM so the first-contact rule passes.
  await connector.emit(
    textMessage({
      chatId,
      senderJid: chatId,
      providerId: 'IN1',
      body: 'hello, I need help with order A-1042',
      occurredAt: clock.now(),
    }),
  )
  await rt.pipeline.drained()
})
afterAll(async () => {
  await httpApp.closeAll()
  httpServer.closeAllConnections?.()
  await new Promise<void>((r) => httpServer.close(() => r()))
  for (const rt of registry.accounts.values()) await rt.stop()
  await tdb.drop()
})

describe('http transport and auth', () => {
  it('rejects missing tokens, unknown tokens, and disallowed origins', async () => {
    expect((await fetch(`${baseUrl}/mcp`, { method: 'POST' })).status).toBe(401)
    expect(
      (await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wamcp_nope' } }))
        .status,
    ).toBe(401)
    expect(
      (
        await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens.reader}`, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403)
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200)
  })

  it('a token scoped to another account sees nothing', async () => {
    const c = await mcpClient(tokens.other)
    const r = parse<{ accounts: unknown[] }>(
      await c.callTool({ name: 'whatsapp_list_accounts', arguments: {} }),
    )
    expect(r.accounts).toEqual([])
    const s = await c.callTool({ name: 'whatsapp_get_account_status', arguments: { account_id: 'm1' } })
    expect(s.isError).toBe(true)
    expect(parse(s).error).toBe('FORBIDDEN')
    await c.close()
  })
})

describe('tools', () => {
  it('reader can read messages and events but not send', async () => {
    const c = await mcpClient(tokens.reader)
    const tools = await c.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('whatsapp_send_message')
    const msgs = parse<{ messages: Array<{ body: string }> }>(
      await c.callTool({ name: 'whatsapp_get_messages', arguments: { account_id: 'm1', chat_id: chatId } }),
    )
    expect(msgs.messages[0]?.body).toContain('A-1042')
    const ev = parse<{ events: unknown[]; next_cursor: number }>(
      await c.callTool({ name: 'whatsapp_get_events', arguments: { account_id: 'm1', after_cursor: 0 } }),
    )
    expect(ev.events.length).toBeGreaterThan(0)
    const send = await c.callTool({
      name: 'whatsapp_send_message',
      arguments: { account_id: 'm1', chat_id: chatId, text: 'hi' },
    })
    expect(send.isError).toBe(true)
    expect(parse(send)).toMatchObject({ error: 'FORBIDDEN', required_scope: 'send' })
    const search = parse<{ messages: unknown[] }>(
      await c.callTool({ name: 'whatsapp_search_messages', arguments: { account_id: 'm1', query: 'order' } }),
    )
    expect(search.messages.length).toBe(1)
    await c.close()
  })

  it('send goes to approval; the sender cannot approve; an approver can; the connector sends once', async () => {
    const sender = await mcpClient(tokens.sender)
    const r = await sender.callTool({
      name: 'whatsapp_send_message',
      arguments: {
        account_id: 'm1',
        chat_id: chatId,
        text: 'Looking into A-1042 now.',
        idempotency_key: 'idem-send-1',
      },
    })
    expect(r.isError).toBe(true)
    const pending = parse<{ error: string; approval_code: string }>(r)
    expect(pending.error).toBe('APPROVAL_PENDING')
    expect(pending.approval_code).toMatch(/^[A-Z2-9]{6}$/)
    // Retrying with the same key returns the same pending action, not a second one.
    const again = parse<{ approval_code: string }>(
      await sender.callTool({
        name: 'whatsapp_send_message',
        arguments: {
          account_id: 'm1',
          chat_id: chatId,
          text: 'Looking into A-1042 now.',
          idempotency_key: 'idem-send-1',
        },
      }),
    )
    expect(again.approval_code).toBe(pending.approval_code)
    const selfApprove = await sender.callTool({
      name: 'whatsapp_approve_action',
      arguments: { account_id: 'm1', approval_code: pending.approval_code },
    })
    expect(parse(selfApprove)).toMatchObject({ error: 'FORBIDDEN', required_scope: 'approver' })

    const approver = await mcpClient(tokens.approver)
    const list = parse<{ approvals: Array<{ approval_code: string; text: string }> }>(
      await approver.callTool({ name: 'whatsapp_list_pending_approvals', arguments: { account_id: 'm1' } }),
    )
    expect(list.approvals.map((a) => a.approval_code)).toContain(pending.approval_code)
    const ok = parse<{ state: string; message_id: string }>(
      await approver.callTool({
        name: 'whatsapp_approve_action',
        arguments: { account_id: 'm1', approval_code: pending.approval_code },
      }),
    )
    expect(ok.state).toBe('sent')
    const real = connector.sends.filter((s) => s.cmd.kind === 'send_message')
    expect(real.length).toBe(1)
    expect(real[0]?.cmd.messageId).toBe(ok.message_id)
    const audit = parse<{ entries: Array<{ kind: string; decision: string }> }>(
      await approver.callTool({
        name: 'whatsapp_get_audit_log',
        arguments: { account_id: 'm1', kind: 'approval' },
      }),
    )
    expect(audit.entries[0]?.decision).toBe('approved')
    await sender.close()
    await approver.close()
  })

  it('subscriptions deliver live events as notifications and stop on unsubscribe', async () => {
    const c = await mcpClient(tokens.sender)
    const got: Array<Record<string, unknown>> = []
    c.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      if (n.params.logger === 'wamcp.events') got.push(n.params.data as Record<string, unknown>)
    })
    const sub = parse<{ subscription_id: string }>(
      await c.callTool({
        name: 'whatsapp_subscribe_events',
        arguments: { account_id: 'm1', types: ['message.received'] },
      }),
    )
    clock.advance(1000)
    await connector.emit(
      textMessage({
        chatId,
        senderJid: chatId,
        providerId: 'IN2',
        body: 'any update?',
        occurredAt: clock.now(),
      }),
    )
    await registry.accounts.get('m1')?.pipeline.drained()
    await new Promise((r) => setTimeout(r, 100))
    expect(got.length).toBe(1)
    expect(got[0]).toMatchObject({ account_id: 'm1', type: 'message.received', message_id: 'IN2' })
    const un = parse<{ removed: boolean }>(
      await c.callTool({
        name: 'whatsapp_unsubscribe_events',
        arguments: { subscription_id: sub.subscription_id },
      }),
    )
    expect(un.removed).toBe(true)
    await connector.emit(
      textMessage({ chatId, senderJid: chatId, providerId: 'IN3', body: 'hello?', occurredAt: clock.now() }),
    )
    await registry.accounts.get('m1')?.pipeline.drained()
    await new Promise((r) => setTimeout(r, 50))
    expect(got.length).toBe(1)
    await c.close()
  })

  it('resources list and read', async () => {
    const c = await mcpClient(tokens.reader)
    const res = await c.listResources()
    expect(res.resources.map((r) => r.uri)).toContain('whatsapp://m1/chats')
    const read = await c.readResource({ uri: 'whatsapp://m1/chats' })
    const text = (read.contents[0] as { text: string }).text
    expect(JSON.parse(text)[0].chat_id).toBe(chatId)
    await c.close()
  })

  it('per-token call limit returns 429', async () => {
    const c = await mcpClient(tokens.approver)
    let limited = false
    for (let i = 0; i < 40 && !limited; i++) {
      try {
        await c.callTool({ name: 'whatsapp_list_accounts', arguments: {} })
      } catch (e) {
        limited = /RATE_LIMITED/.test((e as Error).message)
      }
    }
    expect(limited).toBe(true)
    await c.close().catch(() => undefined)
  })
})

describe('stdio proxy', () => {
  it('forwards tools, resources, and notifications over an in-memory stdio-equivalent transport', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const proxy = await runProxy({ url: `${baseUrl}/mcp`, token: tokens.sender, serverTransport: serverSide })
    const local = new Client({ name: 'desktop', version: '0' }, { capabilities: {} })
    await local.connect(clientSide)
    const tools = await local.listTools()
    expect(tools.tools.some((t) => t.name === 'whatsapp_get_messages')).toBe(true)
    const msgs = parse<{ messages: unknown[] }>(
      await local.callTool({
        name: 'whatsapp_get_messages',
        arguments: { account_id: 'm1', chat_id: chatId },
      }),
    )
    expect(msgs.messages.length).toBeGreaterThan(0)
    const got: unknown[] = []
    local.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
      got.push(n.params.data)
    })
    await local.callTool({ name: 'whatsapp_subscribe_events', arguments: { account_id: 'm1' } })
    await connector.emit(
      textMessage({
        chatId,
        senderJid: chatId,
        providerId: 'IN4',
        body: 'via proxy',
        occurredAt: clock.now(),
      }),
    )
    await registry.accounts.get('m1')?.pipeline.drained()
    await new Promise((r) => setTimeout(r, 150))
    expect(got.length).toBeGreaterThan(0)
    await local.close()
    await proxy.close()
  })
})
