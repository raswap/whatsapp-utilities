-- Dispatcher watermark and other small per-account pipeline state.
create table if not exists __SCHEMA__.pipeline_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
