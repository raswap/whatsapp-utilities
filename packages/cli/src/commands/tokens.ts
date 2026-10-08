import { SCOPES, type Scope } from '@wamcp/core'
import type { Command } from 'commander'
import { type GlobalOptions, loadContext, out, table } from '../context.js'

export function registerTokens(program: Command) {
  const tokens = program.command('tokens').description('MCP bearer tokens')
  tokens
    .command('create')
    .requiredOption('--name <name>', 'label for the token')
    .requiredOption('--scopes <list>', `comma-separated scopes: ${SCOPES.join(', ')}`)
    .option('--accounts <list>', 'comma-separated account ids, or * for all', '*')
    .option('--chats <list>', 'comma-separated chat ids the token may touch')
    .option('--ttl-days <n>', 'days until expiry; 0 for no expiry', '90')
    .description('create a token; the plaintext is shown once')
    .action(
      async (o: { name: string; scopes: string; accounts: string; chats?: string; ttlDays: string }) => {
        const opts = program.opts<GlobalOptions>()
        const ctx = await loadContext(opts, { needKey: false })
        try {
          const ttl = Number(o.ttlDays)
          const created = await ctx.tokens.create({
            name: o.name,
            scopes: o.scopes.split(',').map((s) => s.trim()) as Scope[],
            accountIds: o.accounts.split(',').map((s) => s.trim()),
            chatAllowlist: o.chats ? o.chats.split(',').map((s) => s.trim()) : null,
            ttlDays: ttl === 0 ? null : ttl,
          })
          out(
            opts,
            created,
            () =>
              `token ${created.id} (${created.name})\n${created.plaintext}\nexpires: ${created.expiresAt?.toISOString() ?? 'never'}\nStore it now; it is not shown again.`,
          )
        } finally {
          await ctx.close()
        }
      },
    )
  tokens
    .command('ls')
    .description('list tokens')
    .action(async () => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const rows = await ctx.tokens.list()
        out(opts, rows, () =>
          table(
            rows.map((r) => ({
              id: r.id,
              name: r.name,
              scopes: (r.scopes as string[]).join(','),
              accounts: (r.accountIds as string[]).join(','),
              expires: r.expiresAt?.toISOString().slice(0, 10) ?? 'never',
              last_used: r.lastUsedAt?.toISOString().slice(0, 16) ?? '',
              revoked: r.revokedAt ? 'yes' : '',
            })),
            ['id', 'name', 'scopes', 'accounts', 'expires', 'last_used', 'revoked'],
          ),
        )
      } finally {
        await ctx.close()
      }
    })
  tokens
    .command('revoke <id>')
    .description('revoke a token')
    .action(async (id: string) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const ok = await ctx.tokens.revoke(id)
        out(opts, { id, revoked: ok }, () => (ok ? `revoked ${id}` : `no active token ${id}`))
        if (!ok) process.exitCode = 1
      } finally {
        await ctx.close()
      }
    })
}
