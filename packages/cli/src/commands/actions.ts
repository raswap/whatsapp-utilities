import type { Command } from 'commander'
import { cliActor, type GlobalOptions, loadContext, out, table } from '../context.js'
import { buildRuntimes } from '../runtimes.js'

export function registerActions(program: Command) {
  const actions = program.command('actions').description('action lifecycle')
  actions
    .command('ls')
    .option('--account <id>')
    .option('--state <state>', 'filter by state, e.g. unknown, failed, sent', 'unknown')
    .option('--limit <n>', 'max rows', '50')
    .description('list actions by state')
    .action(async (o: { account?: string; state: string; limit: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const rts = await buildRuntimes(ctx, { fake: true, only: o.account })
        const rows: Array<Record<string, unknown>> = []
        for (const rt of rts.values()) {
          for (const a of await rt.executor.actions.list({
            state: o.state as never,
            limit: Number(o.limit),
          })) {
            rows.push({
              account: rt.config.id,
              id: a.id,
              state: a.state,
              kind: a.kind,
              chat: a.chatId,
              message_id: a.messageId,
              updated: a.updatedAt.toISOString().slice(0, 19),
              result: JSON.stringify(a.result ?? {}).slice(0, 60),
            })
          }
        }
        out(opts, rows, () =>
          table(rows, ['account', 'id', 'state', 'kind', 'chat', 'message_id', 'updated', 'result']),
        )
      } finally {
        await ctx.close()
      }
    })
  actions
    .command('resolve <id>')
    .requiredOption('--outcome <sent|failed>', 'what actually happened on the phone')
    .option('--account <id>')
    .description('resolve an action in state unknown after checking the phone')
    .action(async (id: string, o: { outcome: string; account?: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        if (o.outcome !== 'sent' && o.outcome !== 'failed')
          throw new Error('--outcome must be sent or failed')
        const rts = await buildRuntimes(ctx, { fake: true, only: o.account })
        for (const rt of rts.values()) {
          const row = await rt.executor.actions.get(id)
          if (!row) continue
          const r = await rt.executor.actions.transition(id, ['unknown'], o.outcome, {
            result: { ...(row.result as object), resolvedBy: cliActor() },
          })
          if (!r) throw new Error(`action ${id} is in state ${row.state}, not unknown`)
          await rt.audit.append({
            actor: cliActor(),
            kind: 'action',
            subjectId: id,
            chatId: row.chatId,
            decision: o.outcome,
            detail: { resolvedBy: 'operator' },
          })
          out(opts, r, () => `resolved ${id} as ${o.outcome}`)
          return
        }
        throw new Error(`no action ${id}`)
      } finally {
        await ctx.close()
      }
    })
  actions
    .command('retry <id>')
    .option('--account <id>')
    .description('re-run a failed or retry_wait action now (goes through the gate again)')
    .action(async (id: string, o: { account?: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const rts = await buildRuntimes(ctx, { fake: false, only: o.account })
        for (const rt of rts.values()) {
          const row = await rt.executor.actions.get(id)
          if (!row) continue
          if (row.state !== 'failed' && row.state !== 'retry_wait')
            throw new Error(`action ${id} is ${row.state}; only failed or retry_wait can be retried`)
          await rt.start()
          try {
            const approved = await rt.executor.actions.transition(id, ['failed', 'retry_wait'], 'approved', {
              result: { ...(row.result as object), retriedBy: cliActor() },
            })
            const result = approved ? await rt.executor.execute(approved) : row
            out(opts, result, () => `${result.state}: ${result.kind} ${result.chatId ?? ''}`)
          } finally {
            await rt.stop()
          }
          return
        }
        throw new Error(`no action ${id}`)
      } finally {
        await ctx.close()
      }
    })
}
