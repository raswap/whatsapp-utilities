import { ApprovalError } from '@wamcp/core'
import type { Command } from 'commander'
import { cliActor, type GlobalOptions, loadContext, out, table } from '../context.js'
import { buildRuntimes } from '../runtimes.js'

export function registerApprovals(program: Command) {
  const approvals = program.command('approvals').description('pending human approvals')
  approvals
    .command('ls')
    .option('--account <id>', 'only this account')
    .description('list pending approvals with their codes')
    .action(async (o: { account?: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const rts = await buildRuntimes(ctx, { fake: true, only: o.account })
        const rows: Array<Record<string, unknown>> = []
        for (const rt of rts.values()) {
          for (const a of await rt.executor.actions.list({ state: 'awaiting_approval' })) {
            rows.push({
              account: rt.config.id,
              code: a.approvalCode,
              kind: a.kind,
              chat: a.chatId,
              text: String((a.payload as { text?: string }).text ?? '').slice(0, 60),
              expires: a.expiresAt?.toISOString().slice(0, 16),
            })
          }
        }
        out(opts, rows, () => table(rows, ['account', 'code', 'kind', 'chat', 'text', 'expires']))
      } finally {
        await ctx.close()
      }
    })
  for (const verb of ['approve', 'reject'] as const) {
    approvals
      .command(`${verb} <code>`)
      .option('--account <id>', 'account the code belongs to (auto-detected when unique)')
      .option('--reason <text>', 'reason (reject only)')
      .description(`${verb} a pending action by code`)
      .action(async (code: string, o: { account?: string; reason?: string }) => {
        const opts = program.opts<GlobalOptions>()
        const ctx = await loadContext(opts)
        try {
          const rts = await buildRuntimes(ctx, { fake: false, only: o.account })
          let done = false
          for (const rt of rts.values()) {
            const row = await rt.executor.actions.byApprovalCode(code)
            if (!row) continue
            try {
              if (verb === 'approve') await rt.start()
              const result =
                verb === 'approve'
                  ? await rt.executor.approve(code, cliActor())
                  : await rt.executor.reject(code, cliActor(), o.reason ?? '')
              out(opts, result, () => `${result.state}: ${result.kind} ${result.chatId ?? ''} (${result.id})`)
              done = true
            } catch (e) {
              if (e instanceof ApprovalError) {
                process.stderr.write(`${e.code}: ${e.message}\n`)
                process.exitCode = 1
                done = true
              } else throw e
            } finally {
              if (verb === 'approve') await rt.stop()
            }
            break
          }
          if (!done) {
            process.stderr.write(`no pending approval with code ${code}\n`)
            process.exitCode = 1
          }
        } finally {
          await ctx.close()
        }
      })
  }
}
