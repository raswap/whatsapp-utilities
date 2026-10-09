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
let tokens: { reader: string; sender: string; approver: string; other: string; scoped: string }
let store: TokenStore
const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
const chatId = 'cust@s.whatsapp.net'
const chatId2 = 'cust2@s.whatsapp.net'
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
  const mk = (config: typeof cfg, conn: FakeConnector) =>
    createAccountRuntime({
      handle: tdb.handle,
      config,
      connector: conn,
      codec: plainCodec,
      clock,
      log,
      operator,
      sleep: async () => undefined,
    })
  const rt = mk(cfg, connector)
  await rt.start()
  // Second account: auto send, connector without reactions (CAPABILITY_UNSUPPORTED path).
  const cfg2 = AccountConfigSchema.parse({ ...cfg, id: 'm2', display_name: 'M2', tool_send_approval: 'auto' })
  await provisionAccount(tdb.handle, cfg2)
  const connector2 = new FakeConnector('m2', ['groups', 'presence', 'media'])
  const rt2 = mk(cfg2, connector2)
  await rt2.start()
  const state = new OperatorState(tdb.handle.db)
  registry = {
    accounts: new Map([
      ['m1', rt],
      ['m2', rt2],
    ]),
    globalKill: () => state.globalKill(),
  }
  store = new TokenStore(tdb.handle.db, clock)
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
    scoped: (
      await store.create({
        name: 'scoped',
        scopes: ['read:messages'],
        accountIds: ['m1'],
        chatAllowlist: ['nobody@s.whatsapp.net'],
      })
    ).plaintext,
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
  await connector2.emit(
    textMessage({
      chatId: chatId2,
      senderJid: chatId2,
      providerId: 'IN1',
      body: 'hi m2',
      occurredAt: clock.now(),
    }),
  )
  await rt2.pipeline.drained()
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

