import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codecFor,
  generateMasterKey,
  ManualClock,
  OperatorChannel,
  OperatorState,
  parseConfig,
  TokenStore,
} from '@wamcp/core'
import { createTestDatabase, type TestDatabase } from '@wamcp/core/testing'
import { Command } from 'commander'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CliContext } from '../context.js'
import { registerRules } from './rules.js'

vi.mock('../context.js', async (orig) => ({
  ...(await orig<typeof import('../context.js')>()),
  loadContext: vi.fn(async () => ctx),
}))

const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rules', 'starter')

let tdb: TestDatabase
let dir: string
let rulesDir: string
let ctx: CliContext
const log = pino({ level: 'silent' })
const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))

const CONFIG = `
version: 1
server: { http: { bind: 127.0.0.1, port: 0 }, data_dir: ./data, backup_dir: ./backups }
operator:
  channels:
    - { kind: webhook, name: hook, url: https://example.invalid/hook }
accounts:
  - { id: main, type: web, display_name: Main, timezone: UTC }
targets:
  crm: { kind: http, url: https://crm.example.com/hook }
`

const ACCOUNT_RULE = `id: main-tag\nscope:\n  account: main\nwhen:\n  event: message.received\nactions:\n  - set_label: seen\n`

async function run(...args: string[]): Promise<{ stdout: string; exitCode: number | undefined }> {
  const program = new Command()
  program
    .name('wamcp')
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .option('-c, --config <path>')
    .option('--json')
    .option('-v, --verbose')
  registerRules(program)
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
  dir = mkdtempSync(resolve(tmpdir(), 'wamcp-rules-cli-'))
  rulesDir = resolve(dir, 'rules')
  cpSync(STARTER, rulesDir, { recursive: true })
  const configPath = resolve(dir, 'wamcp.yaml')
  writeFileSync(configPath, CONFIG)
  const key = generateMasterKey(resolve(dir, 'keys', 'master.key'))
  const config = parseConfig(CONFIG, configPath)
  ctx = {
    configPath,
    config,
    secrets: { DATABASE_URL: tdb.url, WAMCP_MASTER_KEY_FILE: key.path, LOG_LEVEL: 'info' },
    masterKey: key,
    codec: codecFor(key),
    handle: tdb.handle,
    tokens: new TokenStore(tdb.handle.db, clock),
    operator: new OperatorChannel({ config: config.operator, env: {}, log, clock }),
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

describe('wamcp rules', () => {
  it('import from the default directory next to the config, then ls and show', async () => {
    const r = await run('rules', 'import')
    expect(r.exitCode).toBeUndefined()
    expect(r.stdout).toMatch(/urgent-notify\.yaml\s+urgent-notify\s+global\s+1\s+imported \(disabled\)/)
    expect((await json('--json', 'rules', 'import')).data).toMatchObject({
      ok: true,
      rules: [{ id: 'away-ack', changed: false }, { id: 'group-daily-digest' }, { id: 'urgent-notify' }],
    })
    const ls = await json('--json', 'rules', 'ls')
    expect(ls.data).toEqual([
      expect.objectContaining({
        id: 'away-ack',
        scope: 'global',
        enabled: 'no',
        event: 'message.received',
        actions: 'send_message',
      }),
      expect.objectContaining({
        id: 'group-daily-digest',
        event: 'schedule.cron',
        actions: 'notify_operator',
      }),
      expect.objectContaining({ id: 'urgent-notify', actions: 'set_label,notify_operator' }),
    ])
    expect((await run('rules', 'ls')).stdout).toMatch(
      /^id\s+scope\s+version\s+enabled\s+suspended\s+errors\s+event\s+actions\s*\n/,
    )
    expect((await json('--json', 'rules', 'ls', '--account', 'main')).data).toEqual([])
    expect((await run('rules', 'ls', '--account', 'main')).stdout).toBe('(none)\n')
    expect((await json('--json', 'rules', 'ls', '--global')).data).toHaveLength(3)
    await expect(run('rules', 'ls', '--account', 'ghost')).rejects.toThrow(/no account ghost/)

    const show = await run('rules', 'show', 'urgent-notify')
    expect(show.stdout).toMatch(
      /^id: urgent-notify\nscope: global\nenabled: no\nsuspended: no\nerrors: 0\nversions: 1 \(cli:[^,]+, 20\d\d-\S+\)\n---\n# Starter rule/,
    )
    expect(show.stdout).toContain('approval: approve')
    const j = await json('--json', 'rules', 'show', 'urgent-notify')
    expect(j.data).toMatchObject({
      id: 'urgent-notify',
      version: 1,
      definition: { id: 'urgent-notify' },
      versions: [{ version: 1 }],
    })
    await expect(run('rules', 'show', 'nope')).rejects.toThrow(/no rule nope/)
  })

  it('enable, disable, rollback', async () => {
    expect((await run('rules', 'enable', 'urgent-notify')).stdout).toBe('urgent-notify enabled\n')
    expect((await json('--json', 'rules', 'ls', '--global')).data[2]).toMatchObject({
      id: 'urgent-notify',
      enabled: 'yes',
    })
    expect((await json('--json', 'rules', 'disable', 'urgent-notify')).data).toMatchObject({
      id: 'urgent-notify',
      enabled: 'no',
    })
    await expect(run('rules', 'enable', 'nope')).rejects.toThrow(/no rule nope/)

    expect((await run('rules', 'rollback', 'urgent-notify', '1')).stdout).toBe(
      'urgent-notify already matches version 1\n',
    )
    const file = resolve(rulesDir, 'urgent-notify.yaml')
    const v1 = readFileSync(file, 'utf8')
    writeFileSync(file, v1.replace('"asap"', '"asap", "now"'))
    expect((await json('--json', 'rules', 'import')).data.rules[2]).toMatchObject({
      id: 'urgent-notify',
      version: 2,
    })
    const rb = await json('--json', 'rules', 'rollback', 'urgent-notify', '1')
    expect(rb.data).toMatchObject({ id: 'urgent-notify', version: 3, changed: true })
    const shown = await json('--json', 'rules', 'show', 'urgent-notify')
    expect(shown.data.yaml).not.toContain('"now"')
    expect(shown.data.versions).toHaveLength(3)
    expect((await run('rules', 'rollback', 'urgent-notify', '2')).stdout).toBe(
      'urgent-notify rolled back to version 2 as version 4\n',
    )
    await expect(run('rules', 'rollback', 'urgent-notify', 'two')).rejects.toThrow(/positive integer/)
    await expect(run('rules', 'rollback', 'urgent-notify', '99')).rejects.toThrow(/no version 99/)
    writeFileSync(file, v1)
  })

  it('import reports every error and imports nothing; export writes one file per rule', async () => {
    const bad = resolve(dir, 'bad')
    mkdirSync(bad)
    writeFileSync(resolve(bad, 'a.yaml'), ACCOUNT_RULE)
    writeFileSync(
      resolve(bad, 'b.yaml'),
      ACCOUNT_RULE.replace('main-tag', 'b').replace('set_label: seen', 'send_media: x'),
    )
    const r = await run('rules', 'import', bad)
    expect(r).toEqual({ stdout: 'b.yaml actions.0: unknown action kind "send_media"\n', exitCode: 1 })
    expect((await json('--json', 'rules', 'ls', '--account', 'main')).data).toEqual([])
    rmSync(resolve(bad, 'b.yaml'))
    expect((await json('--json', 'rules', 'import', bad)).data).toMatchObject({
      ok: true,
      rules: [{ id: 'main-tag', account: 'main' }],
    })
    expect((await json('--json', 'rules', 'ls', '--account', 'main')).data).toMatchObject([
      { id: 'main-tag', scope: 'main' },
    ])
    const empty = resolve(dir, 'empty')
    mkdirSync(empty)
    expect((await run('rules', 'import', empty)).stdout).toBe('no rule files found\n')

    const outDir = resolve(dir, 'exported')
    const ex = await run('rules', 'export', outDir)
    expect(ex.stdout).toMatch(/^id\s+scope\s+file\s*\n/)
    expect(readdirSync(outDir).sort()).toEqual([
      'away-ack.yaml',
      'group-daily-digest.yaml',
      'main-tag.yaml',
      'urgent-notify.yaml',
    ])
    expect(readFileSync(resolve(outDir, 'main-tag.yaml'), 'utf8')).toBe(
      (await json('--json', 'rules', 'show', 'main-tag')).data.yaml,
    )
    const again = await json('--json', 'rules', 'export')
    expect(again.data).toEqual(
      expect.arrayContaining([{ id: 'main-tag', scope: 'main', file: resolve(rulesDir, 'main-tag.yaml') }]),
    )
    expect(existsSync(resolve(rulesDir, 'main-tag.yaml'))).toBe(true)
    rmSync(resolve(rulesDir, 'main-tag.yaml'))
    // Re-importing exported files is a no-op.
    expect(
      (await json('--json', 'rules', 'import', outDir)).data.rules.every(
        (x: { changed: boolean }) => !x.changed,
      ),
    ).toBe(true)
  })

  it('import --watch re-imports on change until SIGINT', async () => {
    const watched = resolve(dir, 'watched')
    mkdirSync(watched)
    const running = run('rules', 'import', watched, '--watch')
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(resolve(watched, 'w.yaml'), ACCOUNT_RULE.replace('main-tag', 'watched-rule'))
    await new Promise((r) => setTimeout(r, 1500))
    process.emit('SIGINT', 'SIGINT')
    const r = await running
    expect(r.stdout).toMatch(/^no rule files found\nwatching .*watched \(Ctrl-C to stop\)\n/)
    expect(r.stdout).toMatch(/w\.yaml\s+watched-rule\s+main\s+1\s+imported \(disabled\)/)
    expect((await json('--json', 'rules', 'show', 'watched-rule')).data).toMatchObject({
      account: 'main',
      version: 1,
    })
  })
})
