import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

export type Db = NodePgDatabase<Record<string, never>>

export interface DbHandle {
  pool: pg.Pool
  db: Db
  close(): Promise<void>
}

export interface OpenOptions {
  max?: number
  applicationName?: string
}

export function openDatabase(url: string, opts: OpenOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'wamcp',
  })
  const db = drizzle(pool)
  return {
    pool,
    db,
    close: () => pool.end(),
  }
}