describe('errors, filters, and the auto send path', () => {
  // Each test gets its own admin token so the per-token call limit (30/min) is never hit.
  const admin = async () =>
    mcpClient((await store.create({ name: 'admin', scopes: ['admin'], accountIds: ['*'] })).plaintext)

  it('unknown ids, bad cursors, and chat allowlists', async () => {
    const a = await admin()
    const accounts = parse<{ accounts: Array<{ account_id: string }> }>(
      await a.callTool({ name: 'whatsapp_list_accounts', arguments: {} }),
    )
    expect(accounts.accounts.map((x) => x.account_id).sort()).toEqual(['m1', 'm2'])
    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['whatsapp_get_account_status', { account_id: 'nope' }, 'NOT_FOUND'],
      ['whatsapp_get_chat', { account_id: 'm1', chat_id: 'ghost@s.whatsapp.net' }, 'NOT_FOUND'],
      ['whatsapp_get_thread', { account_id: 'm1', chat_id: chatId, message_id: 'nope' }, 'NOT_FOUND'],
      ['whatsapp_get_messages', { account_id: 'm1', chat_id: chatId, before: 'bogus' }, 'VALIDATION_ERROR'],
      ['whatsapp_unsubscribe_events', { subscription_id: 'nope' }, 'NOT_FOUND'],
    ]
    for (const [name, args, code] of calls) {
      const r = await a.callTool({ name, arguments: args })
      expect(r.isError, name).toBe(true)
      expect(parse(r).error, name).toBe(code)
    }
    const res = await a.listResources()
    expect(res.resources.map((r) => r.uri)).toContain('whatsapp://m2/chats')
    const pending = await a.readResource({ uri: 'whatsapp://m1/pending-approvals' })
    expect(JSON.parse((pending.contents[0] as { text: string }).text)).toEqual([])
    await a.close()

    // Admin on another account: every tool's error path returns FORBIDDEN.
    const o = await mcpClient(tokens.other)
    for (const [name, args] of [
      ['whatsapp_get_chat', { chat_id: chatId }],
      ['whatsapp_search_messages', { query: 'x' }],
      ['whatsapp_set_chat_automation', { chat_id: chatId, state: 'paused' }],
      ['whatsapp_list_actions', {}],
      ['whatsapp_list_pending_approvals', {}],
      ['whatsapp_get_audit_log', {}],
      ['whatsapp_pause_account', {}],
      ['whatsapp_mark_read', { chat_id: chatId, message_ids: ['IN1'] }],
      ['whatsapp_react_to_message', { chat_id: chatId, message_id: 'IN1', emoji: null }],
    ] as const) {
      const r = await o.callTool({ name, arguments: { account_id: 'm1', ...args } })
      expect(parse(r).error, name).toBe('FORBIDDEN')
    }
    await o.close()

    const s = await mcpClient(tokens.scoped)
    const denied = await s.callTool({
      name: 'whatsapp_get_messages',
      arguments: { account_id: 'm1', chat_id: chatId },
    })
    expect(parse(denied).error).toBe('FORBIDDEN')
    const chats = parse<{ chats: unknown[] }>(
      await s.callTool({ name: 'whatsapp_list_chats', arguments: { account_id: 'm1' } }),
    )
    expect(chats.chats).toEqual([])
    const search = parse<{ messages: unknown[] }>(
      await s.callTool({ name: 'whatsapp_search_messages', arguments: { account_id: 'm1', query: 'order' } }),
    )
    expect(search.messages).toEqual([])
    const ev = parse<{ events: unknown[]; next_cursor: number }>(
      await s.callTool({ name: 'whatsapp_get_events', arguments: { account_id: 'm1' } }),
    )
    expect(ev).toEqual({ account_id: 'm1', events: [], next_cursor: 0 })
    const sub = parse<{ subscription_id: string }>(
      await s.callTool({ name: 'whatsapp_subscribe_events', arguments: { account_id: 'm1' } }),
    )
    expect(sub.subscription_id).toBeTruthy()
    await s.close()
  })

  it('read filters and pagination', async () => {
    const c = await mcpClient(tokens.reader)
    const chats = parse<{ chats: Array<{ chat_id: string; type: string }> }>(
      await c.callTool({
        name: 'whatsapp_list_chats',
        arguments: { account_id: 'm1', type: 'dm', unread_only: true, limit: 5 },
      }),
    )
    expect(chats.chats.every((x) => x.type === 'dm')).toBe(true)
    const page1 = parse<{ messages: unknown[]; next_cursor: string; truncated: boolean }>(
      await c.callTool({
        name: 'whatsapp_get_messages',
        arguments: { account_id: 'm1', chat_id: chatId, limit: 1 },
      }),
    )
    expect(page1.truncated).toBe(true)
    const page2 = parse<{ messages: unknown[] }>(
      await c.callTool({
        name: 'whatsapp_get_messages',
        arguments: {
          account_id: 'm1',
          chat_id: chatId,
          limit: 1,
          before: page1.next_cursor,
          include_deleted: true,
        },
      }),
    )
    expect(page2.messages).not.toEqual(page1.messages)
    const thread = parse<{ thread: Array<{ message_id: string }> }>(
      await c.callTool({
        name: 'whatsapp_get_thread',
        arguments: { account_id: 'm1', chat_id: chatId, message_id: 'IN1', depth: 1 },
      }),
    )
    expect(thread.thread[0]?.message_id).toBe('IN1')
    const search = parse<{ messages: unknown[] }>(
      await c.callTool({
        name: 'whatsapp_search_messages',
        arguments: { account_id: 'm1', query: 'order', chat_ids: ['x@s.whatsapp.net'] },
      }),
    )
    expect(search.messages).toEqual([])
    const ev = parse<{ events: Array<{ type: string }> }>(
      await c.callTool({
        name: 'whatsapp_get_events',
        arguments: {
          account_id: 'm1',
          types: ['message.received'],
          chat_ids: [chatId],
          include_from_me: false,
          include_backfill: true,
        },
      }),
    )
    expect(ev.events.every((e) => e.type === 'message.received')).toBe(true)
    const actions = parse<{ actions: Array<{ state: string }> }>(
      await c.callTool({
        name: 'whatsapp_list_actions',
        arguments: { account_id: 'm1', state: 'sent', chat_id: chatId },
      }),
    )
    expect(actions.actions.map((x) => x.state)).toEqual(['sent'])
    const all = parse<{ actions: unknown[] }>(
      await c.callTool({ name: 'whatsapp_list_actions', arguments: { account_id: 'm1' } }),
    )
    expect(all.actions.length).toBeGreaterThanOrEqual(1)
    const audit = parse<{ entries: unknown[] }>(
      await c.callTool({
        name: 'whatsapp_get_audit_log',
        arguments: { account_id: 'm1', event_id: 'nope', chat_id: chatId },
      }),
    )
    expect(audit.entries).toEqual([])
    await c.close()
  })

  it('auto send, rate limit, capability, and policy errors', async () => {
    const a = await admin()
    const sent = parse<{ state: string }>(
      await a.callTool({
        name: 'whatsapp_send_message',
        arguments: {
          account_id: 'm2',
          chat_id: chatId2,
          text: 'auto reply',
          quoted_message_id: 'IN1',
          typing_delay: 'none',
          idempotency_key: 'idem-auto-1',
        },
      }),
    )
    expect(sent.state).toBe('sent')
    const limited = parse<{ error: string; retry_after_ms: number }>(
      await a.callTool({
        name: 'whatsapp_send_message',
        arguments: { account_id: 'm2', chat_id: chatId2, text: 'second reply' },
      }),
    )
    expect(limited.error).toBe('RATE_LIMITED')
    expect(typeof limited.retry_after_ms).toBe('number')
    const react = parse(
      await a.callTool({
        name: 'whatsapp_react_to_message',
        arguments: { account_id: 'm2', chat_id: chatId2, message_id: 'IN1', emoji: '👍' },
      }),
    )
    expect(react.error).toBe('CAPABILITY_UNSUPPORTED')
    const read = await a.callTool({
      name: 'whatsapp_mark_read',
      arguments: { account_id: 'm2', chat_id: chatId2, message_ids: ['IN1'] },
    })
    expect(read.isError).toBeFalsy()
    expect(parse(read).kind).toBe('mark_read')
    await a.close()
  })

  it('rejected, unknown, and expired approvals', async () => {
    const sender = await mcpClient(tokens.sender)
    const a = await admin()
    const submit = async (text: string, key: string) =>
      parse<{ approval_code: string }>(
        await sender.callTool({
          name: 'whatsapp_send_message',
          arguments: { account_id: 'm1', chat_id: chatId, text, idempotency_key: key },
        }),
      ).approval_code
    clock.advance(31_000) // past the per-chat send interval of the earlier approved send
    const code1 = await submit('please reject me', 'idem-reject-1')
    const rejected = parse<{ state: string; result: { reason: string } }>(
      await a.callTool({
        name: 'whatsapp_reject_action',
        arguments: { account_id: 'm1', approval_code: code1, reason: 'nope' },
      }),
    )
    expect(rejected).toMatchObject({ state: 'rejected', result: { reason: 'nope' } })
    const unknown = parse(
      await a.callTool({
        name: 'whatsapp_approve_action',
        arguments: { account_id: 'm1', approval_code: code1 },
      }),
    )
    expect(unknown).toMatchObject({ error: 'NOT_FOUND', approval_error: 'NOT_FOUND' })
    const code2 = await submit('I will expire', 'idem-expire-1')
    clock.advance(5 * 3600_000)
    const expired = parse(
      await a.callTool({
        name: 'whatsapp_approve_action',
        arguments: { account_id: 'm1', approval_code: code2 },
      }),
    )
    expect(expired).toMatchObject({ error: 'FORBIDDEN', approval_error: 'EXPIRED' })
    await sender.close()
    await a.close()
  })

  it('chat automation and account pause', async () => {
    const sender = await mcpClient(tokens.sender)
    const a = await admin()
    const paused = parse<{ paused_until: string | null }>(
      await sender.callTool({
        name: 'whatsapp_set_chat_automation',
        arguments: { account_id: 'm1', chat_id: chatId, state: 'paused', paused_minutes: 5 },
      }),
    )
    expect(paused.paused_until).not.toBeNull()
    const resumeDenied = parse(
      await sender.callTool({
        name: 'whatsapp_set_chat_automation',
        arguments: { account_id: 'm1', chat_id: chatId, state: 'active' },
      }),
    )
    expect(resumeDenied).toMatchObject({ error: 'FORBIDDEN', required_scope: 'admin' })
    const resumed = parse<{ automation: string; paused_until: string | null }>(
      await a.callTool({
        name: 'whatsapp_set_chat_automation',
        arguments: { account_id: 'm1', chat_id: chatId, state: 'active' },
      }),
    )
    expect(resumed).toMatchObject({ automation: 'active', paused_until: null })

    expect(
      parse(await a.callTool({ name: 'whatsapp_pause_account', arguments: { account_id: 'm1' } })),
    ).toEqual({
      account_id: 'm1',
      paused: true,
    })
    const killed = parse(
      await sender.callTool({
        name: 'whatsapp_send_message',
        arguments: { account_id: 'm1', chat_id: chatId, text: 'while paused' },
      }),
    )
    expect(killed).toMatchObject({ error: 'POLICY_BLOCKED', check: 'kill_switch' })
    expect(
      parse(await a.callTool({ name: 'whatsapp_resume_account', arguments: { account_id: 'm1' } })),
    ).toEqual({
      account_id: 'm1',
      paused: false,
    })
    const status = parse<{ connection: string; global_kill: boolean }>(
      await a.callTool({ name: 'whatsapp_get_account_status', arguments: { account_id: 'm1' } }),
    )
    expect(status).toMatchObject({ connection: 'connected', global_kill: false })
    const denied = parse(
      await sender.callTool({ name: 'whatsapp_pause_account', arguments: { account_id: 'm1' } }),
    )
    expect(denied).toMatchObject({ error: 'FORBIDDEN', required_scope: 'admin' })
    await sender.close()
    await a.close()
  })

  it('http: bad session starts, token/session mismatch, revoked and expired tokens, session close', async () => {
    const post = (headers: Record<string, string>, body = '{"jsonrpc":"2.0","id":1,"method":"ping"}') =>
      fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body,
      })
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200)
    expect((await post({ authorization: `Bearer ${tokens.reader}` })).status).toBe(400)
    expect((await post({ authorization: `Bearer ${tokens.reader}` }, 'not json')).status).toBe(400)
    expect((await post({ authorization: `Bearer ${tokens.reader}`, origin: 'not a url' })).status).toBe(403)
    expect((await post({ authorization: `Bearer ${tokens.reader}`, 'mcp-session-id': 'nope' })).status).toBe(
      404,
    )
    const client = new Client({ name: 'raw', version: '0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.reader}` } },
    })
    await client.connect(transport as unknown as Transport)
    const sid = transport.sessionId as string
    expect(httpApp.sessions.has(sid)).toBe(true)
    expect((await post({ authorization: `Bearer ${tokens.sender}`, 'mcp-session-id': sid })).status).toBe(401)
    await transport.terminateSession()
    expect(httpApp.sessions.has(sid)).toBe(false)
    await client.close()
    const revoked = await store.create({ name: 'revoked', scopes: ['admin'], accountIds: ['*'] })
    await store.revoke(revoked.id)
    expect((await post({ authorization: `Bearer ${revoked.plaintext}` })).status).toBe(401)
    const expiring = await store.create({
      name: 'expiring',
      scopes: ['admin'],
      accountIds: ['*'],
      ttlDays: 0,
    })
    clock.advance(1)
    expect((await post({ authorization: `Bearer ${expiring.plaintext}` })).status).toBe(401)
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
