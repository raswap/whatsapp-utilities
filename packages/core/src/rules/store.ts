import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import YAML from 'yaml'
import { type Clock, systemClock } from '../clock.js'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import type { ApprovalMode } from '../gate/types.js'
import { type RuleDefinition, RuleSchema, type TargetsConfig } from './schema.js'
import {
  hasRiskyAction,
  parseRuleYaml,
  RuleValidationError,
  type ValidateOptions,
  type ValidationResult,
} from './validate.js'

/** The `rules` + `rule_versions` pair of one schema: an account's, or the operator's for global rules. */
export type RuleTables = Pick<AccountTables, 'rules' | 'ruleVersions'>
export type RuleRow = RuleTables['rules']['$inferSelect']
export type RuleVersionRow = RuleTables['ruleVersions']['$inferSelect']

export interface StoredRule extends RuleRow {
  /** Account id, or null for a global rule. */
  account: string | null
  definition: RuleDefinition
}

export interface RuleStoreOptions {
  /** Account the tables belong to; null for the operator schema (global rules). */
  accountId: string | null
  accountType?: 'web' | 'cloud'
  targets?: TargetsConfig
  clock?: Clock
}

/** Consecutive errors after which a rule is suspended until `enable` (PRD §7.5). */
export const MAX_CONSECUTIVE_ERRORS = 5

/**
 * Rewrites `enabled` and `policy.approval` in YAML text, keeping comments and everything else.
 * Returns the input unchanged when the fields already hold the wanted values.
 */
