import { EventStore, tablesFor } from '@wamcp/core'
import type { Command } from 'commander'
import { type GlobalOptions, loadContext } from '../context.js'

export function registerTail(program: Command) {
  program
    .command('tail')
    .option('--account <id>', 'only this account')
    .option('--chat <id>', 'only this chat')
    .option('--type <type>', 'only this event type')
    .option('--from <cursor>', 'start after this cursor (default: latest)', '')
    .option('--no-follow', 'print what exists and exit')
    .description('stream events from the store as they are persisted')
    .action(async (o: { account?: string; chat?: string; type?: string; from: string; follow: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      const stores = ctx.config.accounts
        .filter((a) => !o.account || a.id === o.account)
        .map((a) => ({
          id: a.id,
          store: new EventStore(ctx.handle.db, tablesFor(`acct_${a.id}`), {
            accountId: a.id,
            backfillAgeThresholdMs: 0,
            clock: ctx.clock,
          }),
          cursor: 0,
        }))
      for (const s of stores) s.cursor = o.from ? Number(o.from) : await s.store.latestCursor()
      if (o.from === '' && !o.follow) for (const s of stores) s.cursor = Math.max(0, s.cursor - 50)
      const stop = { v: false }
      process.on('SIGINT', () => {
        stop.v = true
      })
      try {
        do {
          for (const s of stores) {
            const events = await s.store.listAfter(s.cursor, 200, {
              ...(o.chat ? { chatIds: [o.chat] } : {}),
              ...(o.type ? { types: [o.type as never] } : {}),
            })
            for (const e of events) {
              s.cursor = e.cursor
              const body = (e.payload as { body?: string }).body
              const line = opts.json
                ? JSON.stringify({ account: s.id, ...e })
                : `${e.receivedAt.toISOString().slice(11, 19)} ${s.id} #${e.cursor} ${e.type.padEnd(24)} ${e.chatId ?? ''}${e.seq !== null ? `/${e.seq}` : ''} ${e.isFromMe ? '→' : '←'} ${body ? JSON.stringify(body.slice(0, 80)) : ''}${e.isBackfill ? ' [backfill]' : ''}`
              process.stdout.write(`${line}\n`)
            }
          }
          if (o.follow && !stop.v) await new Promise((r) => setTimeout(r, 500))
        } while (o.follow && !stop.v)
      } finally {
        await ctx.close()
      }
    })
}
