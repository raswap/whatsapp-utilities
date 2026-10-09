import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  codecFor,
  type FakeConnector,
  generateMasterKey,
  ManualClock,
  MemorySender,
  OperatorChannel,
  OperatorState,
  parseConfig,
  TokenStore,
  tablesFor,
  textMessage,
} from '@wamcp/core'
import { createTestDatabase, type TestDatabase } from '@wamcp/core/testing'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupAccount, pruneBackups, restoreAccount } from './commands/backup.js'
import { renderConfig, runInit } from './commands/init.js'
import { type CliContext, cliActor, loadContext, out, resolveConfigPath, table } from './context.js'
import { runDoctorChecks } from './doctor-checks.js'
import { buildRuntimes } from './runtimes.js'
import { EXIT_DO_NOT_RESTART, ensureLocalToken, recordStart, startServer } from './server.js'

let tdb: TestDatabase
let dir: string
let ctx: CliContext
const memory = new MemorySender()
const log = pino({ level: 'silent' })
const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))

const CONFIG = `
version: 1
server: { http: { bind: 127.0.0.1, port: 0 }, data_dir: ./data, backup_dir: ./backups }
operator:
  channels:
    - { kind: webhook, name: hook, url: https://example.invalid/hook }
accounts:
  - { id: main, type: web, display_name: Main, timezone: UTC, tool_send_approval: auto, business_hours: { days: [1,2,3,4,5,6,7], start: "00:00", end: "23:59" } }
`

beforeAll(async () => {
  tdb = await createTestDatabase()
  dir = mkdtempSync(resolve(tmpdir(), 'wamcp-cli-'))
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
})
afterAll(async () => {
  await tdb.drop()
  rmSync(dir, { recursive: true, force: true })
})

describe('serve', () => {
  it('starts with fake connectors, serves health, writes a local token, and stops cleanly', async () => {
    const running = await startServer(ctx, { fake: true, sweepMs: 50 })
    try {
      expect(running.port).toBeGreaterThan(0)
      const h = await fetch(`http://127.0.0.1:${running.port}/healthz`)
      expect(h.status).toBe(200)
      const r = await fetch(`http://127.0.0.1:${running.port}/readyz`)
      expect(r.status).toBe(200)
      expect(await r.json()).toMatchObject({ ok: true, detail: { main: 'connected' } })
      const tokenFile = resolve(dir, 'data', '_operator', 'local-stdio.token')
      expect(readFileSync(tokenFile, 'utf8').trim()).toBe(running.localToken)
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      // The local token authenticates against the HTTP transport.
      const unauth = await fetch(`http://127.0.0.1:${running.port}/mcp`, { method: 'POST' })
      expect(unauth.status).toBe(401)
      // A live event flows through the runtime.
      const rt = running.runtimes.get('main')
      const fake = rt?.connector as FakeConnector
      await fake.emit(
        textMessage({
          chatId: 'c@s.whatsapp.net',
          senderJid: 'c@s.whatsapp.net',
          providerId: 'S1',
          body: 'hi',
          occurredAt: clock.now(),
        }),
      )
      await rt?.pipeline.drained()
      expect((await rt?.pipeline.messages.getMessages({ chatId: 'c@s.whatsapp.net' }))?.items.length).toBe(1)
    } finally {
      await running.stop()
    }
    // Second start reuses the same local token.
    expect(await ensureLocalToken(ctx)).toBe(
      readFileSync(resolve(dir, 'data', '_operator', 'local-stdio.token'), 'utf8').trim(),
    )
  })

  it('crash-loop guard trips after too many starts and alerts', async () => {
    const guard = { max: 3, windowMs: 60_000 }
    const t = new Date('2026-07-01T00:00:00Z')
    expect((await recordStart(ctx, t, guard)).loop).toBe(false)
    expect((await recordStart(ctx, new Date(t.getTime() + 1000), guard)).loop).toBe(false)
    expect((await recordStart(ctx, new Date(t.getTime() + 2000), guard)).loop).toBe(false)
    expect((await recordStart(ctx, new Date(t.getTime() + 3000), guard)).loop).toBe(true)
    // Outside the window the counter resets.
    expect(await recordStart(ctx, new Date(t.getTime() + 120_000), guard)).toMatchObject({
      loop: false,
      recentStarts: 1,
    })
    // startServer surfaces it as exit status 3 after notifying.
    const before = memory.messages.length
    for (let i = 0; i < 4; i++) await recordStart(ctx, new Date(t.getTime() + 130_000 + i), guard)
    ctx.clock = { now: () => new Date(t.getTime() + 131_000) }
    await expect(startServer(ctx, { fake: true, crashLoop: guard, http: false })).rejects.toMatchObject({
      exitCode: EXIT_DO_NOT_RESTART,
    })
    expect(memory.messages.slice(before).some((m) => m.title.includes('crash loop'))).toBe(true)
    ctx.clock = clock
  })
})

