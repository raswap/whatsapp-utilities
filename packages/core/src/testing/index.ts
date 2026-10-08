import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { type DbHandle, openDatabase } from '../db/client.js'
import { provisionOperator } from '../db/provision.js'

export { startTestPostgres, type TestPostgres } from './postgres.js'

/** Admin URL for the harness-started Postgres; set by the vitest global setup. */
export function testAdminUrl(): string {
  const url = process.env.WAMCP_TEST_PG_URL
  if (!url) throw new Error('WAMCP_TEST_PG_URL is not set; is the vitest global setup running?')
  return url
}

export interface TestDatabase {
  url: string
  name: string
  handle: DbHandle
  drop(): Promise<void>
}

/** Creates a fresh database with the operator schema applied. Call drop() in afterAll. */
export async function createTestDatabase(opts: { provision?: boolean } = {}): Promise<TestDatabase> {
  const adminUrl = testAdminUrl()
  const name = `t_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`create database "${name}"`)
  await admin.end()
  const url = adminUrl.replace(/\/postgres$/, `/${name}`)
  const handle = openDatabase(url, { max: 4, applicationName: 'wamcp-test' })
  if (opts.provision !== false) await provisionOperator(handle)
  return {
    url,
    name,
    handle,
    async drop() {
      await handle.close()
      const a = new pg.Client({ connectionString: adminUrl })
      await a.connect()
      await a.query(`drop database if exists "${name}" with (force)`)
      await a.end()
    },
  }
}
