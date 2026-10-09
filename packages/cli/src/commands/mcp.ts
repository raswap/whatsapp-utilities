import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { runProxy } from '@wamcp/mcp'
import type { Command } from 'commander'
import { type GlobalOptions, loadContext } from '../context.js'

export const LOCAL_TOKEN_FILE = 'local-stdio.token'

export function registerMcp(program: Command) {
  program
    .command('mcp')
    .option('--stdio', 'speak MCP over stdio (what Claude Desktop and Claude Code use)', true)
    .option('--url <url>', 'MCP HTTP endpoint of the running server (default from config)')
    .option(
      '--token <token>',
      'bearer token (default: $WAMCP_TOKEN or the local token file written by wamcp serve)',
    )
    .description('stdio proxy to the running wamcp server; configure this command in your MCP client')
    .action(async (o: { url?: string; token?: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      await ctx.close()
      const url = o.url ?? `http://${ctx.config.server.http.bind}:${ctx.config.server.http.port}/mcp`
      const tokenFile = resolve(
        ctx.configPath,
        '..',
        ctx.config.server.data_dir,
        '_operator',
        LOCAL_TOKEN_FILE,
      )
      const token = o.token ?? process.env.WAMCP_TOKEN ?? readFileSync(tokenFile, 'utf8').trim()
      const proxy = await runProxy({ url, token, serverTransport: new StdioServerTransport() })
      const stop = () => void proxy.close().finally(() => process.exit(0))
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    })
}
