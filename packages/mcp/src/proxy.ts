import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotificationSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { SERVER_NAME, SERVER_VERSION } from './server.js'

export interface ProxyOptions {
  url: string
  token: string
  /** Server-side transport the proxy speaks to the local client over (stdio in production, in-memory in tests). */
  serverTransport: Transport
}

/**
 * `wamcp mcp --stdio`: a thin bridge so desktop clients never own the WhatsApp session (PRD FR-C8).
 * Forwards tools and resources to the running HTTP server and relays its notifications back.
 */
export async function runProxy(opts: ProxyOptions): Promise<{ close(): Promise<void> }> {
  const client = new Client({ name: `${SERVER_NAME}-proxy`, version: SERVER_VERSION }, { capabilities: {} })
  const upstream = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: { headers: { authorization: `Bearer ${opts.token}` } },
  })
  // The SDK's transport types predate exactOptionalPropertyTypes; the runtime shape is correct.
  await client.connect(upstream as unknown as Transport)

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, logging: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async (req) => client.listTools(req.params))
  server.setRequestHandler(CallToolRequestSchema, async (req) => client.callTool(req.params))
  server.setRequestHandler(ListResourcesRequestSchema, async (req) => client.listResources(req.params))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
    client.listResourceTemplates(req.params),
  )
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => client.readResource(req.params))
  client.setNotificationHandler(LoggingMessageNotificationSchema, async (n) => {
    await server.notification({ method: 'notifications/message', params: n.params })
  })
  await server.connect(opts.serverTransport)
  return {
    async close() {
      await server.close()
      await client.close()
    },
  }
}
