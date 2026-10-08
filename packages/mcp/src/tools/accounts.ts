import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Principal } from '@wamcp/core'
import { z } from 'zod'
import { type Registry, requireAccount, requireScope } from '../context.js'
import { errorResult, okResult } from '../errors.js'

export function registerAccountTools(server: McpServer, reg: Registry, p: Principal) {
  server.registerTool(
    'whatsapp_list_accounts',
    {
      title: 'List WhatsApp accounts',
      description:
        'Lists the accounts this token may access with their connection state. Start here to find an account_id for other tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const accounts = [...reg.accounts.values()]
          .filter((rt) => p.accountIds.includes('*') || p.accountIds.includes(rt.config.id))
          .map((rt) => ({
            account_id: rt.config.id,
            type: rt.config.type,
            display_name: rt.config.display_name,
            timezone: rt.config.timezone,
            state: rt.connector.health().state,
          }))
        return okResult({ accounts })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  server.registerTool(
    'whatsapp_get_account_status',
    {
      title: 'Get account status',
      description:
        'Connection state, last event time, pending approvals, unknown actions, and pipeline metrics for one account.',
      inputSchema: { account_id: z.string().min(1).max(32) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account_id }) => {
      try {
        const rt = requireAccount(reg, p, account_id)
        const health = rt.connector.health()
        const pending = await rt.executor.actions.list({ state: 'awaiting_approval' })
        const unknown = await rt.executor.actions.list({ state: 'unknown' })
        return okResult({
          account_id,
          connection: health.state,
          library_version: health.libraryVersion,
          last_event_at: health.lastEventAt?.toISOString() ?? null,
          last_inbound_at: health.lastInboundAt?.toISOString() ?? null,
          decrypt_failures: health.decryptFailures,
          pending_approvals: pending.length,
          unknown_actions: unknown.length,
          dispatch_cursor: rt.pipeline.dispatchCursor,
          metrics: {
            ingested: rt.pipeline.metrics.ingested,
            duplicates: rt.pipeline.metrics.duplicates,
            dispatched: rt.pipeline.metrics.dispatched,
            handler_errors: rt.pipeline.metrics.handlerErrors,
          },
          global_kill: await reg.globalKill(),
        })
      } catch (e) {
        return errorResult(e)
      }
    },
  )

  for (const [name, state] of [
    ['whatsapp_pause_account', 'paused'],
    ['whatsapp_resume_account', 'active'],
  ] as const) {
    server.registerTool(
      name,
      {
        title: state === 'paused' ? 'Pause account automation' : 'Resume account automation',
        description:
          state === 'paused'
            ? 'Stops all gated actions on the account while monitoring continues (kill switch). Requires admin scope.'
            : 'Resumes gated actions on a paused account. Requires admin scope.',
        inputSchema: { account_id: z.string().min(1).max(32) },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ account_id }) => {
        try {
          requireScope(p, 'admin')
          const rt = requireAccount(reg, p, account_id)
          await rt.setPaused(state === 'paused', p.id)
          return okResult({ account_id, paused: state === 'paused' })
        } catch (e) {
          return errorResult(e)
        }
      },
    )
  }
}
