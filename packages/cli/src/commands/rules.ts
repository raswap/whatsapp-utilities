import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  accountSchemaName,
  actionKind,
  allStores,
  findRule,
  type ImportResult,
  importRules,
  operatorRules,
  operatorRuleVersions,
  provisionAccount,
  provisionOperator,
  RuleStore,
  type RuleStores,
  type StoredRule,
  tablesFor,
  watchRules,
} from '@wamcp/core'
import type { Command } from 'commander'
import { type CliContext, cliActor, type GlobalOptions, loadContext, out, table } from '../context.js'

/** One store per configured account plus the operator store for global rules; schemas are brought up to date first. */
async function openStores(ctx: CliContext): Promise<RuleStores> {
  await provisionOperator(ctx.handle)
  const accounts = new Map<string, RuleStore>()
  for (const cfg of ctx.config.accounts) {
    await provisionAccount(ctx.handle, cfg)
    accounts.set(
      cfg.id,
      new RuleStore(ctx.handle.db, tablesFor(accountSchemaName(cfg.id)), {
        accountId: cfg.id,
        accountType: cfg.type,
        targets: ctx.config.targets,
      }),
    )
  }
  const global = new RuleStore(
    ctx.handle.db,
    { rules: operatorRules, ruleVersions: operatorRuleVersions },
    { accountId: null, targets: ctx.config.targets },
  )
  return { global, accounts }
}

function summary(r: StoredRule) {
  return {
    id: r.id,
    scope: r.account ?? 'global',
    version: r.version,
    enabled: r.enabled ? 'yes' : 'no',
    suspended: r.suspendedReason ?? '',
    errors: r.errorCount,
    event: r.definition.when.event,
    actions: r.definition.actions.map(actionKind).join(','),
  }
}

async function mustFind(stores: RuleStores, id: string) {
  const found = await findRule(stores, id)
  if (!found) throw new Error(`no rule ${id}`)
  return found
}

function renderImport(r: ImportResult): string {
  if (!r.ok) return r.errors.map((e) => `${e.file}${e.path ? ` ${e.path}` : ''}: ${e.message}`).join('\n')
  if (r.rules.length === 0) return 'no rule files found'
  return table(
    r.rules.map((x) => ({
      file: x.file,
      id: x.id,
      scope: x.account ?? 'global',
      version: x.version,
      result: x.changed ? 'imported (disabled)' : 'unchanged',
    })),
    ['file', 'id', 'scope', 'version', 'result'],
  )
}

export function registerRules(program: Command) {
  const rules = program
    .command('rules')
    .description('rule definitions: database-authoritative, versioned, imported from YAML')

  rules
    .command('ls')
    .option('--account <id>', 'only rules of this account')
    .option('--global', 'only global rules')
    .description('list rules')
    .action(async (o: { account?: string; global?: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const stores = await openStores(ctx)
        let selected = allStores(stores)
        if (o.global) selected = [stores.global]
        else if (o.account) {
          const s = stores.accounts.get(o.account)
          if (!s) throw new Error(`no account ${o.account} in ${ctx.configPath}`)
          selected = [s]
        }
        const rows = (await Promise.all(selected.map((s) => s.list()))).flat().map(summary)
        out(opts, rows, () =>
          table(rows, ['id', 'scope', 'version', 'enabled', 'suspended', 'errors', 'event', 'actions']),
        )
      } finally {
        await ctx.close()
      }
    })

  rules
    .command('show <id>')
    .description('show a rule: state, versions, and its YAML')
    .action(async (id: string) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const { store, rule } = await mustFind(await openStores(ctx), id)
        const versions = await store.versions(id)
        const history = versions.map((v) => ({ version: v.version, actor: v.actor, createdAt: v.createdAt }))
        out(opts, { ...rule, versions: history }, () =>
          [
            `id: ${rule.id}`,
            `scope: ${rule.account ?? 'global'}`,
            `enabled: ${rule.enabled ? 'yes' : 'no'}`,
            `suspended: ${rule.suspendedReason ? `${rule.suspendedReason} at ${rule.suspendedAt?.toISOString()}` : 'no'}`,
            `errors: ${rule.errorCount}`,
            `versions: ${history.map((v) => `${v.version} (${v.actor}, ${v.createdAt.toISOString().slice(0, 16)})`).join(', ')}`,
            '---',
            rule.yaml.trimEnd(),
          ].join('\n'),
        )
      } finally {
        await ctx.close()
      }
    })

  rules
    .command('import [dir]')
    .option('--watch', 'keep running and re-import when files change')
    .description('import every *.yaml in a directory (default: rules/ next to the config); all or nothing')
    .action(async (dirArg: string | undefined, o: { watch?: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const dir = resolve(dirArg ?? resolve(ctx.configPath, '..', 'rules'))
        const stores = await openStores(ctx)
        const actor = cliActor()
        const report = (r: ImportResult) => {
          out(opts, r, () => renderImport(r))
          if (!r.ok) process.exitCode = 1
        }
        report(await importRules(dir, { stores, actor }))
        if (!o.watch) return
        const watcher = watchRules(dir, { stores, actor }, report)
        if (!opts.json) process.stdout.write(`watching ${dir} (Ctrl-C to stop)\n`)
        await new Promise<void>((done) => {
          const stop = () => {
            watcher.close()
            done()
          }
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
      } finally {
        await ctx.close()
      }
    })

  for (const [name, enable] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    rules
      .command(`${name} <id>`)
      .description(enable ? 'enable a rule; also clears a suspension' : 'disable a rule')
      .action(async (id: string) => {
        const opts = program.opts<GlobalOptions>()
        const ctx = await loadContext(opts, { needKey: false })
        try {
          const { store } = await mustFind(await openStores(ctx), id)
          const rule = enable ? await store.enable(id) : await store.disable(id)
          out(opts, summary(rule), () => `${id} ${enable ? 'enabled' : 'disabled'}`)
        } finally {
          await ctx.close()
        }
      })
  }

  rules
    .command('rollback <id> <version>')
    .description('store the YAML of an earlier version as a new version')
    .action(async (id: string, version: string) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const n = Number(version)
        if (!Number.isInteger(n) || n < 1) throw new Error('version must be a positive integer')
        const { store } = await mustFind(await openStores(ctx), id)
        const { rule, changed } = await store.rollback(id, n, cliActor())
        out(opts, { ...summary(rule), changed }, () =>
          changed
            ? `${id} rolled back to version ${n} as version ${rule.version}`
            : `${id} already matches version ${n}`,
        )
      } finally {
        await ctx.close()
      }
    })

  rules
    .command('export [dir]')
    .description('write every rule as <id>.yaml into a directory (default: rules/ next to the config)')
    .action(async (dirArg: string | undefined) => {
      const opts = program.opts<GlobalOptions>()
      const ctx = await loadContext(opts, { needKey: false })
      try {
        const dir = resolve(dirArg ?? resolve(ctx.configPath, '..', 'rules'))
        mkdirSync(dir, { recursive: true })
        const stores = await openStores(ctx)
        const written: Array<{ id: string; scope: string; file: string }> = []
        for (const store of allStores(stores))
          for (const r of await store.list()) {
            const file = resolve(dir, `${r.id}.yaml`)
            writeFileSync(file, r.yaml)
            written.push({ id: r.id, scope: r.account ?? 'global', file })
          }
        out(opts, written, () =>
          written.length ? table(written, ['id', 'scope', 'file']) : 'no rules to export',
        )
      } finally {
        await ctx.close()
      }
    })
}
