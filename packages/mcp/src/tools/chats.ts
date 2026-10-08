import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EVENT_TYPES, type EventType, type Principal } from '@wamcp/core'
import { z } from 'zod'
import { type Registry, requireAccount, requireChat, requireScope } from '../context.js'
import { errorResult, okResult, ToolError } from '../errors.js'

const AccountId = z.string().min(1).max(32).describe('Account id from whatsapp_list_accounts')
const ChatId = z
  .string()
  .min(3)
  .max(128)
  .describe('Chat JID, e.g. 919999000001@s.whatsapp.net or 1203630@g.us')

function chatOut(c: {
  id: string
  type: string
  name: string | null
  automationState: string
  pausedUntil: Date | null
  unreadCount: number
  lastMessageAt: Date | null
  archived: boolean
  pinned: boolean
}) {
  return {
    chat_id: c.id,
    type: c.type,
    name: c.name,
    automation: c.automationState,
    paused_until: c.pausedUntil?.toISOString() ?? null,
    unread: c.unreadCount,
    last_message_at: c.lastMessageAt?.toISOString() ?? null,
    archived: c.archived,
    pinned: c.pinned,
  }
}

function msgOut(m: {
  id: string
  providerId: string
  chatId: string
  senderId: string | null
  type: string
  body: string | null
  quotedProviderId: string | null
  isFromMe: boolean
  origin: string | null
  occurredAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}) {
  return {
    id: m.id,
    message_id: m.providerId,
    chat_id: m.chatId,
    sender_id: m.senderId,
    type: m.type,
    body: m.body,
    quoted_message_id: m.quotedProviderId,
    from_me: m.isFromMe,
    origin: m.origin,
    at: m.occurredAt.toISOString(),
    edited_at: m.editedAt?.toISOString() ?? null,
    deleted: m.deletedAt !== null,
  }
}

