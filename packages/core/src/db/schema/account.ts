import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

/**
 * Per-account tables. Every account has an identical set under its own Postgres schema
 * (`acct_<id>`), so backup, restore, and purge are schema operations (PRD D9, tech-stack T5).
 */
export function accountTables(schemaName: string) {
  const s = pgSchema(schemaName)

  const events = s.table(
    'events',
    {
      cursor: bigserial('cursor', { mode: 'number' }).primaryKey(),
      id: text('id').notNull().unique(),
      type: text('type').notNull(),
      providerId: text('provider_id'),
      discriminator: text('discriminator').notNull().default(''),
      chatId: text('chat_id'),
      senderId: text('sender_id'),
      seq: bigint('seq', { mode: 'number' }),
      occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
      receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
      isBackfill: boolean('is_backfill').notNull().default(false),
      isFromMe: boolean('is_from_me').notNull().default(false),
      origin: text('origin'),
      payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    },
    (t) => [
      uniqueIndex('events_dedup_uq')
        .on(t.chatId, t.providerId, t.type, t.discriminator)
        .where(sql`${t.providerId} is not null`),
      uniqueIndex('events_chat_seq_uq').on(t.chatId, t.seq).where(sql`${t.seq} is not null`),
      index('events_chat_cursor_idx').on(t.chatId, t.cursor),
      index('events_type_cursor_idx').on(t.type, t.cursor),
    ],
  )

  const chats = s.table('chats', {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // dm | group | community | broadcast | channel | status
    name: text('name'),
    automationState: text('automation_state').notNull().default('active'),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    llmEnabled: boolean('llm_enabled').notNull().default(true),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    archived: boolean('archived').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const contacts = s.table(
    'contacts',
    {
      id: text('id').primaryKey(),
      displayName: text('display_name'),
      pushName: text('push_name'),
      phoneEnc: text('phone_enc'),
      phoneHash: text('phone_hash'),
      llmEnabled: boolean('llm_enabled').notNull().default(true),
      blocked: boolean('blocked').notNull().default(false),
      allowInitiate: boolean('allow_initiate').notNull().default(false),
      firstDmAt: timestamp('first_dm_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [index('contacts_phone_hash_idx').on(t.phoneHash)],
  )

  const identities = s.table('identities', {
    jid: text('jid').primaryKey(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id),
    kind: text('kind').notNull(), // phone | lid
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
  })

  const messages = s.table(
    'messages',
    {
      id: text('id').primaryKey(),
      providerId: text('provider_id').notNull(),
      chatId: text('chat_id').notNull(),
      senderId: text('sender_id'),
      eventId: text('event_id').notNull(),
      type: text('type').notNull(),
      body: text('body'),
      bodyTsv: tsvector('body_tsv').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(body, ''))`),
      mediaId: text('media_id'),
      quotedProviderId: text('quoted_provider_id'),
      isFromMe: boolean('is_from_me').notNull().default(false),
      origin: text('origin'),
      occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
      editedAt: timestamp('edited_at', { withTimezone: true }),
      bodyHash: text('body_hash'),
    },
    (t) => [
      uniqueIndex('messages_chat_provider_uq').on(t.chatId, t.providerId),
      index('messages_chat_time_idx').on(t.chatId, t.occurredAt),
      index('messages_chat_fromme_idx').on(t.chatId, t.isFromMe, t.origin, t.occurredAt),
      index('messages_body_tsv_idx').using('gin', t.bodyTsv),
    ],
  )

  const groupParticipants = s.table(
    'group_participants',
    {
      groupId: text('group_id').notNull(),
      contactId: text('contact_id').notNull(),
      role: text('role').notNull().default('member'),
      joinedAt: timestamp('joined_at', { withTimezone: true }),
      leftAt: timestamp('left_at', { withTimezone: true }),
    },
    (t) => [primaryKey({ columns: [t.groupId, t.contactId] })],
  )

  const media = s.table('media', {
    id: text('id').primaryKey(),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    path: text('path').notNull(),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }).notNull().defaultNow(),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  })

  const facts = s.table(
    'facts',
    {
      id: text('id').primaryKey(),
      subjectType: text('subject_type').notNull(),
      subjectId: text('subject_id').notNull(),
      key: text('key').notNull(),
      value: text('value').notNull(),
      source: text('source').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [uniqueIndex('facts_subject_key_uq').on(t.subjectType, t.subjectId, t.key)],
  )

  const summaries = s.table('summaries', {
    chatId: text('chat_id').primaryKey(),
    upToSeq: bigint('up_to_seq', { mode: 'number' }).notNull(),
    text: text('text').notNull(),
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const rules = s.table('rules', {
    id: text('id').primaryKey(),
    version: integer('version').notNull().default(1),
    yaml: text('yaml').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    suspendedReason: text('suspended_reason'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    errorCount: integer('error_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const ruleVersions = s.table(
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

  const actions = s.table(
    'actions',
    {
      id: text('id').primaryKey(),
      idempotencyKey: text('idempotency_key').notNull(),
      createdDay: date('created_day').notNull().default(sql`current_date`),
      state: text('state').notNull(),
      kind: text('kind').notNull(),
      class: text('class').notNull(), // observe | counterparty_send | side_effecting
      source: text('source').notNull(), // rule:<id> | token:<id> | cli | self_command
      chatId: text('chat_id'),
      ruleId: text('rule_id'),
      eventId: text('event_id'),
      bodyHash: text('body_hash'),
      messageId: text('message_id'),
      approvalCode: text('approval_code'),
      approvalCreatedBy: text('approval_created_by'),
      approvalDecidedBy: text('approval_decided_by'),
      approvalDecidedAt: timestamp('approval_decided_at', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      attempts: integer('attempts').notNull().default(0),
      payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
      gate: jsonb('gate').notNull().default(sql`'{}'::jsonb`),
      result: jsonb('result'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex('actions_idem_day_uq').on(t.idempotencyKey, t.createdDay),
      uniqueIndex('actions_message_id_uq').on(t.messageId).where(sql`${t.messageId} is not null`),
      index('actions_state_idx').on(t.state, t.updatedAt),
      index('actions_chat_idx').on(t.chatId, t.createdAt),
    ],
  )

  const auditLog = s.table(
    'audit_log',
    {
      seq: bigserial('seq', { mode: 'number' }).primaryKey(),
      id: text('id').notNull().unique(),
      actor: text('actor').notNull(),
      kind: text('kind').notNull(),
      subjectId: text('subject_id'),
      eventId: text('event_id'),
      ruleId: text('rule_id'),
      chatId: text('chat_id'),
      decision: text('decision'),
      detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
      prevHash: text('prev_hash'),
      hash: text('hash').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index('audit_event_idx').on(t.eventId),
      index('audit_rule_idx').on(t.ruleId, t.createdAt),
      index('audit_chat_idx').on(t.chatId, t.createdAt),
    ],
  )

  const rateBuckets = s.table('rate_buckets', {
    key: text('key').primaryKey(),
    tokens: integer('tokens').notNull(),
    capacity: integer('capacity').notNull(),
    intervalMs: integer('interval_ms').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const counters = s.table(
    'counters',
    {
      key: text('key').notNull(),
      windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
      value: integer('value').notNull().default(0),
    },
    (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
  )

  const sessionState = s.table('session_state', {
    key: text('key').primaryKey(),
    valueEnc: text('value_enc').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  })

  const chatLabels = s.table(
    'chat_labels',
    {
      chatId: text('chat_id').notNull(),
      label: text('label').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.chatId, t.label] })],
  )

  const llmUsage = s.table(
    'llm_usage',
    {
      day: date('day').notNull(),
      scope: text('scope').notNull(),
      calls: integer('calls').notNull().default(0),
      tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
      tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    },
    (t) => [primaryKey({ columns: [t.day, t.scope] })],
  )

  return {
    schema: s,
    events,
    chats,
    contacts,
    identities,
    messages,
    groupParticipants,
    media,
    facts,
    summaries,
    rules,
    ruleVersions,
    actions,
    auditLog,
    rateBuckets,
    counters,
    sessionState,
    chatLabels,
    llmUsage,
  }
}

export type AccountTables = ReturnType<typeof accountTables>

const cache = new Map<string, AccountTables>()
export function tablesFor(schemaName: string): AccountTables {
  let t = cache.get(schemaName)
  if (!t) {
    t = accountTables(schemaName)
    cache.set(schemaName, t)
  }
  return t
}
