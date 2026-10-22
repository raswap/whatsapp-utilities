# P1 Rule Engine: Design

Implements PRD §7.5 (rules and control levels), the P1 row of §14.6, and the bridge in §10.6. Decisions T28 to T35 in `docs/tech-stack.md` were taken with the owner on 2026-10-22. This document says how the PRD's normative text maps onto code; it does not restate it.

## 1. Scope of P1

In: rule schema and validation, DB-authoritative storage with versions and file import, the 12 scopes with specificity, the three-phase engine, every deterministic condition in FR-R2 except `language` (T31) and the LLM-derived ones, all `observe` and `counterparty_send` actions plus `remember_fact`, `schedule`, `notify` and `call_tool`, triggers (`event`, `schedule.cron`, `schedule.no_reply_within`, `manual`), `test_rule`, `explain_event`, rule MCP tools and CLI, registered targets with data policies.

Out (P2): `understand`, `llm_condition`, `language`, facts rendered into prompts, content guard. In P1 a rule using one of these fails validation with the message `needs P2 understanding`; the starter `group-daily-digest` stays disabled until then.

## 2. Data model

Existing tables in each account schema are reused: `rules` (id, version, yaml, enabled, suspended_reason, suspended_at, error_count), `rule_versions` (rule_id, version, yaml, actor), `facts`, `counters`, `rate_buckets`, `actions`, `audit_log`. Global rules (empty `scope`) live in the same two tables in the `operator` schema.

New, one migration per account schema (`0004_rules.sql`):

| Table | Purpose | Columns |
| --- | --- | --- |
| `scheduled_jobs` | Persisted triggers and delayed actions (FR-X4) | `id`, `rule_id`, `kind` (`cron` / `no_reply_within` / `delayed_action`), `run_at`, `chat_id`, `event_id`, `body_hash`, `payload` jsonb, `claimed_at`, `created_at`; index on `(run_at) where claimed_at is null` |
| `rule_traces` | Full traces for `matched`, `blocked`, `suppressed_by_state`, `error` (FR-R11); `not_matched` is summarised into one row per event | `event_id`, `rule_id`, `outcome`, `trace` jsonb, `state_snapshot` jsonb, `created_at`; primary key `(event_id, rule_id)` |

`rule_state` (counters, sampling draws, `skip_if_human_replied_within` lookups) uses the existing `counters` table with keys `rule:<id>:<counter>`; no new table.

## 3. Module layout

All in `packages/core/src/rules/`, pure functions wherever the PRD says pure:

| File | Responsibility |
| --- | --- |
| `schema.ts` | Zod schema for the YAML rule shape in §7.5 and the `targets:` block in §10.6 |
| `validate.ts` | FR-R4: scope keys vs connector capabilities, ≤ 10 actions, template variables against the namespace, regexes compile under re2js, targets registered, `call_tool` needs a deterministic sender condition, P2-only conditions rejected |
| `store.ts` | `RuleStore`: CRUD that always writes a `rule_versions` row, `rollback`, `enable` (clears `suspended`), `markError` with the 5-strike suspension |
| `import.ts` | `wamcp rules import [--watch]`: parse every file first, import nothing if any fails (FR-R6), imported rules land disabled with `approval: approve` (FR-R7) |
| `match.ts` | Scope matching and specificity (the weight table in §7.5), sort order (specificity desc, priority desc, id asc), deny-list union on scope match |
| `conditions.ts` | One pure predicate per FR-R2 condition over `(event, EvalContext)`; `keywords` per T34; `regex` via re2js with the 512-char and 64 KB limits; time windows in the account zone via `gate/hours.ts` |
| `templates.ts` | Mustache render with a variable whitelist from `docs/templates.md`, per-channel escaping (plain, Markdown, JSON), 64-char name cap, 4 096-char output cap |
| `engine.ts` | `plan(event, rules, state)` and `evaluate(event, rules, ctx)` as pure functions; `fetch(event, planned)` builds `EvalContext` from the stores |
| `scheduler.ts` | Polls `scheduled_jobs` every 2 s per account, claims with `update ... where claimed_at is null returning`, mints a synthetic event per firing (FR-X1), cancels `no_reply_within` on an inbound counterparty message and any job on edit or delete of its trigger |
| `bridge.ts` | Registered targets: `http` (header auth from `secret_ref`, timeout, body shaped by `data_policy`) and `mcp` (SDK client over Streamable HTTP, `tools` allowlist, `side_effecting` forces `approve`); SSRF per T32; failures per T33 |
| `explain.ts` | `test_rule` and `explain_event`: run `evaluate` with a pinned context and return the trace; `explain_event` also lists scope-skipped rules and the state snapshot from `rule_traces` |

Wiring: `createAccountRuntime` registers the engine as a pipeline handler (`pipeline.onEvent`), so events reach it in per-chat `seq` order with the existing dispatch watermark; a restart replays undelivered events. The handler calls `plan`, `fetch`, `evaluate`, applies state deltas, writes `rule_traces`, and hands planned actions to `executor.submit`. Limiter consumption stays in the gate (§7.6).

