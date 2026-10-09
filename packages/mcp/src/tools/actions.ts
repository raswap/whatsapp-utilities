import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type ActionRow, ApprovalError, type Principal } from '@wamcp/core'
import { z } from 'zod'
import { type Registry, requireAccount, requireChat, requireScope } from '../context.js'
import { errorResult, okResult, ToolError } from '../errors.js'

const AccountId = z.string().min(1).max(32)
const ChatId = z.string().min(3).max(128)

function actionOut(a: ActionRow) {
  return {
    action_id: a.id,
    state: a.state,
    kind: a.kind,
    class: a.class,
    chat_id: a.chatId,
    source: a.source,
    message_id: a.messageId,
    approval_code: a.state === 'awaiting_approval' ? a.approvalCode : null,
    expires_at: a.expiresAt?.toISOString() ?? null,
    gate: a.gate,
    result: a.result,
    created_at: a.createdAt.toISOString(),
    updated_at: a.updatedAt.toISOString(),
  }
}

/** Maps an executor outcome to the tool result or a typed error (PRD FR-C5). */
function actionResult(a: ActionRow) {
  switch (a.state) {
    case 'awaiting_approval':
      throw new ToolError('APPROVAL_PENDING', 'the action is queued for human approval', {
        approval_id: a.id,
        approval_code: a.approvalCode,
        expires_at: a.expiresAt?.toISOString() ?? null,
      })
    case 'blocked': {
      const g = a.gate as { check?: string; reason?: string }
      if (g.check === 'rate_limit')
        throw new ToolError('RATE_LIMITED', g.reason ?? 'rate limited', {
          retry_after_ms:
            (g as { trace?: Array<{ retryAfterMs?: number }> }).trace?.at(-1)?.retryAfterMs ?? null,
        })
      if (g.check === 'capability') throw new ToolError('CAPABILITY_UNSUPPORTED', g.reason ?? 'unsupported')
      throw new ToolError('POLICY_BLOCKED', g.reason ?? 'blocked by policy', { check: g.check ?? null })
    }
    default:
      return okResult(actionOut(a))
  }
}

