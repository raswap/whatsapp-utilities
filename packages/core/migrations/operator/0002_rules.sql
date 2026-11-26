-- Global rules (empty scope, no account key) live in the operator schema; same shape as the account tables.
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
