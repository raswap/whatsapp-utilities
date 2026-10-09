import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  ActionStore,
  codecFor,
  EventStore,
  generateMasterKey,
  ManualClock,
  MemorySender,
  OperatorChannel,
  OperatorState,
  parseConfig,
  provisionAccount,
  TokenStore,
  tablesFor,
  textMessage,
} from '@wamcp/core'
import { createTestDatabase, type TestDatabase } from '@wamcp/core/testing'
import { Command, CommanderError } from 'commander'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliContext } from '../context.js'
import { startServer } from '../server.js'
import { registerAccounts } from './accounts.js'
import { registerActions } from './actions.js'
import { registerAlerts } from './alerts.js'
import { registerApprovals } from './approvals.js'
import { registerBackup } from './backup.js'
import { registerDoctor } from './doctor.js'
import { registerInit } from './init.js'
import { registerMcp } from './mcp.js'
import { registerServe } from './serve.js'
import { registerStatus } from './status.js'
import { registerTail } from './tail.js'
import { registerTokens } from './tokens.js'

vi.mock('../context.js', async (orig) => ({
  ...(await orig<typeof import('../context.js')>()),
  loadContext: vi.fn(async () => ctx),
}))
vi.mock('../server.js', async (orig) => ({
  ...(await orig<typeof import('../server.js')>()),
  startServer: vi.fn(),
}))
vi.mock('@wamcp/mcp', () => ({ runProxy: vi.fn(async () => ({ close: async () => undefined })) }))

let tdb: TestDatabase
let dir: string
let ctx: CliContext
const memory = new MemorySender()
const log = pino({ level: 'silent' })
const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
const t = tablesFor('acct_main')

const CONFIG = `
version: 1
server: { http: { bind: 127.0.0.1, port: 0 }, data_dir: ./data, backup_dir: ./backups }
operator:
  channels:
    - { kind: webhook, name: hook, url: https://example.invalid/hook }
accounts:
  - { id: main, type: web, display_name: Main, timezone: UTC, tool_send_approval: auto, business_hours: { days: [1,2,3,4,5,6,7], start: "00:00", end: "23:59" } }
`

/** Fresh program per call so option values never leak between invocations. */
async function run(...args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
  const program = new Command()
  program
    .name('wamcp')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .option('-c, --config <path>')
    .option('--json')
    .option('-v, --verbose')
  for (const reg of [
    registerInit,
    registerServe,
    registerStatus,
    registerDoctor,
    registerTail,
    registerAccounts,
    registerApprovals,
    registerActions,
    registerTokens,
    registerBackup,
    registerAlerts,
    registerMcp,
  ])
    reg(program)
  let stdout = ''
  const orig = process.stdout.write
  process.stdout.write = ((s: string) => {
    stdout += s
    return true
  }) as never
  process.exitCode = undefined
  try {
    await program.parseAsync(args, { from: 'user' })
  } finally {
    process.stdout.write = orig
  }
  const exitCode = process.exitCode
  process.exitCode = undefined
  return { stdout, exitCode }
}
const json = async (...args: string[]) => {
  const r = await run(...args)
  return { ...r, data: JSON.parse(r.stdout) }
}

beforeAll(async () => {
  tdb = await createTestDatabase()
  dir = mkdtempSync(resolve(tmpdir(), 'wamcp-cmd-'))
  const configPath = resolve(dir, 'wamcp.yaml')
  writeFileSync(configPath, CONFIG)
  const key = generateMasterKey(resolve(dir, 'keys', 'master.key'))
  const config = parseConfig(CONFIG, configPath)
  const operator = new OperatorChannel({
    config: config.operator,
    env: {},
    log,
    clock,
    extraSenders: [memory],
  })
  ctx = {
    configPath,
    config,
    secrets: { DATABASE_URL: tdb.url, WAMCP_MASTER_KEY_FILE: key.path, LOG_LEVEL: 'info' },
    masterKey: key,
    codec: codecFor(key),
    handle: tdb.handle,
    tokens: new TokenStore(tdb.handle.db, clock),
    operator,
    operatorState: new OperatorState(tdb.handle.db),
    log,
    clock,
    close: async () => undefined,
  }
  await provisionAccount(tdb.handle, config.accounts[0] as never)
})
afterAll(async () => {
  await tdb.drop()
  rmSync(dir, { recursive: true, force: true })
})

// Commands register SIGINT/SIGTERM handlers that would exit the worker; drop the ones they add.
let signalListeners: Record<string, Array<(...a: never[]) => unknown>> = {}
beforeEach(() => {
  signalListeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
})
afterEach(() => {
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    for (const l of process.listeners(sig))
      if (!signalListeners[sig]?.includes(l)) process.off(sig, l as never)
})

