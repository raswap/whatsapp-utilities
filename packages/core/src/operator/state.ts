import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { accounts, operatorSettings } from '../db/schema/operator.js'
import { GLOBAL_KILL_KEY } from '../gate/context.js'

/** Deployment-wide switches stored in the operator schema. */
export class OperatorState {
  constructor(private readonly db: Db) {}

  async globalKill(): Promise<boolean> {
    const [row] = await this.db
      .select({ v: operatorSettings.value })
      .from(operatorSettings)
      .where(eq(operatorSettings.key, GLOBAL_KILL_KEY))
    return row?.v === true
  }

  async setGlobalKill(on: boolean): Promise<void> {
    await this.db
      .insert(operatorSettings)
      .values({ key: GLOBAL_KILL_KEY, value: on })
      .onConflictDoUpdate({ target: operatorSettings.key, set: { value: on, updatedAt: new Date() } })
  }

  async setAccountPaused(accountId: string, paused: boolean): Promise<void> {
    await this.db.update(accounts).set({ paused, updatedAt: new Date() }).where(eq(accounts.id, accountId))
  }

  async setThrottled(accountId: string, until: Date | null, reason: string | null): Promise<void> {
    await this.db
      .update(accounts)
      .set({ throttledUntil: until, throttledReason: reason, updatedAt: new Date() })
      .where(eq(accounts.id, accountId))
  }
}
