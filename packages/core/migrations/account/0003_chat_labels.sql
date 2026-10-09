create table if not exists __SCHEMA__.chat_labels (
  chat_id text not null,
  label text not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, label)
);

-- Token buckets store the per-token refill interval in milliseconds.
alter table __SCHEMA__.rate_buckets rename column refill_per_second_milli to interval_ms;
