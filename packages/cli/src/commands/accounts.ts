import type { WebConnector } from '@wamcp/connector-web'
import { provisionAccount, provisionOperator } from '@wamcp/core'
import type { Command } from 'commander'
import qrcode from 'qrcode-terminal'
import { cliActor, type GlobalOptions, loadContext, out, table } from '../context.js'
import { buildRuntimes } from '../runtimes.js'

const TOS_TEXT = `Pairing a personal or Business App number uses the WhatsApp Web protocol through an unofficial library.
This breaches WhatsApp's Terms of Service and can get the number banned. Use a dedicated number (PRD D10).
Type "I understand" to continue.`

export function registerAccounts(program: Command) {
  const accounts = program.command('accounts').description('WhatsApp accounts')
  accounts
    .command('ls')
    .description('list configured accounts and their database state')
    .action(async () => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const { accounts: tbl } = await import('@wamcp/core')
        const rows = await ctx.handle.db.select().from(tbl)
        const merged = ctx.config.accounts.map((c) => {
          const r = rows.find((x) => x.id === c.id)
          return {
            id: c.id,
            type: c.type,
            name: c.display_name,
            timezone: c.timezone,
            provisioned: r ? 'yes' : 'no',
            paused: r?.paused ? 'yes' : '',
            throttled:
              r?.throttledUntil && r.throttledUntil > new Date()
                ? r.throttledUntil.toISOString().slice(0, 16)
                : '',
          }
        })
        out(opts, merged, () =>
          table(merged, ['id', 'type', 'name', 'timezone', 'provisioned', 'paused', 'throttled']),
        )
      } finally {
        await ctx.close()
      }
    })

  accounts
    .command('pair <id>')
    .option('--phone <e164>', 'request a pairing code for this number instead of a QR')
    .option('--accept-tos', 'skip the interactive Terms of Service acknowledgement')
    .option('--timeout <seconds>', 'give up after this long', '180')
    .description('pair a web account: shows a QR (or pairing code) and waits until connected')
    .action(async (id: string, o: { phone?: string; acceptTos?: boolean; timeout: string }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const cfg = ctx.config.accounts.find((a) => a.id === id)
        if (!cfg) throw new Error(`no account ${id} in ${ctx.configPath}`)
        if (cfg.type !== 'web')
          throw new Error('only web accounts pair; Cloud API accounts are configured with credentials')
        if (!o.acceptTos) {
          const { createInterface } = await import('node:readline/promises')
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          const answer = await rl.question(`${TOS_TEXT}\n> `)
          rl.close()
          if (answer.trim().toLowerCase() !== 'i understand') throw new Error('pairing cancelled')
        }
        await provisionOperator(ctx.handle)
        await provisionAccount(ctx.handle, cfg)
        const rts = await buildRuntimes(ctx, {
          fake: false,
          only: id,
          ...(o.phone ? { pairingPhones: { [id]: o.phone } } : {}),
          onQr: (_a, qr) => {
            process.stdout.write('\nScan this QR in WhatsApp > Linked devices > Link a device:\n')
            qrcode.generate(qr, { small: true })
          },
          onPairingCode: (_a, code) =>
            process.stdout.write(
              `\nPairing code: ${code}\nEnter it in WhatsApp > Linked devices > Link with phone number.\n`,
            ),
          onState: (_a, s, r) => process.stdout.write(`state: ${s}${r ? ` (${r})` : ''}\n`),
        })
        const rt = rts.get(id)
        if (!rt) throw new Error('runtime not built')
        await rt.start()
        const deadline = Date.now() + Number(o.timeout) * 1000
        while (Date.now() < deadline) {
          const s = rt.connector.health().state
          if (s === 'connected') {
            process.stdout.write(
              `paired. Session stored encrypted in acct_${id}.session_state. Run "wamcp serve".\n`,
            )
            await rt.audit.append({ actor: cliActor(), kind: 'account', subjectId: id, decision: 'paired' })
            await rt.stop()
            return
          }
          if (s === 'logged_out') throw new Error('pairing failed: logged out')
          await new Promise((r) => setTimeout(r, 500))
        }
        await rt.stop()
        throw new Error('pairing timed out')
      } finally {
        await ctx.close()
      }
    })

  accounts
    .command('unpair <id>')
    .description('log out and delete the stored session (re-pair needed afterwards)')
    .action(async (id: string) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts)
      try {
        const rts = await buildRuntimes(ctx, { fake: false, only: id })
        const rt = rts.get(id)
        if (!rt) throw new Error(`no account ${id}`)
        await (rt.connector as WebConnector).logout()
        await rt.audit.append({ actor: cliActor(), kind: 'account', subjectId: id, decision: 'unpaired' })
        out(opts, { id, unpaired: true }, () => `session for ${id} removed`)
      } finally {
        await ctx.close()
      }
    })

  for (const [name, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    accounts
      .command(`${name} <id>`)
      .description(paused ? 'kill switch: stop all gated actions on the account' : 'resume gated actions')
      .action(async (id: string) => {
        const opts = program.opts<GlobalOptions>()
        const ctx = await loadContext(opts)
        try {
          const rts = await buildRuntimes(ctx, { fake: true, only: id })
          const rt = rts.get(id)
          if (!rt) throw new Error(`no account ${id}`)
          await rt.setPaused(paused, cliActor())
          out(opts, { id, paused }, () => `${id} ${paused ? 'paused' : 'resumed'}`)
        } finally {
          await ctx.close()
        }
      })
  }

  accounts
    .command('unthrottle <id>')
    .description('clear the automatic throttle applied after WhatsApp spam signals')
    .action(async (id: string) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        await ctx.operatorState.setThrottled(id, null, null)
        out(opts, { id, throttled: false }, () => `${id} throttle cleared`)
      } finally {
        await ctx.close()
      }
    })

  program
    .command('kill')
    .option('--off', 'turn the global kill switch off')
    .description('global kill switch: block every gated action on every account')
    .action(async (o: { off?: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        await ctx.operatorState.setGlobalKill(!o.off)
        out(opts, { global_kill: !o.off }, () => `global kill switch ${o.off ? 'OFF' : 'ON'}`)
      } finally {
        await ctx.close()
      }
    })
}
