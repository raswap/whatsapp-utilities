import { startTestPostgres, type TestPostgres } from '../packages/core/src/testing/postgres.js'

let pgInstance: TestPostgres | undefined

export async function setup() {
  if (process.env.WAMCP_TEST_PG_URL) return
  pgInstance = await startTestPostgres()
  process.env.WAMCP_TEST_PG_URL = pgInstance.url
}

export async function teardown() {
  pgInstance?.stop()
}
