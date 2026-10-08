import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type DbHandle,
  listAccountSchemas,
  pendingMigrations,
  tokens as tokensTable,
  type WamcpConfig,
} from '@wamcp/core'
import { gt, isNull } from 'drizzle-orm'

export type CheckStatus = 'pass' | 'warn' | 'fail'
export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

/** The pinned, known-good Baileys versions (PRD §11 protocol-break row). Update deliberately. */
export const KNOWN_GOOD_BAILEYS = ['7.0.0-rc14']

export interface DoctorInput {
  configPath: string
  config: WamcpConfig
  masterKeyPath: string
  handle: DbHandle | null
  dbError?: string
  baileysVersion: string
  now: Date
  /** Optional: probe operator channels. */
  probe?: () => Promise<Array<{ channel: string; ok: boolean; error?: string }>>
}

export async function runDoctorChecks(i: DoctorInput): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const dir = resolve(i.configPath, '..')
  const dataDir = resolve(dir, i.config.server.data_dir)

  // master key
  if (!existsSync(i.masterKeyPath))
    out.push({ name: 'master key', status: 'fail', detail: `${i.masterKeyPath} not found; run wamcp init` })
  else {
    const mode = statSync(i.masterKeyPath).mode & 0o777
    if (mode & 0o077)
      out.push({
        name: 'master key',
        status: 'fail',
        detail: `mode ${mode.toString(8)} is readable by others; chmod 600`,
      })
    else if (i.masterKeyPath.startsWith(`${dataDir}/`))
      out.push({ name: 'master key', status: 'fail', detail: 'key file lives inside the data directory' })
    else out.push({ name: 'master key', status: 'pass', detail: i.masterKeyPath })
  }

  // config files mode
  for (const f of ['wamcp.yaml', '.env']) {
    const p = resolve(dir, f)
    if (!existsSync(p)) continue
    const mode = statSync(p).mode & 0o777
    out.push({ name: `${f} mode`, status: mode & 0o077 ? 'warn' : 'pass', detail: mode.toString(8) })
  }

  // database
  if (!i.handle) out.push({ name: 'database', status: 'fail', detail: i.dbError ?? 'not reachable' })
  else {
    try {
      const v = await i.handle.pool.query<{ v: string }>('select version() as v')
      out.push({ name: 'database', status: 'pass', detail: (v.rows[0]?.v ?? '').split(' on ')[0] ?? 'ok' })
      const pendingOp = await pendingMigrations(i.handle.pool, 'operator', 'operator')
      out.push({
        name: 'operator schema',
        status: pendingOp.length ? 'fail' : 'pass',
        detail: pendingOp.length
          ? `${pendingOp.length} pending migrations; run wamcp serve or wamcp init`
          : 'up to date',
      })
      const schemas = await listAccountSchemas(i.handle)
      for (const a of i.config.accounts) {
        const s = `acct_${a.id}`
        if (!schemas.includes(s))
          out.push({
            name: `account ${a.id}`,
            status: 'warn',
            detail: 'not provisioned yet (first serve or pair provisions it)',
          })
        else {
          const pend = await pendingMigrations(i.handle.pool, 'account', s)
          out.push({
            name: `account ${a.id}`,
            status: pend.length ? 'fail' : 'pass',
            detail: pend.length ? `${pend.length} pending migrations` : 'schema up to date',
          })
        }
      }
      const soon = new Date(i.now.getTime() + 7 * 86_400_000)
      const expiring = await i.handle.db
        .select({ name: tokensTable.name, expiresAt: tokensTable.expiresAt })
        .from(tokensTable)
        .where(isNull(tokensTable.revokedAt))
      const exp = expiring.filter((t) => t.expiresAt && t.expiresAt < soon)
      out.push({
        name: 'tokens',
        status: exp.length ? 'warn' : 'pass',
        detail: exp.length
          ? `${exp.map((t) => t.name).join(', ')} expire within 7 days`
          : `${expiring.length} active`,
      })
      void gt
    } catch (e) {
      out.push({ name: 'database', status: 'fail', detail: (e as Error).message })
    }
  }

  // operator channels (D11)
  const nonWa = i.config.operator.channels.filter((c) => c.kind === 'webhook' || c.kind === 'email')
  const hasWeb = i.config.accounts.some((a) => a.type === 'web')
  if (hasWeb && nonWa.length === 0)
    out.push({
      name: 'operator channels',
      status: 'fail',
      detail: 'a web account requires a webhook or email channel (PRD D11)',
    })
  else
    out.push({
      name: 'operator channels',
      status: 'pass',
      detail: nonWa.map((c) => `${c.kind}:${c.name}`).join(', ') || 'none configured',
    })
  if (i.probe) {
    for (const r of await i.probe())
      out.push({
        name: `channel ${r.channel}`,
        status: r.ok ? 'pass' : 'fail',
        detail: r.ok ? 'delivered' : (r.error ?? 'failed'),
      })
  }

  // disk
  try {
    const target = existsSync(dataDir) ? dataDir : dir
    const st = statfsSync(target)
    const freeBytes = Number(st.bavail) * Number(st.bsize)
    const totalBytes = Number(st.blocks) * Number(st.bsize)
    const freeGb = freeBytes / 1e9
    const pct = totalBytes ? (freeBytes / totalBytes) * 100 : 100
    const status: CheckStatus = freeGb < 1 || pct < 10 ? 'fail' : freeGb < 5 ? 'warn' : 'pass'
    out.push({
      name: 'disk',
      status,
      detail: `${freeGb.toFixed(1)} GB free (${pct.toFixed(0)} %) at ${target}`,
    })
  } catch (e) {
    out.push({ name: 'disk', status: 'warn', detail: (e as Error).message })
  }

  // backups
  const backupDir = resolve(dir, i.config.server.backup_dir)
  if (!existsSync(backupDir))
    out.push({ name: 'backups', status: 'warn', detail: `${backupDir} does not exist; run wamcp backup` })
  else {
    let newest = 0
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = resolve(d, f.name)
        if (f.isDirectory()) walk(p)
        else newest = Math.max(newest, statSync(p).mtimeMs)
      }
    }
    walk(backupDir)
    if (!newest) out.push({ name: 'backups', status: 'warn', detail: 'no backups yet' })
    else {
      const ageH = (i.now.getTime() - newest) / 3600_000
      out.push({
        name: 'backups',
        status: ageH > 25 ? 'warn' : 'pass',
        detail: `newest is ${ageH.toFixed(1)} h old`,
      })
    }
    try {
      const same = statSync(backupDir).dev === statSync(existsSync(dataDir) ? dataDir : dir).dev
      if (same)
        out.push({
          name: 'backup location',
          status: 'warn',
          detail: 'backups are on the same disk as the data directory',
        })
    } catch {
      /* ignore */
    }
  }

  // library pin
  out.push({
    name: 'baileys',
    status: KNOWN_GOOD_BAILEYS.includes(i.baileysVersion) ? 'pass' : 'warn',
    detail: `${i.baileysVersion}${KNOWN_GOOD_BAILEYS.includes(i.baileysVersion) ? ' (known good)' : ` not in known-good list ${KNOWN_GOOD_BAILEYS.join(', ')}`}`,
  })

  // time zones and clock
  for (const a of i.config.accounts) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: a.timezone })
      out.push({ name: `timezone ${a.id}`, status: 'pass', detail: a.timezone })
    } catch {
      out.push({ name: `timezone ${a.id}`, status: 'fail', detail: `invalid zone ${a.timezone}` })
    }
  }
  try {
    const td = execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim()
    out.push({
      name: 'clock',
      status: td === 'yes' ? 'pass' : 'warn',
      detail: td === 'yes' ? 'NTP synchronized' : 'NTP not synchronized',
    })
  } catch {
    out.push({ name: 'clock', status: 'warn', detail: 'could not verify NTP sync (timedatectl unavailable)' })
  }

  // pg_dump available for backups
  try {
    const v = execFileSync('pg_dump', ['--version'], { encoding: 'utf8', timeout: 2000 }).trim()
    out.push({ name: 'pg_dump', status: 'pass', detail: v })
  } catch {
    out.push({ name: 'pg_dump', status: 'warn', detail: 'pg_dump not found; wamcp backup will fail' })
  }

  return out
}