describe('backup and restore', () => {
  it('round-trips an account schema through an encrypted pg_dump and keeps the live session in db-only mode', async () => {
    const t = tablesFor('acct_main')
    await tdb.handle.db
      .insert(t.chats)
      .values({ id: 'b@s.whatsapp.net', type: 'dm', name: 'Backup Me' })
      .onConflictDoNothing()
    await tdb.handle.db
      .insert(t.sessionState)
      .values({ key: 'creds', valueEnc: 'v1.old' })
      .onConflictDoUpdate({ target: t.sessionState.key, set: { valueEnc: 'v1.old' } })
    const r = await backupAccount(ctx, 'main', new Date('2026-06-01T00:00:00Z'))
    expect(existsSync(r.dumpFile)).toBe(true)
    expect(readFileSync(r.dumpFile, 'utf8').startsWith(`v1.${ctx.masterKey.id}.`)).toBe(true)
    expect(readFileSync(r.dumpFile, 'utf8')).not.toContain('Backup Me')
    // Mutate after the backup: delete the chat and rotate the session.
    await tdb.handle.db.delete(t.chats)
    await tdb.handle.db.update(t.sessionState).set({ valueEnc: 'v1.new' })
    const res = await restoreAccount(ctx, 'main', r.dumpFile, { mode: 'db-only' })
    expect(res.sessionReapplied).toBe(true)
    const chats = await tdb.handle.db.select().from(t.chats)
    expect(chats.map((c) => c.name)).toContain('Backup Me')
    const [sess] = await tdb.handle.db.select().from(t.sessionState)
    expect(sess?.valueEnc).toBe('v1.new')
    const full = await restoreAccount(ctx, 'main', r.dumpFile, { mode: 'full' })
    expect(full.sessionReapplied).toBe(false)
    const [sessFull] = await tdb.handle.db.select().from(t.sessionState)
    expect(sessFull?.valueEnc).toBe('v1.old')
    // Pruning keeps the newest N.
    for (let i = 0; i < 3; i++) await backupAccount(ctx, 'main', new Date(`2026-06-0${i + 2}T00:00:00Z`))
    const pruned = pruneBackups(resolve(r.dumpFile, '..'), 2)
    expect(pruned.length).toBe(2)
  })
})

