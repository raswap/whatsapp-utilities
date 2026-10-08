import { eq } from 'drizzle-orm'
import { jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core'
import type { Db } from '../db/client.js'

/** Small key/value state per account (dispatch watermark and friends). */
export class PipelineState {
  private readonly table

  constructor(
    private readonly db: Db,
    schemaName: string,
  ) {
    this.table = pgSchema(schemaName).table('pipeline_state', {
      key: text('key').primaryKey(),
      value: jsonb('value').notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    })
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db
      .select({ v: this.table.value })
      .from(this.table)
      .where(eq(this.table.key, key))
    return row ? (row.v as T) : fallback
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(this.table)
      .values({ key, value })
      .onConflictDoUpdate({ target: this.table.key, set: { value, updatedAt: new Date() } })
  }
}