export function setYamlFields(text: string, fields: { enabled?: boolean; approval?: ApprovalMode }): string {
  const doc = YAML.parseDocument(text)
  const top = doc.contents
  if (!YAML.isMap(top)) return text // validation reports that a rule is a mapping
  // Splice the source text at node offsets instead of re-serialising, so quoting, flow-collection
  // spacing and comments stay byte for byte. Edits are applied back to front.
  const edits: Array<{ start: number; end: number; insert: string }> = []
  const pairOf = (map: YAML.YAMLMap, key: string) =>
    map.items.find((p) => YAML.isScalar(p.key) && p.key.value === key)
  const lineAfter = (offset: number) => {
    const nl = text.indexOf('\n', offset)
    return nl === -1 ? text.length : nl + 1
  }
  const rangeOf = (node: unknown): [number, number, number] =>
    (node as YAML.Node).range as [number, number, number]
  const setScalar = (pair: YAML.Pair, value: string) => {
    const [start, end] = rangeOf(pair.value)
    edits.push({ start, end, insert: value })
  }
  const topInsertAt = () => {
    const id = pairOf(top, 'id')
    return id ? lineAfter(rangeOf(id.value)[1]) : rangeOf(top)[0]
  }
  const tail = text.endsWith('\n') || text === '' ? '' : '\n'

  if (fields.enabled !== undefined) {
    const pair = pairOf(top, 'enabled')
    if (!pair)
      edits.push({ start: topInsertAt(), end: topInsertAt(), insert: `enabled: ${fields.enabled}\n` })
    else if (YAML.isScalar(pair.value) && pair.value.value !== fields.enabled)
      setScalar(pair, String(fields.enabled))
  }
  if (fields.approval !== undefined) {
    const policy = pairOf(top, 'policy')
    const block = `policy:\n  approval: ${fields.approval}\n`
    if (!policy) edits.push({ start: text.length, end: text.length, insert: `${tail}${block}` })
    else if (YAML.isMap(policy.value) && policy.value.items.length > 0) {
      const approval = pairOf(policy.value, 'approval')
      if (approval) {
        if (YAML.isScalar(approval.value) && approval.value.value !== fields.approval)
          setScalar(approval, fields.approval)
      } else if (policy.value.flow) {
        const at = rangeOf(policy.value)[0] + 1
        edits.push({ start: at, end: at, insert: ` approval: ${fields.approval},` })
      } else {
        const first = rangeOf(policy.value.items[0]?.key)[0]
        const indent = first - (text.lastIndexOf('\n', first - 1) + 1)
        edits.push({
          start: first,
          end: first,
          insert: `approval: ${fields.approval}\n${' '.repeat(indent)}`,
        })
      }
    } else {
      // `policy:` with nothing under it, or `policy: {}`: rewrite the whole entry.
      const start = rangeOf(policy.key)[0]
      const end = lineAfter(policy.value ? rangeOf(policy.value)[1] : rangeOf(policy.key)[1])
      edits.push({ start, end, insert: block })
    }
  }
  let out = text
  for (const e of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.insert + out.slice(e.end)
  return out
}

/** FR-R8: a rule with a sending or side-effecting action that omits `policy.approval` gets `approve`. */
export function applyApprovalDefault(text: string): string {
  let raw: unknown
  try {
    raw = YAML.parse(text)
  } catch {
    return text // validation reports the parse error
  }
  const parsed = RuleSchema.safeParse(raw)
  if (!parsed.success || parsed.data.policy.approval !== undefined || !hasRiskyAction(parsed.data))
    return text
  return setYamlFields(text, { approval: 'approve' })
}

export class RuleStore {
  readonly accountId: string | null
  private readonly clock: Clock
  private readonly validateOptions: ValidateOptions

  constructor(
    private readonly db: Db,
    private readonly t: RuleTables,
    opts: RuleStoreOptions,
  ) {
    this.accountId = opts.accountId
    this.clock = opts.clock ?? systemClock
    this.validateOptions = {
      accountType: opts.accountType ?? null,
      ...(opts.targets ? { targets: opts.targets } : {}),
    }
  }

  /** 'global' or the account id, for messages. */
  get label(): string {
    return this.accountId ?? 'global'
  }

  /** Every FR-R4 check plus: the rule's `scope.account` must be this store's account. */
  validate(text: string): ValidationResult {
    const r = parseRuleYaml(text, this.validateOptions)
    if (r.definition && (r.definition.scope.account ?? null) !== this.accountId) {
      const want = this.accountId ? `scope.account: ${this.accountId}` : 'no scope.account (global)'
      r.issues.push({ path: 'scope.account', message: `this store holds rules with ${want}` })
    }
    return r
  }

  private hydrate(row: RuleRow): StoredRule {
    return { ...row, account: this.accountId, definition: RuleSchema.parse(YAML.parse(row.yaml)) }
  }

  async list(): Promise<StoredRule[]> {
    const rows = await this.db.select().from(this.t.rules).orderBy(asc(this.t.rules.id))
    return rows.map((r) => this.hydrate(r))
  }

  /** Enabled, non-suspended rules: what the engine evaluates. */
  async listActive(): Promise<StoredRule[]> {
    const rows = await this.db
      .select()
      .from(this.t.rules)
      .where(and(eq(this.t.rules.enabled, true), isNull(this.t.rules.suspendedReason)))
      .orderBy(asc(this.t.rules.id))
    return rows.map((r) => this.hydrate(r))
  }

  /** Changes whenever the active set changes; the engine reloads its cache when it differs. One cheap query. */
  async stamp(): Promise<string> {
    const [row] = await this.db
      .select({
        n: sql<number>`count(*)`,
        max: sql<string | null>`max(${this.t.rules.updatedAt})::text`,
      })
      .from(this.t.rules)
      .where(and(eq(this.t.rules.enabled, true), isNull(this.t.rules.suspendedReason)))
    return `${row?.n ?? 0}:${row?.max ?? ''}`
  }

  async get(id: string): Promise<StoredRule | null> {
    const [row] = await this.db.select().from(this.t.rules).where(eq(this.t.rules.id, id))
    return row ? this.hydrate(row) : null
  }

  async versions(id: string): Promise<RuleVersionRow[]> {
    return this.db
      .select()
      .from(this.t.ruleVersions)
      .where(eq(this.t.ruleVersions.ruleId, id))
      .orderBy(asc(this.t.ruleVersions.version))
  }

  /**
   * Validates and stores YAML as a new version (FR-R6). Identical text to the current version is a
   * no-op. `enabled` follows the YAML; `enable`/`disable` flip the column afterwards.
   */
  async save(id: string, text: string, actor: string): Promise<{ rule: StoredRule; changed: boolean }> {
    return this.write(id, applyApprovalDefault(text), actor)
  }

  /** Stores the byte-identical YAML of an earlier version as a new version. */
  async rollback(
    id: string,
    version: number,
    actor: string,
  ): Promise<{ rule: StoredRule; changed: boolean }> {
    const [v] = await this.db
      .select()
      .from(this.t.ruleVersions)
      .where(sql`${this.t.ruleVersions.ruleId} = ${id} and ${this.t.ruleVersions.version} = ${version}`)
    if (!v) throw new Error(`no version ${version} of rule ${id}`)
    return this.write(id, v.yaml, actor)
  }

  private async write(
    id: string,
    text: string,
    actor: string,
  ): Promise<{ rule: StoredRule; changed: boolean }> {
    const { definition, issues } = this.validate(text)
    if (!definition || issues.length > 0) throw new RuleValidationError(issues)
    if (definition.id !== id)
      throw new RuleValidationError([
        { path: 'id', message: `rule id "${definition.id}" does not match "${id}"` },
      ])
    const now = this.clock.now()
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(this.t.rules).where(eq(this.t.rules.id, id)).for('update')
      if (existing && existing.yaml === text) return { rule: this.hydrate(existing), changed: false }
      const version = (existing?.version ?? 0) + 1
      await tx.insert(this.t.ruleVersions).values({ ruleId: id, version, yaml: text, actor, createdAt: now })
      const values = { yaml: text, version, enabled: definition.enabled, updatedAt: now }
      const [row] = await tx
        .insert(this.t.rules)
        .values({ id, ...values })
        .onConflictDoUpdate({ target: this.t.rules.id, set: values })
        .returning()
      return { rule: this.hydrate(row as RuleRow), changed: true }
    })
  }

  private async setColumns(id: string, set: Partial<RuleRow>): Promise<StoredRule> {
    const [row] = await this.db
      .update(this.t.rules)
      .set({ ...set, updatedAt: this.clock.now() })
      .where(eq(this.t.rules.id, id))
      .returning()
    if (!row) throw new Error(`no rule ${id}`)
    return this.hydrate(row)
  }

  /** Turns the rule on and clears a suspension; the only way out of one (PRD §7.5). */
  enable(id: string): Promise<StoredRule> {
    return this.setColumns(id, { enabled: true, suspendedReason: null, suspendedAt: null, errorCount: 0 })
  }

  disable(id: string): Promise<StoredRule> {
    return this.setColumns(id, { enabled: false })
  }

  /** Deletes the rule and its versions. */
  async remove(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.delete(this.t.ruleVersions).where(eq(this.t.ruleVersions.ruleId, id))
      const rows = await tx
        .delete(this.t.rules)
        .where(eq(this.t.rules.id, id))
        .returning({ id: this.t.rules.id })
      return rows.length > 0
    })
  }

  /** Counts one evaluation error; the fifth consecutive one suspends the rule. */
  async markError(id: string, reason = 'errors'): Promise<StoredRule> {
    const now = this.clock.now()
    const [row] = await this.db
      .update(this.t.rules)
      .set({
        errorCount: sql`${this.t.rules.errorCount} + 1`,
        suspendedReason: sql`case when ${this.t.rules.errorCount} + 1 >= ${MAX_CONSECUTIVE_ERRORS} then coalesce(${this.t.rules.suspendedReason}, ${reason}) else ${this.t.rules.suspendedReason} end`,
        suspendedAt: sql`case when ${this.t.rules.errorCount} + 1 >= ${MAX_CONSECUTIVE_ERRORS} then coalesce(${this.t.rules.suspendedAt}, ${now}) else ${this.t.rules.suspendedAt} end`,
        updatedAt: now,
      })
      .where(eq(this.t.rules.id, id))
      .returning()
    if (!row) throw new Error(`no rule ${id}`)
    return this.hydrate(row)
  }

  /** A successful evaluation resets the consecutive-error count. */
  clearErrors(id: string): Promise<StoredRule> {
    return this.setColumns(id, { errorCount: 0 })
  }
}