export function registerActionTools(server: McpServer, reg: Registry, p: Principal) {
  server.registerTool(
    'whatsapp_send_message',
    {
      title: 'Send a text message',
      description:
        'Sends text to a chat through the policy gate. Depending on the account setting the result is sent, or APPROVAL_PENDING with a code a human must approve. Pass the same idempotency_key to retry safely. POLICY_BLOCKED explains which check failed.',
      inputSchema: {
        account_id: AccountId,
        chat_id: ChatId,
        text: z.string().min(1).max(4096),
        quoted_message_id: z.string().max(128).optional(),
        idempotency_key: z.string().min(8).max(128).optional(),
        typing_delay: z.enum(['none', 'natural']).default('natural'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, chat_id, text, quoted_message_id, idempotency_key, typing_delay }) => {
      try {
        requireScope(p, 'send')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const row = await rt.executor.submit({
          kind: 'send_message',
          source: p.id,
          actor: p.id,
          idempotencyKey:
            idempotency_key ?? `${p.id}:${chat_id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          chatId: chat_id,
          payload: { ...(quoted_message_id ? { quotedProviderId: quoted_message_id } : {}), typing_delay },
          text,
          approval: rt.config.tool_send_approval,
        })
        return actionResult(row)
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_react_to_message',
    {
      title: 'React to a message',
      description:
        'Adds (or removes, with emoji null) an emoji reaction on a message. Goes through the policy gate like a send.',
      inputSchema: {
        account_id: AccountId,
        chat_id: ChatId,
        message_id: z.string().min(1).max(128),
        emoji: z.string().max(8).nullable(),
        idempotency_key: z.string().min(8).max(128).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, chat_id, message_id, emoji, idempotency_key }) => {
      try {
        requireScope(p, 'send')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const row = await rt.executor.submit({
          kind: 'react_to_message',
          source: p.id,
          actor: p.id,
          idempotencyKey: idempotency_key ?? `${p.id}:react:${chat_id}:${message_id}:${emoji ?? ''}`,
          chatId: chat_id,
          payload: { providerId: message_id, emoji },
          approval: rt.config.tool_send_approval,
        })
        return actionResult(row)
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_mark_read',
    {
      title: 'Mark messages read',
      description: 'Sends read receipts for the given message ids in a chat.',
      inputSchema: {
        account_id: AccountId,
        chat_id: ChatId,
        message_ids: z.array(z.string().min(1).max(128)).min(1).max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account_id, chat_id, message_ids }) => {
      try {
        requireScope(p, 'send')
        requireChat(p, chat_id)
        const rt = requireAccount(reg, p, account_id)
        const row = await rt.executor.submit({
          kind: 'mark_read',
          source: p.id,
          actor: p.id,
          idempotencyKey: `${p.id}:read:${chat_id}:${message_ids.join(',')}`,
          chatId: chat_id,
          payload: { providerIds: message_ids },
          approval: 'auto',
        })
        return actionResult(row)
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_list_actions',
    {
      title: 'List actions',
      description:
        'Lists actions (sends, reactions, escalations) by state. Useful states: awaiting_approval, unknown, failed, sent.',
      inputSchema: {
        account_id: AccountId,
        state: z
          .enum([
            'planned',
            'blocked',
            'dry_run',
            'awaiting_approval',
            'approved',
            'executing',
            'retry_wait',
            'sent',
            'failed',
            'unknown',
            'rejected',
            'expired',
            'cancelled',
          ])
          .optional(),
        chat_id: ChatId.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, state, chat_id, limit }) => {
      try {
        requireScope(p, 'read:audit')
        const rt = requireAccount(reg, p, account_id)
        const rows = await rt.executor.actions.list({
          ...(state ? { state } : {}),
          ...(chat_id ? { chatId: chat_id } : {}),
          limit,
        })
        return okResult({ account_id, actions: rows.map(actionOut) })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_list_pending_approvals',
    {
      title: 'List pending approvals',
      description: 'Actions waiting for a human. Each has an approval_code for whatsapp_approve_action.',
      inputSchema: { account_id: AccountId },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id }) => {
      try {
        requireScope(p, 'read:audit')
        const rt = requireAccount(reg, p, account_id)
        const rows = await rt.executor.actions.list({ state: 'awaiting_approval' })
        return okResult({
          account_id,
          approvals: rows.map((a) => ({
            ...actionOut(a),
            text: (a.payload as { text?: string }).text ?? null,
          })),
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  for (const verb of ['approve', 'reject'] as const) {
    server.registerTool(
      `whatsapp_${verb}_action`,
      {
        title: verb === 'approve' ? 'Approve a pending action' : 'Reject a pending action',
        description: `${verb === 'approve' ? 'Approves' : 'Rejects'} an action by its approval_code. Requires the approver scope, and an action can never be approved by the token that created it.`,
        inputSchema: {
          account_id: AccountId,
          approval_code: z.string().length(6),
          reason: z.string().max(500).optional(),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: verb === 'approve',
        },
      },
      async ({ account_id, approval_code, reason }) => {
        try {
          requireScope(p, 'approver')
          const rt = requireAccount(reg, p, account_id)
          const row =
            verb === 'approve'
              ? await rt.executor.approve(approval_code, p.id)
              : await rt.executor.reject(approval_code, p.id, reason ?? '')
          return okResult(actionOut(row))
        } catch (e) {
          if (e instanceof ApprovalError) {
            return errorResult(
              new ToolError(e.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN', e.message, {
                approval_error: e.code,
              }),
            )
          }
          return errorResult(e)
        }
      },
    )
  }

  server.registerTool(
    'whatsapp_get_audit_log',
    {
      title: 'Get audit log',
      description:
        'Gate decisions, approvals, and action outcomes. Filter by event_id, chat_id, or kind to answer "why did or did not X happen".',
      inputSchema: {
        account_id: AccountId,
        event_id: z.string().max(64).optional(),
        chat_id: ChatId.optional(),
        kind: z.enum(['gate', 'action', 'approval', 'chat', 'account']).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id, event_id, chat_id, kind, limit }) => {
      try {
        requireScope(p, 'read:audit')
        const rt = requireAccount(reg, p, account_id)
        const rows = await rt.audit.query({
          ...(event_id ? { eventId: event_id } : {}),
          ...(chat_id ? { chatId: chat_id } : {}),
          ...(kind ? { kind } : {}),
          limit,
        })
        return okResult({
          account_id,
          entries: rows.map((r) => ({
            seq: r.seq,
            id: r.id,
            at: r.createdAt.toISOString(),
            actor: r.actor,
            kind: r.kind,
            subject_id: r.subjectId,
            event_id: r.eventId,
            chat_id: r.chatId,
            decision: r.decision,
            detail: r.detail,
          })),
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )
}
