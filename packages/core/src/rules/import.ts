import { type FSWatcher, readdirSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { type RuleStore, type StoredRule, setYamlFields } from './store.js'

/** One store per place rules can live: the operator schema for global rules, one per account. */
export interface RuleStores {
  global: RuleStore
  accounts: ReadonlyMap<string, RuleStore>
}

export interface ImportError {
  file: string
  path: string
  message: string
}

export interface ImportedRule {
  file: string
  id: string
  account: string | null
  version: number
  /** False when the file matched the stored YAML byte for byte and no version was written. */
  changed: boolean
}

export type ImportResult = { ok: true; rules: ImportedRule[] } | { ok: false; errors: ImportError[] }

export function allStores(stores: RuleStores): RuleStore[] {
  return [stores.global, ...stores.accounts.values()]
}

/** Rule ids are unique across the operator and every account store. */
export async function findRule(
  stores: RuleStores,
  id: string,
): Promise<{ store: RuleStore; rule: StoredRule } | null> {
  for (const store of allStores(stores)) {
    const rule = await store.get(id)
    if (rule) return { store, rule }
  }
  return null
}

export function listRuleFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
}

/**
 * Imports every rule file in `dir` (FR-R6): all files are parsed and validated first, and one bad
 * file imports nothing. Imported rules land `enabled: false` with `approval: approve` (FR-R7).
 */
export async function importRules(
  dir: string,
  opts: { stores: RuleStores; actor: string },
): Promise<ImportResult> {
  const errors: ImportError[] = []
  const prepared: Array<{ file: string; id: string; store: RuleStore; text: string }> = []
  const seen = new Map<string, string>()
  for (const file of listRuleFiles(dir)) {
    const original = readFileSync(join(dir, file), 'utf8')
    let raw: unknown
    try {
      raw = YAML.parse(original)
    } catch (e) {
      errors.push({ file, path: '', message: `YAML does not parse: ${(e as Error).message}` })
      continue
    }
    const scope = (raw as { scope?: { account?: unknown } } | null)?.scope
    const account = scope && typeof scope === 'object' ? scope.account : undefined
    const store = account === undefined ? opts.stores.global : opts.stores.accounts.get(String(account))
    if (!store) {
      errors.push({ file, path: 'scope.account', message: `unknown account "${String(account)}"` })
      continue
    }
    const text = setYamlFields(original, { enabled: false, approval: 'approve' })
    const { definition, issues } = store.validate(text)
    if (!definition || issues.length > 0) {
      for (const i of issues) errors.push({ file, ...i })
      continue
    }
    const dup = seen.get(definition.id)
    if (dup) {
      errors.push({ file, path: 'id', message: `rule "${definition.id}" is also defined in ${dup}` })
      continue
    }
    seen.set(definition.id, file)
    const elsewhere = await findRule(opts.stores, definition.id)
    if (elsewhere && elsewhere.store !== store) {
      errors.push({
        file,
        path: 'scope.account',
        message: `rule "${definition.id}" already exists as a ${elsewhere.store.label} rule`,
      })
      continue
    }
    prepared.push({ file, id: definition.id, store, text })
  }
  if (errors.length > 0) return { ok: false, errors }
  const rules: ImportedRule[] = []
  for (const p of prepared) {
    const { rule, changed } = await p.store.save(p.id, p.text, opts.actor)
    rules.push({ file: p.file, id: p.id, account: p.store.accountId, version: rule.version, changed })
  }
  return { ok: true, rules }
}

/** Re-imports the directory after changes settle for `debounceMs` (the `--watch` flag). */
export function watchRules(
  dir: string,
  opts: { stores: RuleStores; actor: string; debounceMs?: number },
  onResult: (result: ImportResult) => void,
): { close(): void } {
  let timer: NodeJS.Timeout | undefined
  const run = () => {
    timer = undefined
    importRules(dir, opts).then(onResult, (e: Error) =>
      onResult({ ok: false, errors: [{ file: '', path: '', message: e.message }] }),
    )
  }
  // shortcut: fs.watch on the directory only, no recursion; editors that write via a temp file still trigger a rename event here
  const watcher: FSWatcher = watch(dir, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, opts.debounceMs ?? 500)
  })
  return {
    close() {
      if (timer) clearTimeout(timer)
      watcher.close()
    },
  }
}