describe('init and doctor', () => {
  it('init writes config, env, key, rules, and provisions; doctor passes on the result', async () => {
    const d = resolve(dir, 'init')
    const answers = {
      accountId: 'shop',
      displayName: 'Shop',
      timezone: 'Asia/Kolkata',
      businessStart: '09:00',
      businessEnd: '18:00',
      operatorNumber: '+919999000000',
      webhookUrl: 'https://ntfy.example/wamcp',
      emailTo: '',
      emailFrom: '',
      databaseUrl: tdb.url,
      acceptTos: true,
    }
    expect(renderConfig(answers)).toContain('id: shop')
    const r = await runInit(answers, d, resolve(d, 'secret', 'master.key'))
    expect(existsSync(r.configPath) && existsSync(r.envPath) && existsSync(r.keyPath)).toBe(true)
    expect(r.rulesInstalled.sort()).toEqual([
      'away-ack.yaml',
      'group-daily-digest.yaml',
      'urgent-notify.yaml',
    ])
    expect(readFileSync(resolve(d, 'rules', 'away-ack.yaml'), 'utf8')).toContain('enabled: false')
    await expect(runInit(answers, d, r.keyPath)).rejects.toThrow(/already exists/)
    await expect(
      runInit({ ...answers, acceptTos: false }, resolve(dir, 'init2'), resolve(dir, 'init2', 'k')),
    ).rejects.toThrow(/Terms of Service/)

    const cfg = parseConfig(readFileSync(r.configPath, 'utf8'), r.configPath)
    const checks = await runDoctorChecks({
      configPath: r.configPath,
      config: cfg,
      masterKeyPath: r.keyPath,
      handle: tdb.handle,
      baileysVersion: '7.0.0-rc14',
      now: new Date(),
    })
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]))
    expect(byName['master key']?.status).toBe('pass')
    expect(byName['operator schema']?.status).toBe('pass')
    expect(byName['operator channels']?.status).toBe('pass')
    expect(byName.baileys?.status).toBe('pass')
    expect(byName['account shop']?.status).toBe('warn') // not provisioned until first serve or pair
    expect(checks.some((c) => c.status === 'fail')).toBe(false)
  })

  it('doctor fails on a world-readable key, a missing channel, and an unknown library version', async () => {
    const d = resolve(dir, 'doc2')
    const keyPath = resolve(d, 'master.key')
    generateMasterKey(keyPath)
    execFileSync('chmod', ['644', keyPath])
    const cfg = parseConfig(CONFIG, resolve(d, 'wamcp.yaml'))
    const checks = await runDoctorChecks({
      configPath: resolve(d, 'wamcp.yaml'),
      config: { ...cfg, operator: { ...cfg.operator, channels: [] } },
      masterKeyPath: keyPath,
      handle: null,
      dbError: 'refused',
      baileysVersion: '6.7.24',
      now: new Date(),
    })
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]))
    expect(byName['master key']?.status).toBe('fail')
    expect(byName.database?.status).toBe('fail')
    expect(byName['operator channels']?.status).toBe('fail')
    expect(byName.baileys?.status).toBe('warn')
  })

  it('doctor warns on stale backups, same-disk backups, loose config modes, expiring tokens, bad zones, and a key inside data', async () => {
    const d = resolve(dir, 'doc3')
    mkdirSync(resolve(d, 'data'), { recursive: true })
    mkdirSync(resolve(d, 'backups', 'main'), { recursive: true })
    const old = resolve(d, 'backups', 'main', 'old.dump')
    writeFileSync(old, 'x')
    utimesSync(old, new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'))
    writeFileSync(resolve(d, '.env'), 'X=1')
    execFileSync('chmod', ['644', resolve(d, '.env')])
    const keyPath = resolve(d, 'data', 'master.key')
    generateMasterKey(keyPath)
    const cfg = parseConfig(CONFIG, resolve(d, 'wamcp.yaml'))
    await ctx.tokens.create({ name: 'soon', scopes: ['read:messages'], accountIds: ['*'], ttlDays: 1 })
    const checks = await runDoctorChecks({
      configPath: resolve(d, 'wamcp.yaml'),
      config: {
        ...cfg,
        accounts: [
          cfg.accounts[0] as never,
          { ...(cfg.accounts[0] as never), id: 'ghost', timezone: 'Not/AZone' },
        ],
      },
      masterKeyPath: keyPath,
      handle: tdb.handle,
      baileysVersion: '7.0.0-rc14',
      now: clock.now(),
      probe: async () => [
        { channel: 'hook', ok: true },
        { channel: 'mail', ok: false, error: 'smtp down' },
        { channel: 'x', ok: false },
      ],
    })
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]))
    expect(byName['master key']).toMatchObject({ status: 'fail', detail: /inside the data directory/ })
    expect(byName['.env mode']?.status).toBe('warn')
    expect(byName['account main']?.status).toBe('pass') // provisioned by the serve test above
    expect(byName.tokens).toMatchObject({ status: 'warn', detail: /soon expire/ })
    expect(byName['channel hook']?.status).toBe('pass')
    expect(byName['channel mail']?.detail).toBe('smtp down')
    expect(byName['channel x']?.detail).toBe('failed')
    expect(byName.backups).toMatchObject({ status: 'warn', detail: /h old/ })
    expect(byName['backup location']?.status).toBe('warn')
    expect(byName['timezone ghost']?.status).toBe('fail')
    expect(byName.disk?.status).toBeDefined()
    // an empty backup dir and a database that errors mid-check
    rmSync(old)
    const broken = {
      ...tdb.handle,
      pool: {
        query: async () => {
          throw new Error('boom')
        },
      },
    } as never
    const again = await runDoctorChecks({
      configPath: resolve(d, 'wamcp.yaml'),
      config: cfg,
      masterKeyPath: keyPath,
      handle: broken,
      baileysVersion: '7.0.0-rc14',
      now: clock.now(),
    })
    const again2 = Object.fromEntries(again.map((c) => [c.name, c]))
    expect(again2.backups).toMatchObject({ status: 'warn', detail: 'no backups yet' })
    expect(again2.database).toMatchObject({ status: 'fail', detail: 'boom' })
  })
})

