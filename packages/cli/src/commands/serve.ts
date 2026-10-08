import type { Command } from 'commander'
import { type GlobalOptions, loadContext } from '../context.js'
import { EXIT_DO_NOT_RESTART, startServer } from '../server.js'

export function registerServe(program: Command) {
  program
    .command('serve')
    .option('--fake', 'use in-memory connectors instead of WhatsApp (development)')
    .description('run the server: connectors, pipeline, policy gate, MCP over HTTP')
    .action(async (o: { fake?: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      let running: Awaited<ReturnType<typeof startServer>> | null = null
      try {
        running = await startServer(ctx, { fake: o.fake ?? false })
      } catch (e) {
        const code = (e as { exitCode?: number }).exitCode
        ctx.log.fatal({ err: (e as Error).message }, 'startup failed')
        await ctx.operator
          .notify({ kind: 'alert', title: 'wamcp failed to start', body: (e as Error).message })
          .catch(() => undefined)
        await ctx.close()
        process.exit(code === EXIT_DO_NOT_RESTART ? EXIT_DO_NOT_RESTART : 1)
      }
      const shutdown = async (signal: string) => {
        ctx.log.info({ signal }, 'shutting down')
        await running?.stop()
        await ctx.close()
        process.exit(0)
      }
      process.on('SIGINT', () => void shutdown('SIGINT'))
      process.on('SIGTERM', () => void shutdown('SIGTERM'))
      ctx.log.info(
        {
          accounts: [...running.runtimes.keys()],
          mcp: `http://${ctx.config.server.http.bind}:${running.port}/mcp`,
        },
        'wamcp serving',
      )
    })
}
