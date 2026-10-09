import type { Command } from 'commander'
import { type GlobalOptions, loadContext, out } from '../context.js'

export function registerAlerts(program: Command) {
  const alerts = program.command('alerts').description('operator alert channels')
  alerts
    .command('test')
    .description('send a test message on every configured operator channel')
    .action(async () => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const results = await ctx.operator.test()
        out(
          opts,
          results,
          () =>
            results
              .map(
                (r) =>
                  `${r.ok ? 'OK  ' : 'FAIL'} ${r.channel} ${r.latencyMs} ms${r.error ? ` (${r.error})` : ''}`,
              )
              .join('\n') || 'no operator channels configured',
        )
        if (results.some((r) => !r.ok) || results.length === 0) process.exitCode = 1
      } finally {
        await ctx.close()
      }
    })
}