describe('context helpers and runtimes', () => {
  it('resolves config paths, actor names, output modes, and tables', () => {
    const prev = process.env.WAMCP_CONFIG
    process.env.WAMCP_CONFIG = '~/x.yaml'
    expect(resolveConfigPath()).toMatch(/\/x\.yaml$/)
    expect(resolveConfigPath()).not.toContain('~')
    process.env.WAMCP_CONFIG = undefined as never
    delete process.env.WAMCP_CONFIG
    expect(resolveConfigPath()).toBe('./wamcp.yaml')
    expect(resolveConfigPath('/a.yaml')).toBe('/a.yaml')
    if (prev !== undefined) process.env.WAMCP_CONFIG = prev
    expect(cliActor()).toMatch(/^cli:/)
    const writes: string[] = []
    const orig = process.stdout.write
    process.stdout.write = ((s: string) => {
      writes.push(s)
      return true
    }) as never
    try {
      out({ json: true }, { a: 1 }, () => 'human')
      out({}, { a: 1 }, () => 'human')
    } finally {
      process.stdout.write = orig
    }
    expect(writes).toEqual(['{\n  "a": 1\n}\n', 'human\n'])
    expect(table([], ['a'])).toBe('(none)')
    expect(table([{ a: 'x', b: null }], ['a', 'b'])).toBe('a  b\n-  -\nx   ')
  })

  it('loadContext reads .env, config, key, and opens the database; buildRuntimes honours only and type', async () => {
    const d = resolve(dir, 'ctx')
    mkdirSync(d, { recursive: true })
    writeFileSync(resolve(d, 'wamcp.yaml'), CONFIG)
    writeFileSync(
      resolve(d, '.env'),
      `DATABASE_URL=${tdb.url}\nWAMCP_MASTER_KEY_FILE=${ctx.masterKey.path}\n`,
    )
    const loaded = await loadContext({ config: resolve(d, 'wamcp.yaml'), verbose: true })
    try {
      expect(loaded.masterKey.id).toBe(ctx.masterKey.id)
      expect(loaded.config.accounts[0]?.id).toBe('main')
      const rts = await buildRuntimes(loaded, { fake: true, only: 'nope' })
      expect(rts.size).toBe(0)
      const web = await buildRuntimes(loaded, {
        fake: false,
        onQr: () => undefined,
        onPairingCode: () => undefined,
        onState: () => undefined,
        pairingPhones: { main: '+919999000000' },
      })
      expect(web.get('main')?.connector.constructor.name).toBe('WebConnector')
      const cloud = {
        ...loaded,
        config: { ...loaded.config, accounts: [{ ...(loaded.config.accounts[0] as never), type: 'cloud' }] },
      }
      await expect(buildRuntimes(cloud as never, { fake: false })).rejects.toThrow(/not supported yet/)
    } finally {
      await loaded.close()
    }
    const noKey = await loadContext({ config: resolve(d, 'wamcp.yaml') }, { needKey: false })
    expect(noKey.masterKey.id).toBe('none')
    await noKey.close()
  })
})
