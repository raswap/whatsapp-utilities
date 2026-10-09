-- Per-account schema. __SCHEMA__ is replaced with acct_<id> at apply time.
create schema if not exists __SCHEMA__;

create table if not exists __SCHEMA__.events (
  cursor bigserial primary key,
  id text not null unique,
  type text not null,
  provider_id text,
  discriminator text not null default '',
  chat_id text,
  sender_id text,
  seq bigint,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  is_backfill boolean not null default false,
  is_from_me boolean not null default false,
  origin text,
  payload jsonb not null default '{}'::jsonb
);
create unique index if not exists events_dedup_uq on __SCHEMA__.events (chat_id, provider_id, type, discriminator) where provider_id is not null;
create unique index if not exists events_chat_seq_uq on __SCHEMA__.events (chat_id, seq) where seq is not null;
create index if not exists events_chat_cursor_idx on __SCHEMA__.events (chat_id, cursor);
create index if not exists events_type_cursor_idx on __SCHEMA__.events (type, cursor);

create table if not exists __SCHEMA__.chats (
  id text primary key,
  type text not null,
  name text,
  automation_state text not null default 'active',
  paused_until timestamptz,
  llm_enabled boolean not null default true,
  last_seq bigint not null default 0,
  archived boolean not null default false,
  pinned boolean not null default false,
  unread_count integer not null default 0,
  last_message_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.contacts (
  id text primary key,
  display_name text,
  push_name text,
  phone_enc text,
  phone_hash text,
  llm_enabled boolean not null default true,
  blocked boolean not null default false,
  allow_initiate boolean not null default false,
  first_dm_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contacts_phone_hash_idx on __SCHEMA__.contacts (phone_hash);

create table if not exists __SCHEMA__.identities (
  jid text primary key,
  contact_id text not null references __SCHEMA__.contacts (id),
  kind text not null,
  first_seen timestamptz not null default now()
);

create table if not exists __SCHEMA__.messages (
  id text primary key,
  provider_id text not null,
  chat_id text not null,
  sender_id text,
  event_id text not null,
  type text not null,
  body text,
  body_tsv tsvector generated always as (to_tsvector('simple', coalesce(body, ''))) stored,
  media_id text,
  quoted_provider_id text,
  is_from_me boolean not null default false,
  origin text,
  occurred_at timestamptz not null,
  deleted_at timestamptz,
  edited_at timestamptz,
  body_hash text
);
create unique index if not exists messages_chat_provider_uq on __SCHEMA__.messages (chat_id, provider_id);
create index if not exists messages_chat_time_idx on __SCHEMA__.messages (chat_id, occurred_at);
create index if not exists messages_chat_fromme_idx on __SCHEMA__.messages (chat_id, is_from_me, origin, occurred_at);
create index if not exists messages_body_tsv_idx on __SCHEMA__.messages using gin (body_tsv);

create table if not exists __SCHEMA__.group_participants (
  group_id text not null,
  contact_id text not null,
  role text not null default 'member',
  joined_at timestamptz,
  left_at timestamptz,
  primary key (group_id, contact_id)
);

create table if not exists __SCHEMA__.media (
  id text primary key,
  mime text not null,
  ext text not null,
  size bigint not null,
  sha256 text not null,
  path text not null,
  downloaded_at timestamptz not null default now(),
  purge_after timestamptz
);

create table if not exists __SCHEMA__.facts (
  id text primary key,
  subject_type text not null,
  subject_id text not null,
  key text not null,
  value text not null,
  source text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create unique index if not exists facts_subject_key_uq on __SCHEMA__.facts (subject_type, subject_id, key);

create table if not exists __SCHEMA__.summaries (
  chat_id text primary key,
  up_to_seq bigint not null,
  text text not null,
  model text not null,
  created_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.rules (
  id text primary key,
  version integer not null default 1,
  yaml text not null,
  enabled boolean not null default false,
  suspended_reason text,
  suspended_at timestamptz,
  error_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.rule_versions (
  rule_id text not null,
  version integer not null,
  yaml text not null,
  actor text not null,
  created_at timestamptz not null default now(),
  primary key (rule_id, version)
);

create table if not exists __SCHEMA__.actions (
  id text primary key,
  idempotency_key text not null,
  created_day date not null default current_date,
  state text not null,
  kind text not null,
  class text not null,
  source text not null,
  chat_id text,
  rule_id text,
  event_id text,
  body_hash text,
  message_id text,
  approval_code text,
  approval_created_by text,
  approval_decided_by text,
  approval_decided_at timestamptz,
  expires_at timestamptz,
  attempts integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  gate jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists actions_idem_day_uq on __SCHEMA__.actions (idempotency_key, created_day);
create unique index if not exists actions_message_id_uq on __SCHEMA__.actions (message_id) where message_id is not null;
create index if not exists actions_state_idx on __SCHEMA__.actions (state, updated_at);
create index if not exists actions_chat_idx on __SCHEMA__.actions (chat_id, created_at);

create table if not exists __SCHEMA__.audit_log (
  seq bigserial primary key,
  id text not null unique,
  actor text not null,
  kind text not null,
  subject_id text,
  event_id text,
  rule_id text,
  chat_id text,
  decision text,
  detail jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists audit_event_idx on __SCHEMA__.audit_log (event_id);
create index if not exists audit_rule_idx on __SCHEMA__.audit_log (rule_id, created_at);
create index if not exists audit_chat_idx on __SCHEMA__.audit_log (chat_id, created_at);

create table if not exists __SCHEMA__.rate_buckets (
  key text primary key,
  tokens integer not null,
  capacity integer not null,
  refill_per_second_milli integer not null,
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.counters (
  key text not null,
  window_start timestamptz not null,
  value integer not null default 0,
  primary key (key, window_start)
);

create table if not exists __SCHEMA__.session_state (
  key text primary key,
  value_enc text not null,
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.llm_usage (
  day date not null,
  scope text not null,
  calls integer not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  primary key (day, scope)
);
