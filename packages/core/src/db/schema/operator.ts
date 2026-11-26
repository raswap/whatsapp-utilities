import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

/** Shared, operator-owned data. One instance per deployment. */
export const operatorSchema = pgSchema('operator')

export const accounts = operatorSchema.table('accounts', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'web' | 'cloud'
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull(),
  status: text('status').notNull().default('disconnected'),
  paused: boolean('paused').notNull().default(false),
  throttledUntil: timestamp('throttled_until', { withTimezone: true }),
  throttledReason: text('throttled_reason'),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const tokens = operatorSchema.table(
  'tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** SHA-256 of the bearer token; the plaintext is shown once at creation. */
    hash: text('hash').notNull().unique(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    accountIds: jsonb('account_ids').$type<string[]>().notNull(),
    chatAllowlist: jsonb('chat_allowlist').$type<string[] | null>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tokens_hash_idx').on(t.hash)],
)

export const operatorSettings = operatorSchema.table('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const operatorAudit = operatorSchema.table('audit_log', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  id: text('id').notNull().unique(),
  actor: text('actor').notNull(),
  kind: text('kind').notNull(),
  subjectId: text('subject_id'),
  decision: text('decision'),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  prevHash: text('prev_hash'),
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Global rules: a rule whose scope has no `account` key (PRD §7.5). Same columns as the account tables. */
export const operatorRules = operatorSchema.table('rules', {
  id: text('id').primaryKey(),
  version: integer('version').notNull().default(1),
  yaml: text('yaml').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  suspendedReason: text('suspended_reason'),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  errorCount: integer('error_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const operatorRuleVersions = operatorSchema.table(
  'rule_versions',
  {
    ruleId: text('rule_id').notNull(),
    version: integer('version').notNull(),
    yaml: text('yaml').notNull(),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.version] })],
)

export const operatorTables = {
  accounts,
  tokens,
  operatorSettings,
  operatorAudit,
  operatorRules,
  operatorRuleVersions,
}
