import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Throwaway local Postgres for tests (tech-stack T14). Uses initdb/pg_ctl from the host; when
 * running as root (as in some containers) it drops to the `postgres` user because Postgres refuses
 * to run as root.
 */
export interface TestPostgres {
  url: string
  dataDir: string
  port: number
  stop(): void
}

function findPgBin(): string {
  const fromEnv = process.env.PG_BIN
  if (fromEnv && existsSync(join(fromEnv, 'initdb'))) return fromEnv
  try {
    const bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
    if (existsSync(join(bindir, 'initdb'))) return bindir
  } catch {
    /* fall through */
  }
  const base = '/usr/lib/postgresql'
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a))
    for (const v of versions) {
      const bin = join(base, v, 'bin')
      if (existsSync(join(bin, 'initdb'))) return bin
    }
  }
  for (const bin of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/pgsql/bin']) {
    if (existsSync(join(bin, 'initdb'))) return bin
  }
  throw new Error('Postgres binaries not found; install postgresql-16 or set PG_BIN')
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? res(port) : rej(new Error('no port'))))
    })
  })
}

function runAs(user: string | undefined, file: string, args: string[]) {
  const cmd = user ? 'runuser' : file
  const argv = user ? ['-u', user, '--', file, ...args] : args
  const r = spawnSync(cmd, argv, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const bin = findPgBin()
  const isRoot = process.getuid?.() === 0
  const user = isRoot ? 'postgres' : undefined
  const dataDir = mkdtempSync(join(tmpdir(), 'wamcp-pg-'))
  if (user) execFileSync('chown', ['-R', `${user}:`, dataDir])
  runAs(user, join(bin, 'initdb'), [
    '-D',
    dataDir,
    '--auth=trust',
    '--username=postgres',
    '--no-sync',
    '-E',
    'UTF8',
  ])
  const port = await freePort()
  const pgOpts = `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c log_min_messages=warning`
  runAs(user, join(bin, 'pg_ctl'), [
    '-D',
    dataDir,
    '-l',
    join(dataDir, 'pg.log'),
    '-o',
    pgOpts,
    '-w',
    'start',
  ])
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`
  return {
    url,
    dataDir,
    port,
    stop() {
      try {
        runAs(user, join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'])
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
}
