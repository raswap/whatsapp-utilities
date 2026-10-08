import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decrypt, encrypt, envelopeKeyId, tablesFor } from '@wamcp/core'
import type { Command } from 'commander'
import { type CliContext, cliActor, type GlobalOptions, loadContext, out } from '../context.js'

export interface BackupResult {
  account: string
  dumpFile: string
  sessionFile: string
  bytes: number
}

/** Encrypted `pg_dump --schema` per account plus a session sidecar (PRD §13 backups). */
export async function backupAccount(
  ctx: CliContext,
  accountId: string,
  when = new Date(),
): Promise<BackupResult> {
  const schema = `acct_${accountId}`
  const dir = resolve(ctx.configPath, '..', ctx.config.server.backup_dir, accountId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = when.toISOString().replace(/[:.]/g, '-')
  const dump = execFileSync(
    'pg_dump',
    [
      '--dbname',
      ctx.secrets.DATABASE_URL,
      '--schema',
      schema,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  )
  const dumpFile = resolve(dir, `${stamp}.${ctx.masterKey.id}.sql.enc`)
  writeFileSync(dumpFile, encrypt(ctx.masterKey, dump, `backup:${schema}`), { mode: 0o600 })
  const rows = await ctx.handle.db.select().from(tablesFor(schema).sessionState)
  const sessionFile = resolve(dir, 'session.enc')
  writeFileSync(sessionFile, encrypt(ctx.masterKey, JSON.stringify(rows), `session_sidecar:${schema}`), {
    mode: 0o600,
  })
  return { account: accountId, dumpFile, sessionFile, bytes: dump.length }
}

export async function backupOperator(ctx: CliContext, when = new Date()): Promise<string> {
  const dir = resolve(ctx.configPath, '..', ctx.config.server.backup_dir, '_operator')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = when.toISOString().replace(/[:.]/g, '-')
  const dump = execFileSync(
    'pg_dump',
    [
      '--dbname',
      ctx.secrets.DATABASE_URL,
      '--schema',
      'operator',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const file = resolve(dir, `${stamp}.${ctx.masterKey.id}.sql.enc`)
  writeFileSync(file, encrypt(ctx.masterKey, dump, 'backup:operator'), { mode: 0o600 })
  return file
}

export function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql.enc'))
    .sort()
  const victims = files.slice(0, Math.max(0, files.length - keep))
  for (const v of victims) execFileSync('rm', ['-f', resolve(dir, v)])
  return victims
}

export interface RestoreOptions {
  mode: 'db-only' | 'full'
}

/**
 * Restores an account schema from an encrypted dump. `db-only` keeps the live session by
 * re-applying the newest session sidecar after the restore; `full` restores the dump's session
 * state as-is and warns that re-pairing may be required.
 */
export async function restoreAccount(
  ctx: CliContext,
  accountId: string,
  dumpFile: string,
  o: RestoreOptions,
): Promise<{ restoredRows: number; sessionReapplied: boolean }> {
  const schema = `acct_${accountId}`
  const envelope = readFileSync(dumpFile, 'utf8')
  const keyId = envelopeKeyId(envelope)
  if (keyId !== ctx.masterKey.id)
    throw new Error(`backup was encrypted with master key ${keyId}; current key is ${ctx.masterKey.id}`)
  const sql = decrypt(ctx.masterKey, envelope, `backup:${schema}`).toString('utf8')
  // Snapshot the live session before the dump replaces it.
  const live = await ctx.handle.db.select().from(tablesFor(schema).sessionState)
  execFileSync(
    'psql',
    ['--dbname', ctx.secrets.DATABASE_URL, '--quiet', '--set', 'ON_ERROR_STOP=1', '--file', '-'],
    { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  )
  let sessionReapplied = false
  if (o.mode === 'db-only' && live.length) {
    const t = tablesFor(schema).sessionState
    await ctx.handle.db.transaction(async (tx) => {
      await tx.delete(t)
      for (const r of live) await tx.insert(t).values(r)
    })
    sessionReapplied = true
  }
  const [count] = await ctx.handle.db.select().from(tablesFor(schema).events).limit(1)
  await ctx.handle.db
    .insert(tablesFor(schema).auditLog)
    .values({
      id: `restore-${Date.now()}`,
      actor: cliActor(),
      kind: 'account',
      subjectId: accountId,
      decision: `restored:${o.mode}`,
      detail: { dumpFile },
      hash: 'restore',
    })
    .catch(() => undefined)
  return { restoredRows: count ? 1 : 0, sessionReapplied }
}

export function registerBackup(program: Command) {
  program
    .command('backup')
    .option('--account <id>', 'only this account (default: all accounts and the operator schema)')
    .option('--keep <n>', 'backups to retain per account', '7')
    .description('encrypted pg_dump of each account schema plus a session sidecar')
    .action(async (o: { account?: string; keep: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const results: unknown[] = []
        for (const a of ctx.config.accounts) {
          if (o.account && a.id !== o.account) continue
          const r = await backupAccount(ctx, a.id)
          const pruned = pruneBackups(resolve(r.dumpFile, '..'), Number(o.keep))
          results.push({ ...r, pruned })
        }
        if (!o.account) results.push({ operator: await backupOperator(ctx) })
        out(opts, results, () => results.map((r) => JSON.stringify(r)).join('\n'))
      } finally {
        await ctx.close()
      }
    })
  program
    .command('restore <account> <file>')
    .option('--db-only', 'restore data but keep the live session (default)')
    .option('--full', 'restore the dump including its session state; may require re-pairing')
    .description('restore an account schema from an encrypted backup')
    .action(async (account: string, file: string, o: { dbOnly?: boolean; full?: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const r = await restoreAccount(ctx, account, resolve(file), { mode: o.full ? 'full' : 'db-only' })
        out(
          opts,
          r,
          () =>
            `restored ${account} from ${file}${r.sessionReapplied ? ' (live session kept)' : ' (session from backup; re-pair if WhatsApp reports Bad MAC or logged out)'}`,
        )
      } finally {
        await ctx.close()
      }
    })
}
