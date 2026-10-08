import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Principal } from '@wamcp/core'
import { type Registry, requireAccount, requireScope } from './context.js'
import { registerAccountTools } from './tools/accounts.js'
import { registerActionTools } from './tools/actions.js'
import { registerChatTools } from './tools/chats.js'
import { registerEventTools, SessionSubscriptions } from './tools/events.js'

export const SERVER_NAME = 'whatsapp-mcp-server'
export const SERVER_VERSION = '0.1.0'

export interface BuiltServer {
  server: McpServer
  session: SessionSubscriptions
  close(): Promise<void>
}

/** One McpServer per connected session, bound to the principal that authenticated it. */
export function buildServer(reg: Registry, principal: Principal): BuiltServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } },
  )
  const session = new SessionSubscriptions()
  registerAccountTools(server, reg, principal)
  registerChatTools(server, reg, principal)
  registerActionTools(server, reg, principal)
  registerEventTools(server, reg, principal, session)

  server.registerResource(
    'chats',
    new ResourceTemplate('whatsapp://{account}/chats', {
      list: async () => ({
        resources: [...reg.accounts.keys()]
          .filter((id) => principal.accountIds.includes('*') || principal.accountIds.includes(id))
          .map((id) => ({
            uri: `whatsapp://${id}/chats`,
            name: `${id} chats`,
            mimeType: 'application/json',
          })),
      }),
    }),
    { title: 'Chats', description: 'Chat list for an account', mimeType: 'application/json' },
    async (uri, { account }) => {
      requireScope(principal, 'read:messages')
      const rt = requireAccount(reg, principal, String(account))
      const chats = await rt.pipeline.chats.list({ limit: 200 })
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              chats.map((c) => ({
                chat_id: c.id,
                type: c.type,
                name: c.name,
                automation: c.automationState,
                last_message_at: c.lastMessageAt,
              })),
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  server.registerResource(
    'pending-approvals',
    new ResourceTemplate('whatsapp://{account}/pending-approvals', { list: undefined }),
    { title: 'Pending approvals', description: 'Actions waiting for a human', mimeType: 'application/json' },
    async (uri, { account }) => {
      requireScope(principal, 'read:audit')
      const rt = requireAccount(reg, principal, String(account))
      const rows = await rt.executor.actions.list({ state: 'awaiting_approval' })
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              rows.map((a) => ({
                action_id: a.id,
                code: a.approvalCode,
                kind: a.kind,
                chat_id: a.chatId,
                text: (a.payload as { text?: string }).text ?? null,
                expires_at: a.expiresAt,
              })),
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  return {
    server,
    session,
    async close() {
      session.closeAll()
      await server.close()
    },
  }
}