describe('accounts and kill switch', () => {
  it('ls, pause, resume, unthrottle, kill', async () => {
    expect((await json('--json', 'accounts', 'ls')).data).toMatchObject([{ id: 'main', provisioned: 'yes' }])
    expect((await run('accounts', 'ls')).stdout).toContain('main')
    expect((await json('--json', 'accounts', 'pause', 'main')).data).toEqual({ id: 'main', paused: true })
    await ctx.operatorState.setThrottled('main', new Date('2027-01-01'), 'spam')
    expect((await json('--json', 'accounts', 'ls')).data[0]).toMatchObject({
      paused: 'yes',
      throttled: '2027-01-01T00:00',
    })
    expect((await run('accounts', 'resume', 'main')).stdout).toBe('main resumed\n')
    expect((await run('accounts', 'unthrottle', 'main')).stdout).toBe('main throttle cleared\n')
    expect((await json('--json', 'accounts', 'ls')).data[0]).toMatchObject({ paused: '', throttled: '' })
    await expect(run('accounts', 'pause', 'ghost')).rejects.toThrow(/no account ghost/)
    expect((await run('kill')).stdout).toBe('global kill switch ON\n')
    expect(await ctx.operatorState.globalKill()).toBe(true)
    expect((await json('--json', 'kill', '--off')).data).toEqual({ global_kill: false })
  })

  it('pair validates the account before touching the network; unpair clears the session', async () => {
    await expect(run('accounts', 'pair', 'ghost', '--accept-tos')).rejects.toThrow(/no account ghost/)
    ctx.config.accounts.push({ ...(ctx.config.accounts[0] as never), id: 'cloudy', type: 'cloud' })
    try {
      await expect(run('accounts', 'pair', 'cloudy', '--accept-tos')).rejects.toThrow(/only web accounts/)
    } finally {
      ctx.config.accounts.pop()
    }
    await expect(run('accounts', 'unpair', 'ghost')).rejects.toThrow(/no account ghost/)
    await tdb.handle.db
      .insert(t.sessionState)
      .values({ key: 'creds', valueEnc: ctx.codec.encrypt('{}', 'session_state:acct_main:creds') })
      .onConflictDoNothing()
    expect((await json('--json', 'accounts', 'unpair', 'main')).data).toEqual({ id: 'main', unpaired: true })
    expect(await tdb.handle.db.select().from(t.sessionState)).toEqual([])
  })
})

describe('approvals and actions', () => {
  const store = () => new ActionStore(tdb.handle.db, t, clock)
  const plan = (key: string) =>
    store().create({
      kind: 'send_message',
      source: 'cli',
      actor: 'someone-else',
      idempotencyKey: key,
      chatId: 'c@s.whatsapp.net',
      payload: {},
      text: 'hello there',
      approval: 'approve',
    })

  it('lists, rejects, and reports unknown approval codes', async () => {
    const { row } = await plan('a1')
    const pending = await store().markAwaitingApproval(row.id, 3600_000)
    const ls = await json('--json', 'approvals', 'ls', '--account', 'main')
    expect(ls.data).toMatchObject([{ account: 'main', code: pending.approvalCode, text: 'hello there' }])
    expect((await run('approvals', 'ls')).stdout).toContain(pending.approvalCode)
    const rej = await json('--json', 'approvals', 'reject', pending.approvalCode as string, '--reason', 'nah')
    expect(rej.data).toMatchObject({ id: row.id, state: 'rejected', result: { reason: 'nah' } })
    expect((await run('approvals', 'approve', 'NOPE')).exitCode).toBe(1)
    expect((await run('approvals', 'reject', 'NOPE')).exitCode).toBe(1)
  })

  it('lists and resolves unknown actions; rejects bad outcomes, states, and ids', async () => {
    const { row } = await plan('a2')
    await store().transition(row.id, ['planned'], 'unknown')
    expect((await json('--json', 'actions', 'ls')).data).toMatchObject([{ id: row.id, state: 'unknown' }])
    expect((await run('actions', 'ls', '--state', 'sent')).stdout).toBe('(none)\n')
    await expect(run('actions', 'resolve', row.id, '--outcome', 'bogus')).rejects.toThrow(/sent or failed/)
    const r = await json('--json', 'actions', 'resolve', row.id, '--outcome', 'sent')
    expect(r.data).toMatchObject({ state: 'sent', result: { resolvedBy: expect.stringMatching(/^cli:/) } })
    expect((await run('actions', 'ls', '--state', 'sent')).stdout).toContain(row.id)
    await expect(run('actions', 'resolve', row.id, '--outcome', 'sent')).rejects.toThrow(/not unknown/)
    await expect(run('actions', 'resolve', 'nope', '--outcome', 'sent')).rejects.toThrow(/no action nope/)
    await expect(run('actions', 'retry', row.id)).rejects.toThrow(/only failed or retry_wait/)
    await expect(run('actions', 'retry', 'nope')).rejects.toThrow(/no action nope/)
    await expect(run('actions', 'resolve', row.id)).rejects.toBeInstanceOf(CommanderError)
  })
})