export function registerChatTools(server: McpServer, reg: Registry, p: Principal) {
  server.registerTool(
    'whatsapp_list_chats',
    {
      title: 'List chats',
      description:
        'Lists chats on an account, most recently active first. Filter by type (dm, group) or unread. Returns chat_id values for the message tools.',
      inputSchema: {
        account_id: AccountId,
        type: z.enum(['dm', 'group', 'community', 'broadcast', 'channel', 'status']).optional(),
        unread_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, type, unread_only, limit }) => {
      try {
        requireScope(p, 'read:messages')
        const rt = requireAccount(reg, p, account_id)
        const rows = await rt.pipeline.chats.list({
          ...(type ? { type } : {}),
          unreadOnly: unread_only,
          limit,
        })
        const chats = rows
          .filter((c) => p.chatAllowlist === null || p.chatAllowlist.includes(c.id))
          .map(chatOut)
        return okResult({ account_id, chats })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_get_chat',
    {
      title: 'Get chat',
      description: 'Returns one chat with its automation state and labels.',
      inputSchema: { account_id: AccountId, chat_id: ChatId },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, chat_id }) => {
      try {
        requireScope(p, 'read:messages')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const c = await rt.pipeline.chats.get(chat_id)
        if (!c) throw new ToolError('NOT_FOUND', `no chat ${chat_id}`)
        return okResult({ account_id, ...chatOut(c) })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_get_messages',
    {
      title: 'Get messages',
      description:
        'Returns messages in a chat, newest first, with a cursor for older pages. Use before=next_cursor to page back. Max 200 per call.',
      inputSchema: {
        account_id: AccountId,
        chat_id: ChatId,
        limit: z.number().int().min(1).max(200).default(50),
        before: z.string().max(200).optional().describe('next_cursor from a previous call'),
        include_deleted: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, chat_id, limit, before, include_deleted }) => {
      try {
        requireScope(p, 'read:messages')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const page = await rt.pipeline.messages.getMessages({
          chatId: chat_id,
          limit,
          ...(before ? { before } : {}),
          includeDeleted: include_deleted,
        })
        return okResult({
          account_id,
          chat_id,
          messages: page.items.map(msgOut),
          next_cursor: page.nextCursor,
          truncated: page.truncated,
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_get_thread',
    {
      title: 'Get reply thread',
      description:
        'Walks the quote chain from a message back to its root and returns the thread oldest first.',
      inputSchema: {
        account_id: AccountId,
        chat_id: ChatId,
        message_id: z.string().min(1).max(128),
        depth: z.number().int().min(1).max(20).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, chat_id, message_id, depth }) => {
      try {
        requireScope(p, 'read:messages')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const thread = await rt.pipeline.messages.getThread(chat_id, message_id, depth)
        if (thread.length === 0) throw new ToolError('NOT_FOUND', `no message ${message_id} in ${chat_id}`)
        return okResult({ account_id, chat_id, thread: thread.map(msgOut) })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_search_messages',
    {
      title: 'Search messages',
      description:
        'Full-text search over message bodies on one account, optionally limited to chats. Returns newest matches first.',
      inputSchema: {
        account_id: AccountId,
        query: z.string().min(1).max(200),
        chat_ids: z.array(ChatId).max(50).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, query, chat_ids, limit }) => {
      try {
        requireScope(p, 'read:messages')
        const rt = requireAccount(reg, p, account_id)
        const scope = chat_ids ?? (p.chatAllowlist ? [...p.chatAllowlist] : undefined)
        const rows = await rt.pipeline.messages.search({ query, ...(scope ? { chatIds: scope } : {}), limit })
        return okResult({
          account_id,
          query,
          messages: rows
            .filter((m) => p.chatAllowlist === null || p.chatAllowlist.includes(m.chatId))
            .map(msgOut),
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_get_events',
    {
      title: 'Get events since cursor',
      description:
        'Reads the event log after a cursor, in order. Use the last cursor you saw (0 for the beginning) to catch up on what happened since you last looked.',
      inputSchema: {
        account_id: AccountId,
        after_cursor: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        types: z.array(z.enum(EVENT_TYPES)).max(20).optional(),
        chat_ids: z.array(ChatId).max(50).optional(),
        include_from_me: z.boolean().default(true),
        include_backfill: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, after_cursor, limit, types, chat_ids, include_from_me, include_backfill }) => {
      try {
        requireScope(p, 'read:messages')
        const rt = requireAccount(reg, p, account_id)
        const scope = chat_ids ?? (p.chatAllowlist ? [...p.chatAllowlist] : undefined)
        const events = await rt.pipeline.events.listAfter(after_cursor, limit, {
          ...(types ? { types: types as EventType[] } : {}),
          ...(scope ? { chatIds: scope } : {}),
          includeFromMe: include_from_me,
          includeBackfill: include_backfill,
        })
        const last = events.at(-1)
        return okResult({
          account_id,
          events: events.map((e) => ({
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
          })),
          next_cursor: last ? last.cursor : after_cursor,
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_set_chat_automation',
    {
      title: 'Pause or resume automation on a chat',
      description:
        'paused stops gated actions on one chat (send scope). active resumes a paused or escalated chat (admin scope).',
      inputSchema: {
        account_id: AccountId,
        chat_id: ChatId,
        state: z.enum(['active', 'paused']),
        paused_minutes: z.number().int().min(1).max(10080).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ account_id, chat_id, state, paused_minutes }) => {
      try {
        requireScope(p, state === 'active' ? 'admin' : 'send')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const until =
          state === 'paused' && paused_minutes ? new Date(Date.now() + paused_minutes * 60_000) : null
        await rt.pipeline.chats.setAutomation(chat_id, state, until)
        await rt.audit.append({
          actor: p.id,
          kind: 'chat',
          subjectId: chat_id,
          chatId: chat_id,
          decision: state,
          detail: { paused_until: until?.toISOString() ?? null },
        })
        return okResult({
          account_id,
          chat_id,
          automation: state,
          paused_until: until?.toISOString() ?? null,
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}
