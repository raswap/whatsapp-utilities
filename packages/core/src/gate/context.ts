import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Clock } from '../clock.js'
import type { AccountConfig } from '../config/schema.js'
import type { Connector } from '../connectors/types.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import { accounts, operatorSettings } from '../db/schema/operator.js'
import type { ActionStore } from '../executor/actions.js'
import type { IdentityStore } from '../store/identities.js'
import type { ChatStore, MessageStore } from '../store/messages.js'
import { type GateContext, IDENTICAL_SEND_WINDOW_MS } from './policy.js'
import type { PlannedAction } from './types.js'

export interface ContextDeps {
  db: Db
  tables: AccountTables
  account: AccountConfig
  connector: Connector
  chats: ChatStore
  messages: MessageStore
  identities: IdentityStore
  actions: ActionStore
  clock: Clock
}

export const GLOBAL_KILL_KEY = 'global_kill'

/** Assembles the snapshot the gate reads (PRD §7.6). One query per concern; no business logic here. */
export function gateContextBuilder(d: ContextDeps): (action: PlannedAction) => Promise<GateContext> {
  return async (action) => {
    const now = d.clock.now()
    const [kill] = await d.db
      .select({ v: operatorSettings.value })
      .from(operatorSettings)
      .where(eq(operatorSettings.key, GLOBAL_KILL_KEY))
    const [acct] = await d.db.select().from(accounts).where(eq(accounts.id, d.account.id))
    const chat = action.chatId ? await d.chats.get(action.chatId) : null
    let recipient: GateContext['recipient'] = null
    if (action.recipientContactId) {
      recipient = (await d.identities.contactsByIds([action.recipientContactId]))[0] ?? null
    } else if (chat?.type === 'dm' && action.chatId) {
      const [ident] = await d.db
        .select({ contactId: d.tables.identities.contactId })
        .from(d.tables.identities)
        .where(eq(d.tables.identities.jid, action.chatId))
      recipient = ident ? ((await d.identities.contactsByIds([ident.contactId]))[0] ?? null) : null
    }
    const recentMessages = action.chatId
      ? await d.messages.recent(action.chatId, d.account.limits.max_consecutive_automated)
      : []
    const lastIdenticalSendAt =
      action.chatId && action.text
        ? await d.actions.lastIdenticalSendAt(
            action.chatId,
            createHash('sha256').update(action.text).digest('hex'),
            new Date(now.getTime() - IDENTICAL_SEND_WINDOW_MS),
          )
        : null
    return {
      accountId: d.account.id,
      timezone: d.account.timezone,
      businessHours: d.account.business_hours,
      limits: d.account.limits,
      capabilities: d.connector.capabilities,
      globalKill: kill?.v === true,
      accountPaused: acct?.paused ?? false,
      throttled:
        acct?.throttledUntil && acct.throttledReason
          ? { until: acct.throttledUntil, reason: acct.throttledReason }
          : null,
      chat,
      recipient,
      recentMessages,
      lastIdenticalSendAt,
      now,
    }
  }
}
