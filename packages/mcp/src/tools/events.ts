import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EVENT_TYPES, type EventType, type Principal, type Subscription } from '@wamcp/core'
import { z } from 'zod'
import { type Registry, requireAccount, requireScope } from '../context.js'
import { errorResult, okResult, ToolError } from '../errors.js'

/**
 * Live event delivery (PRD FR-M9). Each MCP session owns its subscriptions; events arrive as
 * `notifications/message` with logger `wamcp.events`. On session close, everything is unsubscribed.
 */
export class SessionSubscriptions {
  private subs = new Map<string, Subscription>()
  add(id: string, s: Subscription) {
    this.subs.set(id, s)
  }
  remove(id: string): boolean {
    const s = this.subs.get(id)
    if (!s) return false
    s.unsubscribe()
    this.subs.delete(id)
    return true
  }
  closeAll() {
    for (const s of this.subs.values()) s.unsubscribe()
    this.subs.clear()
  }
  get size() {
    return this.subs.size
  }
}

export function registerEventTools(
  server: McpServer,
  reg: Registry,
  p: Principal,
  session: SessionSubscriptions,
) {
  server.registerTool(
    'whatsapp_subscribe_events',
    {
      title: 'Subscribe to live events',
      description:
        'Streams events for an account to this session as notifications/message (logger "wamcp.events"). Filter by chats or types. If you fall behind, a subscription.lagged event carries a resume cursor for whatsapp_get_events.',
      inputSchema: {
        account_id: z.string().min(1).max(32),
        chat_ids: z.array(z.string().min(3).max(128)).max(50).optional(),
        types: z.array(z.enum(EVENT_TYPES)).max(20).optional(),
        include_from_me: z.boolean().default(true),
        include_backfill: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ account_id, chat_ids, types, include_from_me, include_backfill }) => {
      try {
        requireScope(p, 'read:messages')
        const rt = requireAccount(reg, p, account_id)
        const chatScope = chat_ids ?? (p.chatAllowlist ? [...p.chatAllowlist] : undefined)
        const sub = rt.pipeline.subscriptions.subscribe(
          {
            ...(chatScope ? { chatIds: chatScope } : {}),
            ...(types ? { types: types as EventType[] } : {}),
            includeFromMe: include_from_me,
            includeBackfill: include_backfill,
          },
          async (e) => {
            await server.sendLoggingMessage({
              level: 'info',
              logger: 'wamcp.events',
              data: {
                account_id,
                cursor: e.cursor,
                id: e.id,
                type: e.type,
                chat_id: e.chatId,
                sender_id: e.senderId,
                message_id: e.providerId,
                seq: e.seq,
                at: e.occurredAt.toISOString(),
                from_me: e.isFromMe,
                origin: e.origin,
                backfill: e.isBackfill,
                payload: e.payload,
              },
            })
          },
        )
        session.add(sub.id, sub)
        return okResult({ subscription_id: sub.id, account_id })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_unsubscribe_events',
    {
      title: 'Unsubscribe from live events',
      description: 'Stops a subscription created by whatsapp_subscribe_events.',
      inputSchema: { subscription_id: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ subscription_id }) => {
      try {
        if (!session.remove(subscription_id))
          throw new ToolError('NOT_FOUND', `no subscription ${subscription_id} in this session`)
        return okResult({ subscription_id, removed: true })
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}
