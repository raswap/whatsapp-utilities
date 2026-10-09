import { ActionStore, accounts as accountsTable, EventStore, systemClock, tablesFor } from '@wamcp/core'
import type { Command } from 'commander'
import { type GlobalOptions, loadContext, out, table } from '../context.js'

export function registerStatus(program: Command) {
  program
    .command('status')
    .description(
      'at-a-glance state per account: connection (from the running server), approvals, unknown actions, last event',
    )
    .action(async () => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        let live: Record<string, unknown> | null = null
        try {
          const res = await fetch(
            `http://${ctx.config.server.http.bind}:${ctx.config.server.http.port}/readyz`,
            { signal: AbortSignal.timeout(1500) },
          )
          live = ((await res.json()) as { detail: Record<string, unknown> }).detail
        } catch {
          live = null
        }
        const dbRows = await ctx.handle.db.select().from(accountsTable)
        const rows: Array<Record<string, unknown>> = []
        for (const a of ctx.config.accounts) {
          const t = tablesFor(`acct_${a.id}`)
          const actions = new ActionStore(ctx.handle.db, t, systemClock)
          const events = new EventStore(ctx.handle.db, t, {
            accountId: a.id,
            backfillAgeThresholdMs: 0,
            clock: systemClock,
          })
          const db = dbRows.find((r) => r.id === a.id)
          rows.push({
            account: a.id,
            connection: live ? String(live[a.id] ?? 'not running') : 'server not reachable',
            paused: db?.paused ? 'yes' : '',
            throttled: db?.throttledUntil && db.throttledUntil > new Date() ? 'yes' : '',
            pending_approvals: (await actions.list({ state: 'awaiting_approval' })).length,
            unknown_actions: (await actions.list({ state: 'unknown' })).length,
            last_cursor: await events.latestCursor(),
          })
        }
        const kill = await ctx.operatorState.globalKill()
        out(
          opts,
          { global_kill: kill, accounts: rows },
          () =>
            `global kill: ${kill ? 'ON' : 'off'}\n${table(rows, ['account', 'connection', 'paused', 'throttled', 'pending_approvals', 'unknown_actions', 'last_cursor'])}`,
        )
      } finally {
        await ctx.close()
      }
    })
}