describe('tokens and alerts', () => {
  it('create, ls, revoke', async () => {
    const created = await json(
      '--json',
      'tokens',
      'create',
      '--name',
      'a',
      '--scopes',
      'read:messages',
      '--chats',
      'x,y',
    )
    expect(created.data).toMatchObject({ name: 'a', plaintext: expect.stringMatching(/^wamcp_/) })
    const forever = await run(
      'tokens',
      'create',
      '--name',
      'b',
      '--scopes',
      'read:messages',
      '--ttl-days',
      '0',
    )
    expect(forever.stdout).toContain('expires: never')
    expect((await run('tokens', 'ls')).stdout).toMatch(/never/)
    expect((await json('--json', 'tokens', 'revoke', created.data.id)).data).toEqual({
      id: created.data.id,
      revoked: true,
    })
    const again = await run('tokens', 'revoke', created.data.id)
    expect(again).toEqual({ stdout: `no active token ${created.data.id}\n`, exitCode: 1 })
    expect((await json('--json', 'tokens', 'ls')).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'a', revokedAt: expect.any(String) })]),
    )
    await expect(run('tokens', 'create', '--name', 'c')).rejects.toBeInstanceOf(CommanderError)
  })

  it('alerts test reports every channel and fails when one does', async () => {
    const r = await json('--json', 'alerts', 'test')
    expect(r.exitCode).toBe(1)
    expect(r.data).toMatchObject([
      { channel: 'webhook:hook', ok: false },
      { channel: 'memory:memory', ok: true },
    ])
    expect((await run('alerts', 'test')).stdout).toMatch(/FAIL webhook:hook .*\nOK {3}memory:memory/)
    expect(memory.messages.at(-1)?.kind).toBe('test')
  })
})

