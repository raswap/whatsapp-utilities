import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'

export type MigrationSet = 'operator' | 'account'

const MIGRATIONS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/

export interface MigrationFile {
  name: string
  sql: string
}

export function listMigrations(set: MigrationSet, root = MIGRATIONS_ROOT): MigrationFile[] {
  const dir = join(root, set)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

export interface ApplyResult {
  applied: string[]
  skipped: string[]
}

/**
 * Applies a migration set to one schema. Each file runs in its own transaction and is recorded in
 * `<schema>.schema_migrations`, so a failure leaves the schema at the last fully applied file.
 */
export async function applyMigrations(
  pool: pg.Pool,
  set: MigrationSet,
  schemaName: string,
  opts: { root?: string } = {},
): Promise<ApplyResult> {
  if (!SCHEMA_NAME.test(schemaName)) throw new Error(`invalid schema name: ${schemaName}`)
  const files = listMigrations(set, opts.root)
  const client = await pool.connect()
  const applied: string[] = []
  const skipped: string[] = []
  try {
    await client.query(`create schema if not exists "${schemaName}"`)
    await client.query(
      `create table if not exists "${schemaName}".schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
    )
    const done = new Set(
      (await client.query<{ name: string }>(`select name from "${schemaName}".schema_migrations`)).rows.map(
        (r) => r.name,
      ),
    )
    for (const f of files) {
      if (done.has(f.name)) {
        skipped.push(f.name)
        continue
      }
      await client.query('begin')
      try {
        await client.query(f.sql.replaceAll('__SCHEMA__', `"${schemaName}"`))
        await client.query(`insert into "${schemaName}".schema_migrations (name) values ($1)`, [f.name])
        await client.query('commit')
        applied.push(f.name)
      } catch (e) {
        await client.query('rollback')
        throw new Error(`migration ${set}/${f.name} failed on schema ${schemaName}: ${(e as Error).message}`)
      }
    }
  } finally {
    client.release()
  }
  return { applied, skipped }
}

export async function pendingMigrations(
  pool: pg.Pool,
  set: MigrationSet,
  schemaName: string,
): Promise<string[]> {
  if (!SCHEMA_NAME.test(schemaName)) throw new Error(`invalid schema name: ${schemaName}`)
  const files = listMigrations(set)
  const exists = await pool.query(
    `select 1 from information_schema.tables where table_schema = $1 and table_name = 'schema_migrations'`,
    [schemaName],
  )
  if (exists.rowCount === 0) return files.map((f) => f.name)
  const done = new Set(
    (await pool.query<{ name: string }>(`select name from "${schemaName}".schema_migrations`)).rows.map(
      (r) => r.name,
    ),
  )
  return files.filter((f) => !done.has(f.name)).map((f) => f.name)
}