## 4. Engine contract

```ts
interface EvalContext {
  now: Date; zone: string; businessHours: BusinessHours
  chat: ChatRow | null; contact: ContactRow | null; labels: string[]
  lastHumanReplyAt: Date | null
  counters: Record<string, number>     // keyed rule:<id>:<name>
  facts: Record<string, string>        // subject = chat or contact
  rng: () => number                    // seeded with event.id
  llm: Record<string, unknown>         // empty in P1
}
type Outcome = 'matched' | 'not_matched' | 'blocked' | 'suppressed_by_state' | 'error'
interface RuleTrace { ruleId: string; outcome: Outcome; reason?: string; specificity: number; conditions: Array<{ name: string; passed: boolean; detail?: string }> }
interface Evaluation { traces: RuleTrace[]; actions: PlannedAction[]; deltas: Array<{ counter: string; by: number }> }
function evaluate(event: StoredEvent, rules: CompiledRule[], ctx: EvalContext): Evaluation
```

`evaluate` is deterministic: same event, rules and context give the same `Evaluation` (G5). Trace equality in tests excludes timing fields. `CompiledRule` is the validated rule with its regexes compiled and templates parsed once at load.

Short-circuits in `plan`: chat `paused` or `escalated`, account paused or throttled to `approve`, global kill → `counterparty_send` and `side_effecting` actions are dropped with `suppressed_by_state`; `observe` actions still run.

## 5. Actions

Existing kinds keep their executor paths. New kinds and their class:

| Kind | Class | Notes |
| --- | --- | --- |
| `remember_fact` | `observe`, or `side_effecting` when its value templates from `message.*` or `contact.display_name` (FR-R10) | `facts` table, `source = rule:<id>`, TTL |
| `schedule` | `observe` | inserts a `delayed_action` job bound to `(event_id, body_hash)` |
| `notify` | `side_effecting` | registered external target, or a WhatsApp chat other than the operator |
| `call_tool` | `side_effecting` | registered `mcp` or `http` target; per-target `side_effecting` forces `approve` |

The gate rule in §7.6 applies unchanged: a send or notify whose recipient is not the inbound sender and whose template uses message-derived variables is forced to `approve` and the destination must be on the rule's `destinations` allowlist.

## 6. Tools and CLI

MCP (scopes per §7.7): `list_rules`, `get_rule`, `test_rule`, `explain_event`, `export_rules` under `read:rules`; `create_rule`, `update_rule`, `delete_rule` (with `confirm`), `rollback_rule`, `import_rules`, `enable_rule` under `rules`, re-enabling a suspended rule under `admin`. Resources `whatsapp://{account}/rules` and `.../rules/{id}`.

CLI: `wamcp rules ls|show|import [--watch]|enable|disable|test|explain|rollback|export`.

## 7. Testing

- Golden traces: one fixture per trigger (FR-R1) and per condition (FR-R2), asserting the full `Evaluation` JSON.
- Determinism: a seeded loop over generated events and rule sets runs `evaluate` twice and compares; no new dependency, vitest only.
- Negative validation test per FR-R4 check; template injection fixtures per channel (FR-R3); the pathological-regex fixture on 64 KB under 10 ms; DST gap and overlap fixtures for time windows.
- SSRF fixtures: targets resolving to each refused range, a redirect to a private address, and a DNS name that resolves privately at call time.
- Bridge: a fake MCP server and a fake HTTP target in tests; `side_effecting` tool forces `approve`; failure produces one `failed` action, one alert, and an error-count increment.

Coverage thresholds (90 lines, 80 branches) hold for every PR.

## 8. Delivery (T35)

| PR | Contents | Done when |
| --- | --- | --- |
| 1 | `schema.ts`, `validate.ts`, `store.ts`, `import.ts`, migration `0004`, `wamcp rules ls|show|import|enable|disable|rollback|export` | Starter rules import, show, and round-trip byte-identical through rollback; every FR-R4 check has a failing fixture |
| 2 | `match.ts`, `conditions.ts`, `templates.ts`, `engine.ts`, runtime wiring, `rule_traces`, `remember_fact` and `schedule` actions | `urgent-notify` and `away-ack` fire end to end with fake connectors; golden traces and the determinism loop pass |
| 3 | `scheduler.ts`: cron, `no_reply_within`, delayed actions, `manual` trigger | Restart-at-2-minutes fixture fires at 5; edit cancels |
| 4 | `explain.ts`, rule MCP tools and resources, `wamcp rules test|explain` | `explain_event` answers "why didn't rule X fire for message Y" |
| 5 | `bridge.ts`, `targets:` config, `notify` and `call_tool` actions, SSRF and data-policy tests | Fake MCP and HTTP targets round-trip; every SSRF fixture is refused |
