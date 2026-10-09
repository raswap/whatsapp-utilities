import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type Clock,
  type Codec,
  codecFor,
  createLogger,
  type DbHandle,
  expandHome,
  loadConfigFile,
  loadMasterKey,
  loadSecrets,
  type MasterKey,
  OperatorChannel,
  OperatorState,
  openDatabase,
  type Secrets,
  systemClock,
  TokenStore,
  type WamcpConfig,
} from '@wamcp/core'
import dotenv from 'dotenv'
import type { Logger } from 'pino'

export interface CliContext {
  configPath: string
  config: WamcpConfig
  secrets: Secrets
  masterKey: MasterKey
  codec: Codec
  handle: DbHandle
  tokens: TokenStore
  operator: OperatorChannel
  operatorState: OperatorState
  log: Logger
  clock: Clock
  close(): Promise<void>
}

export interface GlobalOptions {
  config?: string
  verbose?: boolean
  json?: boolean
}

export function resolveConfigPath(opt?: string): string {
  return expandHome(opt ?? process.env.WAMCP_CONFIG ?? './wamcp.yaml')
}

/** Loads .env, config, secrets, master key, and opens the database. Commands call this once. */
export async function loadContext(
  opts: GlobalOptions,
  extra: { needDb?: boolean; needKey?: boolean } = {},
): Promise<CliContext> {
  const configPath = resolveConfigPath(opts.config)
  const envPath = resolve(configPath, '..', '.env')
  if (existsSync(envPath)) dotenv.config({ path: envPath, quiet: true })
  const log = createLogger({
    level: opts.verbose ? 'debug' : (process.env.LOG_LEVEL ?? 'info'),
    pretty: process.stdout.isTTY === true,
  })
  const config = loadConfigFile(configPath)
  const secrets = loadSecrets()
  const needKey = extra.needKey !== false
  const masterKey = needKey
    ? loadMasterKey(secrets.WAMCP_MASTER_KEY_FILE, {
        forbidUnder: resolve(configPath, '..', config.server.data_dir),
      })
    : ({ id: 'none', bytes: Buffer.alloc(32), path: '' } as MasterKey)
  const codec = codecFor(masterKey)
  const handle = openDatabase(secrets.DATABASE_URL, { applicationName: 'wamcp-cli' })
  const clock = systemClock
  const operator = new OperatorChannel({ config: config.operator, env: process.env, log, clock })
  return {
    configPath,
    config,
    secrets,
    masterKey,
    codec,
    handle,
    tokens: new TokenStore(handle.db, clock),
    operator,
    operatorState: new OperatorState(handle.db),
    log,
    clock,
    close: () => handle.close(),
  }
}

export function cliActor(): string {
  return `cli:${process.env.USER ?? process.env.USERNAME ?? 'operator'}`
}

export function out(opts: GlobalOptions, data: unknown, human: () => string) {
  if (opts.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  else process.stdout.write(`${human()}\n`)
}

export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return '(none)'
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const line = (cells: string[]) => cells.map((v, i) => v.padEnd(widths[i] as number)).join('  ')
  return [
    line(columns),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(columns.map((c) => String(r[c] ?? '')))),
  ].join('\n')
}