describe('status and tail', () => {
  it('status with and without a reachable server', async () => {
    const off = await json('--json', 'status')
    expect(off.data).toMatchObject({
      global_kill: false,
      accounts: [{ account: 'main', connection: 'server not reachable' }],
    })
    const srv: Server = createServer((_q, res) =>
      res.end(JSON.stringify({ ok: true, detail: { main: 'connected' } })),
    )
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    ctx.config.server.http.port = (srv.address() as { port: number }).port
    try {
      expect((await run('status')).stdout).toMatch(/global kill: off\n[\s\S]*main\s+connected/)
    } finally {
      ctx.config.server.http.port = 0
      await new Promise((r) => srv.close(r))
    }
  })

  it('tail prints stored events with filters, json, and follow until SIGINT', async () => {
    const events = new EventStore(tdb.handle.db, t, { accountId: 'main', backfillAgeThresholdMs: 0, clock })
    for (const [i, body] of ['one', 'two'].entries())
      await events.insert(
        textMessage({
          chatId: 'c@s.whatsapp.net',
          senderJid: 'c@s.whatsapp.net',
          providerId: `P${i}`,
          body,
          occurredAt: clock.now(),
        }),
      )
    const all = await run('tail', '--no-follow')
    expect(all.stdout).toMatch(/main #1 message.received .*"one"\n.*"two"/)
    expect((await run('tail', '--no-follow', '--from', '1')).stdout).not.toContain('"one"')
    expect(
      (await run('tail', '--no-follow', '--chat', 'other', '--type', 'message.received', '--account', 'main'))
        .stdout,
    ).toBe('')
    const j = await run('--json', 'tail', '--no-follow', '--from', '1')
    expect(JSON.parse(j.stdout)).toMatchObject({ account: 'main', cursor: 2 })
    setTimeout(() => process.emit('SIGINT', 'SIGINT'), 50)
    expect((await run('tail', '--from', '0')).stdout).toContain('"two"')
  })
})

describe('backup, restore, doctor, init', () => {
  it('backup and restore through the command', async () => {
    const all = await json('--json', 'backup', '--keep', '1')
    expect(all.data).toMatchObject([{ account: 'main', pruned: [] }, { operator: expect.any(String) }])
    const one = await json('--json', 'backup', '--account', 'main', '--keep', '1')
    expect(one.data).toMatchObject([{ account: 'main', pruned: [expect.stringMatching(/\.sql\.enc$/)] }])
    const file = one.data[0].dumpFile as string
    expect((await json('--json', 'restore', 'main', file, '--full')).data).toMatchObject({
      sessionReapplied: false,
    })
    await tdb.handle.db
      .insert(t.sessionState)
      .values({ key: 'creds', valueEnc: 'v1.live' })
      .onConflictDoNothing()
    expect((await run('restore', 'main', file, '--db-only')).stdout).toContain('live session kept')
    await tdb.handle.db.delete(t.sessionState)
    expect((await run('restore', 'main', file)).stdout).toMatch(/restored main .*\(session from backup/)
  })

  it('doctor runs the checks, probes channels, and reports a dead database', async () => {
    writeFileSync(
      resolve(dir, '.env'),
      `DATABASE_URL=${tdb.url}\nWAMCP_MASTER_KEY_FILE=${ctx.masterKey.path}\n`,
    )
    const r = await json('-c', ctx.configPath, '--json', 'doctor', '--probe')
    expect(r.data.checks.find((c: { name: string }) => c.name === 'channel webhook:hook')).toMatchObject({
      status: 'fail',
    })
    expect(r.data.checks.find((c: { name: string }) => c.name === 'account main')).toMatchObject({
      status: 'pass',
    })
    expect((await run('-c', ctx.configPath, 'doctor')).stdout).toMatch(/PASS master key.*\n(.*\n)*overall:/)
    const good = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://x:y@127.0.0.1:1/x'
    try {
      const dead = await json('-c', ctx.configPath, '--json', 'doctor')
      expect(dead.exitCode).toBe(1)
      expect(dead.data.checks.find((c: { name: string }) => c.name === 'database')).toMatchObject({
        status: 'fail',
      })
    } finally {
      process.env.DATABASE_URL = good
    }
  })

  it('init --non-interactive writes a project and refuses without a database url', async () => {
    const d = resolve(dir, 'init')
    const r = await run(
      'init',
      '--non-interactive',
      '--dir',
      d,
      '--database-url',
      tdb.url,
      '--master-key-file',
      resolve(d, 'k'),
      '--accept-tos',
      '--webhook-url',
      'https://x.example/h',
      '--timezone',
      'UTC',
      '--business-hours',
      '10:00-11:00',
    )
    expect(r.stdout).toMatch(/wrote .*wamcp\.yaml\n.*\nmaster key at .*\/k\n/)
    await expect(
      run('init', '--non-interactive', '--dir', resolve(dir, 'init2'), '--database-url', ''),
    ).rejects.toThrow(/DATABASE_URL is required/)
  })
})

describe('serve and mcp', () => {
  it('serve logs on success and exits with the startup failure code', async () => {
    vi.mocked(startServer).mockResolvedValueOnce({
      runtimes: new Map(),
      port: 1,
      stop: async () => undefined,
    } as never)
    await run('serve', '--fake')
    expect(startServer).toHaveBeenCalledWith(ctx, { fake: true })
    vi.mocked(startServer).mockRejectedValueOnce(Object.assign(new Error('loop'), { exitCode: 3 }))
    const exit = vi.spyOn(process, 'exit').mockImplementation(((c: number) => {
      throw new Error(`exit ${c}`)
    }) as never)
    try {
      await expect(run('serve')).rejects.toThrow('exit 3')
      expect(memory.messages.at(-1)).toMatchObject({ title: 'wamcp failed to start', body: 'loop' })
      vi.mocked(startServer).mockRejectedValueOnce(new Error('other'))
      await expect(run('serve')).rejects.toThrow('exit 1')
    } finally {
      exit.mockRestore()
    }
  })

  it('mcp resolves the url and token, from flags or the local token file', async () => {
    const { runProxy } = await import('@wamcp/mcp')
    await run('mcp', '--url', 'http://h/mcp', '--token', 'tok')
    expect(runProxy).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'http://h/mcp', token: 'tok' }))
    mkdirSync(resolve(dir, 'data', '_operator'), { recursive: true })
    writeFileSync(resolve(dir, 'data', '_operator', 'local-stdio.token'), 'filetok\n')
    await run('mcp')
    expect(runProxy).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'http://127.0.0.1:0/mcp', token: 'filetok' }),
    )
  })
})
