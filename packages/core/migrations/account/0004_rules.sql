-- P1 rule engine (docs/rule-engine-design.md §2). Used by the scheduler (PR 3) and the engine (PR 2).

-- Persisted triggers and delayed actions (FR-X4).
create table if not exists __SCHEMA__.scheduled_jobs (
  id text primary key,
  rule_id text not null,
  kind text not null, -- cron | no_reply_within | delayed_action
  run_at timestamptz not null,
  chat_id text,
  event_id text,
  body_hash text,
  payload jsonb not null default '{}'::jsonb,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_jobs_due_idx on __SCHEMA__.scheduled_jobs (run_at) where claimed_at is null;

-- Full traces for matched, blocked, suppressed_by_state and error; not_matched is one summary row per event (FR-R11).
create table if not exists __SCHEMA__.rule_traces (
  event_id text not null,
  rule_id text not null,
  outcome text not null,
  trace jsonb not null default '{}'::jsonb,
  state_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (event_id, rule_id)
);
