-- Operator schema: shared, deployment-wide data.
create schema if not exists __SCHEMA__;

create table if not exists __SCHEMA__.accounts (
  id text primary key,
  type text not null,
  display_name text not null,
  timezone text not null,
  status text not null default 'disconnected',
  paused boolean not null default false,
  throttled_until timestamptz,
  throttled_reason text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.tokens (
  id text primary key,
  name text not null,
  hash text not null unique,
  scopes jsonb not null,
  account_ids jsonb not null,
  chat_allowlist jsonb,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tokens_hash_idx on __SCHEMA__.tokens (hash);

create table if not exists __SCHEMA__.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists __SCHEMA__.audit_log (
  seq bigserial primary key,
  id text not null unique,
  actor text not null,
  kind text not null,
  subject_id text,
  decision text,
  detail jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
