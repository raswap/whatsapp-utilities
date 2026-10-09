# WhatsApp MCP: Product Requirements Document

| Field | Value |
| --- | --- |
| Status | Draft v0.4 (tech stack decided; see `docs/tech-stack.md`) |
| Owner | raswap |
| Repository | `raswap/whatsapp-utilities` |
| Last updated | 2026-10-08 |
| Changes since v0.2 | Four adversarial reviews (product, engineering, security, operations) produced 95 findings; dispositions are in `docs/PRD-review-log.md`. Headline changes: honest loss guarantee for the Web connector (§4.1, §7.2); dedicated **operator channel** that bypasses the policy gate (§7.1, §7.6); **action classes** so side-effecting actions get the same approval default as sends (§7.3); **separation of duties** on approvals and split read scopes (§7.7); three-phase rule engine with explicit state snapshot (§7.5); pre-generated message ids for idempotent sends (§7.3); identity resolution for LID/phone (§7.2); LLM budgets (§12); per-account data directories, backup/restore, migrations, alerts delivery, and crash-loop handling (§9, §11, §13); P0 split into P0a and P0b (§14.6) |

Requirement keywords **MUST**, **MUST NOT**, **SHOULD**, **MAY** are used in the RFC 2119 sense.

---

## 1. Summary

Build a **WhatsApp MCP server** ("the system") that connects to one or more WhatsApp accounts (personal or business), **monitors them in real time**, exposes the account to AI agents through the **Model Context Protocol (MCP)**, and **automatically takes actions** (reply, forward, label, notify, escalate, call out to other systems) according to a **layered ruleset** scoped to the account, a chat, a group, a contact, a message type, a time window, or any combination.

The system has three faces:

1. **Connector + monitor**: a long-running process that keeps the WhatsApp session alive, receives every inbound event (messages, replies, reactions, group changes, receipts, calls) and persists it before any rule or client sees it.
2. **Rule engine + understanding layer**: evaluates each event against the active rules. Rules can be deterministic (keyword, sender, time) or semantic (an LLM classifies intent, sentiment, urgency, and conversation context before a rule fires).
3. **MCP server**: lets any MCP client (Claude Desktop, Claude Code, a custom agent) read chats, send messages, inspect context, and manage rules through typed tools, resources, and live notifications.

Every outbound action, whether from a rule or an agent, passes through one **policy gate** that enforces approvals, rate limits, allow/deny lists, loop protection, and audit logging. The one exception is the **operator channel**, the system's own line to the human operator, which bypasses the gate so that approvals and alerts always arrive.

---

## 2. Decisions and assumptions

| # | Decision | Default | Rationale | Reversal cost |
| --- | --- | --- | --- | --- |
| D1 | First account type | Personal / Business App via the Web connector | Covers groups and personal use; no Meta onboarding | Low: Cloud API connector is P3 behind the same interface |
| D2 | Hosting | Single always-on Linux or macOS host; `wamcp` process plus Postgres 16 from the shipped compose file, or under systemd with a local Postgres | Simplest reliable deployment for one operator | Medium: Redis bus in P4 |
| D3 | Primary MCP client | Claude Code and Claude Desktop over the stdio proxy; custom agents over Streamable HTTP | Matches how the owner works | None: both ship in P0a (tech-stack T9) |
| D4 | Default autonomy | Every rule with a `counterparty_send` or `side_effecting` action (§7.3) is created with `approval: approve`. Switching a rule to `auto` is an audited admin action with `confirm: true`. There is **no** time-based automatic flip | A wrong automated reply or trade is the most expensive failure; a calendar flip is a silent change in risk | None: config |
| D5 | Model provider | Claude API; fast model for classification, stronger model for drafting; provider behind an interface; model ids in config | Best quality per cost | Low |
| D6 | Local-model option | Out of scope for v1; chats can be opted out of LLM processing entirely | Keeps v1 small | Medium |
| D7 | Bridge to other systems | `call_tool` to registered MCP servers and webhooks ships in P1; nothing trading-specific in this repo | Keeps the repo generic | None |
| D8 | Language and runtime | TypeScript, Node.js 26 (LTS from October 2026) | Baileys and the MCP SDK are Node-first | High after P0 |
| D9 | Storage | PostgreSQL 16 with one schema per account (`acct_<id>`) and an `operator` schema; application-level AES-256-GCM for session state, tokens, and phone numbers; message bodies plaintext for `tsvector` search; media on local disk under `data/<account>/media/` | Per-account blast radius for backup, restore, purge via schema; real concurrency from day one | High after P0a (tech-stack T3 to T7) |
| D10 | Automation number | Run automation on a dedicated number. The operator's own phone number(s) are registered as `operator_numbers` and are how the operator commands the system from a phone | Unofficial protocol carries ban risk; keeps the personal number clean | None |
| D11 | Operator channel | At least one **non-WhatsApp** operator channel (email or HTTP webhook, for example an ntfy or Telegram relay) is required when any Web account exists, because WhatsApp itself is the channel most likely to be down | Logout and connector-down alerts must still arrive | None |
| D12 | Group management | Group **reads** ship in P0a. Group **mutations** (create, add, remove, promote, settings, leave) and polls ship in P4 behind an opt-in capability flag | Highest ban-risk surface, serves no v1 persona | None |
| D13 | Team / support desk persona | Deferred past v1. The system is single-operator; "assign to human N" is a P4 candidate | Non-goal §4.2 already excludes multi-tenant | Medium |
| D14 | Web connector loss guarantee | "No loss except inside the library's ack-to-persist window", stated honestly (§4.1) | The Web protocol acks before the application sees the message; pretending otherwise would make the chaos tests pass only against the fake connector | — |

---

## 3. Problem statement

WhatsApp is where a large share of personal, customer, and team communication happens, but it offers no programmable, context-aware automation to end users:

- Personal and small-business accounts have **no official API**.
- The official Business Platform (Cloud API) is webhook-based and stateless. It gives raw messages, not **conversation understanding** or **rules**.
- Existing bots are keyword responders. They cannot apply different behaviour per chat, per group, or per contact, and they cannot tell that *"this is the third refund request from this customer and they are getting angry"*.
- AI agents (via MCP) can reason about messages but have no safe, governed way to **act** on WhatsApp.

We want one system that gives a human operator **fine-grained, auditable control** over what an agent may see and do on each part of their WhatsApp, while the agent handles reading, understanding, and routine replies.

---

## 4. Goals, non-goals, and success metrics

### 4.1 Goals

| ID | Goal | Measure |
| --- | --- | --- |
| G1 | One abstraction over personal, Business App, and Cloud API accounts | The same rule pack and MCP tools run on all three; unsupported capabilities are rejected with `CAPABILITY_UNSUPPORTED`, never silently ignored |
| G2 | Real-time monitoring with an honest loss bound | p95 arrival → persisted ≤ 500 ms; p95 persisted → rule decision and subscriber notification ≤ 2 s excluding LLM time, plus a separate metric including LLM time. **Web connector:** no event loss once the library has handed the event to the system; loss inside the library's ack-to-persist window is bounded by the measured window (target < 50 ms) and reported. **Cloud API:** zero loss (Meta retries until the webhook returns 200 after persistence). Verified by the chaos suite §14.3 |
| G3 | Send, read replies, follow threads | One tool call returns a message, its quoted chain, and sender metadata |
| G4 | Context understanding | For any message the system returns intent (from a configured taxonomy), sentiment, urgency, entities, summary, and the context it used, in a fixed JSON schema |
| G5 | Layered, deterministic rules | Given the same event, rule set, and state snapshot, evaluation yields the same match trace and state deltas (property-tested) |
| G6 | Safe autonomy | 100 % of counterparty-facing and side-effecting actions pass the policy gate; the operator channel is the only gate bypass and it can only reach the operator; every decision is audited |
| G7 | Multi-account isolation | Separate database, session store, media directory, rate buckets, LLM budget, and worker quotas per account; no tool can read or act across accounts without an `account_id` the token is scoped to |

### 4.2 Non-goals (v1)

- Bulk marketing or cold outreach. The system **MUST NOT** provide a tool or rule action that sends to a list of arbitrary numbers.
- Reading content the connected account cannot see.
- A CRM, ticketing system, or analytics product.
- Replacing the WhatsApp UI.
- Multi-tenant SaaS or multi-human support desks (D13).

### 4.3 Success metrics (first 30 days)

| Metric | Target | Measurement |
| --- | --- | --- |
| Events lost | 0 outside the ack-to-persist window | Daily reconciliation job compares the store against the phone's chat list and last-message ids via the connector's history API; discrepancies are logged as `reconciliation.gap` |
| Unplanned re-pairings | ≤ 1 | `connection.state{logged_out}` count |
| Automated sends corrected by the operator | < 5 % | Correction signal: an `origin: self_system` message deleted by the operator, or a human reply (`origin: other_device`) in the same chat within 10 minutes of an automated send. Recorded in audit as `correction` |
| Urgent message → operator notified | p95 < 10 s | Operator channel delivery timestamp minus `received_at` |
| Rule evaluations with an exception | 0 | `wamcp_rule_errors_total` |

---

## 5. Users and personas

| Persona | Account type | Needs |
| --- | --- | --- |
| **Solo operator** (primary) | Personal + Business App | Triage personal and work WhatsApp with an AI assistant; auto-acknowledge; summarise groups; draft replies; never miss urgent messages |
| **Small business** | Business App or Cloud API | Answer FAQs automatically, hand off complex cases, respect business hours, track open customer threads |
| **Developer / agent builder** | Any | A clean, typed MCP surface with scoped tokens |

The multi-human support desk persona is deferred (D13).

---

## 6. Account types and connectivity

| Account type | Transport | Auth | Capabilities | Risk |
| --- | --- | --- | --- | --- |
| **Personal** | WhatsApp Web multi-device protocol (Baileys, pinned to an exact version) | QR or pairing code; session keys persisted | Full read/write: DMs, groups, communities, media, reactions, presence | Unofficial. Violates WhatsApp ToS. Ban risk rises with spam-like behaviour |
| **Business App** | Same protocol | Same | Same, plus business labels and catalog metadata | Same |
| **Business Platform (Cloud API)** | Meta Graph API + webhooks | System-user token, WABA ID, phone number ID, verify token, app secret | Text, media, interactive, template messages; status callbacks; 24-hour customer-service window; **no groups** | Official. Metered. Needs a public HTTPS endpoint |

**Connector contract.** Each connector **MUST** implement:

```ts
interface Connector {
  readonly accountId: string
  readonly capabilities: Set<Capability>      // 'groups' | 'group_mutations' | 'reactions' | 'polls' | 'templates' | 'presence' | 'history_request' | ...
  start(): Promise<void>                       // idempotent
  stop(): Promise<void>
  // The system registers exactly one handler. The connector MUST call it for every raw
  // event and MUST await it before processing the next event from the same chat.
  // Web protocol caveat: the library acks to WhatsApp before this handler runs (see §7.2).
  onEvent(handler: (e: RawEvent) => Promise<void>): void
  // messageId is pre-generated by the executor and is the WhatsApp message id used on the wire.
  send(cmd: SendCommand & { messageId: string }): Promise<SendResult>
  // Best-effort. Results arrive later as events with is_backfill = true. Returns a request handle.
  requestHistory(chatId: string, before: Cursor, limit: number): Promise<HistoryRequestHandle>
  // Used by the reconciliation job.
  listChatsSnapshot(): Promise<Array<{ chatId: string; lastMessageId?: string; lastMessageAt?: string }>>
  health(): ConnectorHealth                    // state, lastEventAt, lastErrorKind, decryptFailures, libraryVersion
}
```

`SendResult` is `{ outcome: 'accepted' | 'rejected', frameWritten: boolean, error?: ConnectorError }`. `frameWritten: false` is the only condition under which the executor may retry (§7.3).

The rule engine and MCP server **MUST** check `capabilities` before accepting a rule action or tool call.

---

## 7. Functional requirements

Each requirement lists acceptance criteria (AC). A requirement is done when all its ACs have an automated test or a documented manual check in the release checklist (§14.5).

### 7.1 Account and operator setup

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-A1 | `wamcp init` is the first-run flow: timezone, business hours, operator numbers, operator channels, account persona text, LLM provider key, master key setup, ToS acknowledgement for Web accounts. It installs three **disabled** starter rules: `urgent-notify`, `away-ack`, `group-daily-digest` | AC: on a fresh host, `wamcp init` followed by `wamcp accounts pair` yields a connected account with no file edited by hand; `wamcp rules ls` shows three disabled rules |
| FR-A2 | Add an account by type. Web accounts pair via QR or pairing code shown in the terminal or returned by `pair_account`. Cloud API accounts are configured from the secrets store | AC: the account appears in `list_accounts` with `status: connected` within 60 s of scanning |
| FR-A3 | Session persistence. Web sessions **MUST** survive process restart without re-pairing. The Signal session state (ratchets, pre-keys, sender keys) **MUST** be stored in the account database and **MUST** commit in the same transaction as the event it was updated by | AC (chaos): kill -9 between decrypt and key save; after restart the next 10 inbound messages decrypt; `decrypt_failures` stays 0 |
| FR-A4 | Auto-reconnect with exponential backoff (1 s → 20 s cap, jitter ±20 %), reset on a host network-change signal. `logged_out` **MUST NOT** auto-retry; it emits `connection.state{logged_out}` and an operator alert | AC: drop network for 2 min; connected within 30 s of restoration |
| FR-A5 | Per-account isolation: own database file, session store, media directory, rate buckets, LLM budget, worker-pool quota, backup set | AC: a token scoped to account A receives `FORBIDDEN` for any call naming account B; a restore of account A leaves account B's session intact |
| FR-A6 | Account kill switch: `pause_account` stops all gated actions while monitoring continues | AC: an event received ≤ 100 ms after `pause_account` returns is audited `suppressed_by_state` |
| FR-A7 | `get_account_status` exposes: connection state, library version, last event at, last inbound at, decrypt failures, pending approvals, `unknown` actions, rate-limit budgets and `throttled{until, reason}` overlay, LLM spend today vs budget, phone last seen (Web), open 24 h windows (Cloud API), backup age, disk headroom | AC: every field present with a timestamp |
| FR-A8 | **Operator channel** config: `operator.numbers` (phone numbers whose DM with the automation number is the command and notification channel), `operator.channels` (`email`, `webhook`, `slack`), per-channel rate limit and digest settings. At least one non-WhatsApp channel is required when any Web account exists (D11) | AC: `wamcp alerts test` delivers a test message on every configured channel and reports latency; `wamcp doctor` fails if the D11 condition is unmet |
| FR-A9 | **Account persona and business hours** are account settings (`persona`, `business_hours`, `timezone` as an IANA zone) editable via `set_policy` and `wamcp accounts set` | AC: `time_window: business_hours` in a rule resolves against these settings |

### 7.2 Real-time monitoring and event semantics

**Event envelope.**

```ts
interface Event {
  id: string               // ULID, public id
  cursor: number           // database rowid; global monotonic insertion order; the catch-up cursor
  account_id: string
  type: EventType
  occurred_at: string      // provider timestamp, ISO-8601 UTC
  received_at: string      // system timestamp
  provider_id?: string     // WhatsApp message id or webhook id
  discriminator?: string   // see FR-M2
  chat_id?: string
  sender_id?: string       // canonical contact id (FR-M11)
  seq?: number             // monotonic per (account_id, chat_id), assigned at insert
  is_backfill: boolean     // FR-M4
  is_from_me: boolean
  origin?: 'self_system' | 'other_device'   // for from-me messages; see FR-M10
  payload: EventPayload
}
```

**Event types.** `message.received`, `message.sent`, `message.edited`, `message.deleted`, `message.reaction`, `message.status`, `message.transcribed`, `chat.opened`, `chat.archived`, `chat.pinned`, `chat.muted`, `chat.unread_changed`, `group.created`, `group.participant_added`, `group.participant_removed`, `group.participant_promoted`, `group.participant_demoted`, `group.subject_changed`, `group.description_changed`, `group.settings_changed`, `group.left`, `contact.updated`, `identity.linked`, `presence.updated`, `call.incoming`, `call.missed`, `call.rejected`, `connection.state`, `connector.paused`, `connector.resumed`, `device.linked`, `reconciliation.gap`, `subscription.lagged`.

| ID | Requirement |
| --- | --- |
| FR-M1 | **Write-ahead.** An event **MUST** be committed to the account database before any rule or subscriber sees it. Durability is against **process crash** (`synchronous=NORMAL`, WAL); power-loss durability is a config option (`synchronous=FULL`) off by default. Presence and typing events are exempt (FR-M8). **Web connector caveat (D14):** the library acknowledges to WhatsApp before handing the event to the system. The system **MUST** persist in the first awaited step of the handler, **MUST** measure the ack-to-persist window, and **MUST** report it as `wamcp_ack_to_persist_seconds`. P0b includes an investigation into journaling the raw node before decryption inside the library's receive path |
| FR-M2 | **Dedup.** Key is `(account_id, chat_id, provider_id, type, discriminator)`. Discriminator is `recipient:status` for `message.status`, `edit:<n>` for edits, `reactor:<emoji>` for reactions, empty otherwise. Duplicates are rejected **before** `seq` assignment and never consume a `seq`. Events without a provider id are not deduplicated |
| FR-M3 | **Ordering.** `seq` is insertion order within the single-writer transaction. Rules and subscribers receive events for one chat in `seq` order. There is **no** reordering window; out-of-order arrival is stored as-is and `occurred_at` is available to consumers |
| FR-M4 | **Backfill.** `is_backfill = true` when the event came from pairing-time history sync, from an explicit `requestHistory`, **or** when `received_at - occurred_at > backfill_age_threshold` (default 5 min). Pairing-time history sync is bounded by `history_days` (default 30), flagged backfill, and never evaluated by LLM conditions. Rules default to `ignore_backfill: true`. A backfill event can never trigger a `counterparty_send` or `side_effecting` action unless the rule sets both `ignore_backfill: false` and `allow_backfill_sends: true`. On the Web protocol, server-queued offline messages after a short outage arrive as ordinary events and are classified by the age rule only; there is no gap-fetch |
| FR-M5 | **Latency.** p95 arrival → persisted ≤ 500 ms; p95 persisted → rule decision and subscriber notification ≤ 2 s excluding LLM time. A second metric, `wamcp_event_latency_seconds{stage="decided_incl_llm"}`, includes LLM time. LLM lookups for the pending per-chat batch are issued concurrently (bounded by §12); deterministic evaluation stays in `seq` order |
| FR-M6 | **Media.** Downloaded lazily by default. Stored under `data/<account>/media/<yyyy>/<mm>/<ulid>.<ext>` with the extension derived from the **sniffed** MIME type. Executable, script, HTML, and SVG types are rejected. Image metadata (EXIF, GPS) is stripped on download. Size cap per §12 |
| FR-M7 | **Queueing.** The store is the buffer. A bounded post-persist queue (§12) sits between store and rule engine; when it is full, evaluation lags but nothing is lost. There is no backpressure to the Web connector |
| FR-M8 | **Ephemeral signals.** Presence and typing events go to subscribers but are not persisted unless `persist_presence: true` |
| FR-M9 | **Subscriptions.** Filters: account, chat ids, group ids, event types, `include_from_me`, `include_backfill`. A slow subscriber gets a bounded queue; on overflow the oldest are dropped for that subscriber and `subscription.lagged{dropped, resume_cursor}` is sent. Rule evaluation is never affected |
| FR-M10 | **Origin.** For from-me messages, `origin = self_system` when the provider id matches a pre-generated id in `actions`, else `other_device`. The system **cannot** distinguish the phone from another linked device |
| FR-M11 | **Identity resolution.** The Web protocol identifies people by phone JID and by LID. An `identities` table maps every observed JID/LID to one canonical `contact_id`; `identity.linked` is emitted when a mapping is learned. All scopes, allow/deny lists, and the first-contact rule key on `contact_id`. Display names and push names are never usable in scope or conditions |
| FR-M12 | **Catch-up.** `get_events(account, after_cursor, limit)` reads the gap by rowid. Each token has a stored `last_seen_cursor` so an agent can ask "what happened since I last looked" |
| FR-M13 | **Reconciliation.** A daily job compares `listChatsSnapshot()` with the store and emits `reconciliation.gap` events; gaps are an alert |
| FR-M14 | **Voice transcription** (P2). Opt-in per chat or label; emits `message.transcribed`; counts against the LLM budget |

Acceptance criteria for this section are the chaos cases in §14.3 plus: a "delivered then read" status fixture stores both events; a 1 000-message `get_events` paginate by cursor has no gaps or duplicates; a 10-message burst in one chat with an LLM rule completes within 2 × the single-call LLM latency.

### 7.3 Actions

One canonical table. The action name is the rule action name **and** the MCP tool name. **Class** decides the approval default and which gate checks apply:

- `observe`: never leaves the account's own data except to the operator channel; runs even when a chat is paused.
- `counterparty_send`: visible to the counterparty or a third party on WhatsApp.
- `side_effecting`: changes something outside WhatsApp or changes group membership.

| Action / tool | Class | Rule | Tool | Capability | Notes |
| --- | --- | --- | --- | --- | --- |
| `send_message` | counterparty_send | ✓ | ✓ | all | text; reply-to, mentions, link preview |
| `send_media` | counterparty_send | ✓ | ✓ | all | image, video, audio, document, sticker, caption |
| `send_location`, `send_contact` | counterparty_send | ✓ | ✓ | all | |
| `send_template` | counterparty_send | ✓ | ✓ | cloud | required outside the 24 h window |
| `send_interactive` | counterparty_send | ✓ | ✓ | cloud | no Web fallback until P3 |
| `react_to_message` | counterparty_send | ✓ | ✓ | web, cloud | |
| `forward_message` | counterparty_send | ✓ | ✓ | web | |
| `edit_message` | counterparty_send | ✓ | ✓ | web | |
| `delete_message` | counterparty_send | ✓ | ✓ | web | destructive: `confirm: true` |
| `mark_read` | observe | ✓ | ✓ | web | |
| `set_typing` | observe | rule-only | | web | used by `typing_delay` |
| `set_label`, `remove_label` | observe | ✓ | ✓ | all | |
| `archive_chat`, `pin_chat`, `mute_chat` | observe | ✓ | ✓ | web | `mute_chat` is the WhatsApp notification mute only |
| `set_chat_automation` | observe (pause) / admin (resume) | ✓ | ✓ | all | see §7.7 scopes |
| `escalate` | observe | ✓ | ✓ | all | sets `escalated`, labels `needs-attention`, notifies operator |
| `notify_operator` | observe | ✓ | ✓ | all | operator channel only; bypasses gate checks 3–9; own rate limit and digest |
| `notify` | side_effecting | ✓ | ✓ | all | registered external target or a WhatsApp chat **other than** the operator |
| `call_tool` | side_effecting | ✓ | ✓ | all | registered MCP server or webhook; per-target data policy (§10.6) |
| `remember_fact`, `forget_fact` | observe, but see FR-R10 | ✓ | ✓ | all | upsert on `(subject, key)`, optional TTL |
| `schedule` | inherits the class of the scheduled action | rule-only | | all | |
| `create_group`, `update_group`, `add_participants`, `set_admin`, `get_invite_link` | side_effecting | ✓ | ✓ | web + `group_mutations` flag | P4 |
| `remove_participants`, `leave_group` | side_effecting | ✓ | ✓ | web + flag | P4, destructive |
| `send_poll` | counterparty_send | ✓ | ✓ | web + flag | P4 |

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-X1 | **Idempotency and pre-generated ids.** Every send action has an `idempotency_key` (rule: `rule:<rule_id>:<event_id>:<index>`; tools: caller-supplied or server-generated; cron and manual triggers mint a synthetic event id per firing). Before calling the connector the executor pre-generates the WhatsApp `messageId`, persists the action as `executing` with that id, then calls `send({ messageId })`. A repeated key within 24 h returns the stored result, including `unknown` with its `messageId`. Unique index is `(idempotency_key, created_day)` | AC: two `send_message` calls with one key → one message on the phone, identical results |
| FR-X2 | **Retry and unknown.** Retry only when `frameWritten: false`, max 3, backoff 5 s / 30 s / 2 min. Any other failure or timeout → `unknown`. `unknown` is **auto-resolved to `sent`** when a from-me event with the pre-generated id is observed, and to `failed` if none appears within `unknown_resolve_window` (default 15 min) and the connector reports the id as not found. Remaining `unknown` actions are listed by `list_actions(state: unknown)` and resolved by `resolve_action(id, outcome: sent | failed)` or `wamcp actions resolve` | AC (chaos): kill inside `send`; after restart the action is `sent` or `unknown`, never duplicated; an `unknown` whose message did reach the phone auto-resolves within 15 min |
| FR-X3 | `notify` to a non-operator WhatsApp chat is a `counterparty_send` with the recipient as counterparty; `notify_operator` is the only ungated WhatsApp send | AC: audit shows the gate decision for both |
| FR-X4 | `schedule` persists the pending action; it fires after restart; `no_reply_within` is cancelled by an inbound counterparty message; a scheduled action is bound to `(event_id, body_hash)` and is cancelled if the triggering message is edited or deleted | AC: schedule 5 min, restart at 2 min, fires at 5 min; edit the trigger at 3 min, nothing fires |

### 7.4 Reading and understanding

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-U1 | `get_messages(account, chat, limit ≤ 200, before_cursor, after_cursor, include_media)` returns messages with quoted context, sender metadata, `origin`, and a cursor | AC: 1 000-message paginate has no gaps or duplicates |
| FR-U2 | `get_thread(message_id, depth ≤ 20)` walks the quote chain | AC: chronological order |
| FR-U3 | `search_messages(query, scope, limit ≤ 100)` full-text (FTS5 inside the encrypted database) across the chats the token may see | AC: < 300 ms p95 on a 10 k-message store |
| FR-U4 | `understand(message_id or chat_id)` returns the schema below. Intent values come from the account's **intent taxonomy** (config, extensible; `list_intents` exposes it). Output is schema-validated; a malformed response is retried once, then `UNDERSTAND_FAILED`, and LLM conditions evaluate as **not matched** | AC: fuzzed model outputs never crash evaluation; unknown intents in a rule are rejected at validation |
| FR-U5 | **Context assembly**, in order, within the token budget: persona; chat summary; facts about contact and chat; group description; last N messages; quoted thread; current time and business-hours state. Every message-derived or model-derived item (message bodies, names, group descriptions, facts, summaries) is rendered as **quoted untrusted data with provenance** (`source`, `author`, `at`), never as instructions. `context_used` reports what was included and whether it was truncated | AC: prompt snapshot test |
| FR-U6 | Provider-pluggable; model ids in config | AC: switching model needs no code change |
| FR-U7 | Results cached per `(message_id, prompt_version)` | AC: second call does not hit the provider |
| FR-U8 | `draft_reply(chat_id, instructions?)` returns a suggestion; never sends | AC: no action row created |
| FR-U9 | **Prompt-injection resistance.** The understanding output can only select from the taxonomy plus free text that is itself treated as untrusted; it **cannot** name an action. `suggested_action` is advisory and ignored by the engine | AC: red-team suite §14.4 |
| FR-U10 | **LLM opt-out** (`llm: false` on chat, contact, label, or account): the server never sends that content to a provider; `understand`, `summarize_chat`, `draft_reply`, `transcribe_media` return `LLM_DISABLED`; **read tools exclude opted-out content** unless the token holds `raw` scope, because the MCP client is itself an LLM. The PRD states that retention by the client is outside the system's control | AC: provider request log and tool results both show no opted-out content for a token without `raw` |
| FR-U11 | **LLM budgets.** Per account per day, per chat per day, and per sender per day (calls and tokens), with hard stop (`LLM_BUDGET_EXHAUSTED`, LLM conditions evaluate not matched) and operator alerts at 80 % and 100 %. Unknown senders (no prior DM) get no LLM evaluation unless a rule opts in with `llm_for_unknown_senders: true`. Edits are charged to the original message's budget line | AC: budget test with a flood fixture |

`understand` output schema:

```json
{
  "intent": "refund_request",
  "intent_confidence": 0.91,
  "sentiment": "negative",
  "urgency": "high",
  "language": "hi-en",
  "entities": { "order_id": "A-1042", "amount": "₹2,300" },
  "summary": "Customer asked about a refund twice before; now threatening to escalate.",
  "open_questions": ["Which payment method was used?"],
  "suggested_action": "escalate",
  "context_used": { "messages": 18, "contact_facts": 2, "group_summary": false, "truncated": false },
  "model": "configured-fast-model-id",
  "prompt_version": "3"
}
```

### 7.5 Rules and control levels

#### Scopes

| Level | Scope key | Weight | Example |
| --- | --- | --- | --- |
| 1 | `global` (empty `scope`) | 0 | Quiet hours for every account |
| 2 | `account` | 10 | Auto-acknowledge new customers on the business account |
| 3 | `phone_number` (Cloud API) | 15 | Route support vs sales numbers |
| 4 | `chat_type` (`dm`, `group`, `community`, `broadcast`, `channel`, `status`) | 20 | Never auto-reply in groups |
| 5 | `label` | 30 | VIP customers, Family, Suppliers |
| 6 | `group` (specific) | 40 | Daily summary of the Ops group |
| 7 | `chat` (specific DM) | 40 | Notify only, never reply, in this chat |
| 8 | `contact` (canonical id, across chats) | 50 | Anything from my landlord is urgent |
| 9 | `participant_in_group` | 60 | Only react to the admin in this group |
| 10 | `message_type` | +5 | Transcribe voice notes from clients |
| 11 | `time_window` | +5 | After-hours behaviour |
| 12 | `thread` | 70 | Pause automation on one escalated thread |

A rule's specificity is the sum of its scope weights. Scopes compose with AND. A rule with an empty `scope` is global and matches every event on every account; global rules are owned by the operator and stored in the operator database (`data/_operator/`).

#### Evaluation (normative, three phases)

For each event, in `seq` order per chat:

1. **Plan (pure).** Select enabled, non-suspended rules whose scope matches the event. Sort by specificity desc, `priority` desc, rule id asc. Collect the union of `deny` lists from every scope-matched rule; **denies apply on scope match, not condition match**. Short-circuit when the chat is `paused` or `escalated`, the account is paused or throttled to `approve`, or the global kill switch is on: `counterparty_send` and `side_effecting` actions are suppressed (`suppressed_by_state`); `observe` actions still run.
2. **Fetch (side-effecting, read-only).** Build an `EvalContext` snapshot: rate-bucket levels and counters for the candidate rules, last human reply time in the chat, facts, labels, identity, business-hours state in the account's IANA zone, a seeded RNG (`seed = event.id`), and LLM results keyed by `(rule_id, predicate_hash)`, issuing the needed `understand` and `llm_condition` calls concurrently within the budget. Budget exhaustion yields `not_matched` with reason `llm_budget_exhausted`.
3. **Evaluate (pure).** Walk the sorted rules. Cheap conditions first; LLM-derived conditions last. On match, emit the rule's actions minus denied kinds as **planned actions**, then honour `on_match` (`stop` or `continue`; default `stop` if any `counterparty_send`, else `continue`). Output: a match trace per rule considered, the planned actions, and **state deltas** (counter increments, sampling draws). The caller applies deltas and hands planned actions to the policy gate; limiter consumption happens at gate execution, not here (§7.6).

The function `evaluate(event, rules, EvalContext)` is pure; `test_rule` and `explain_event` call it with a pinned context, and trace equality excludes timing fields. Any exception marks the rule `error`, increments its counter, and after 5 consecutive errors sets `suspended{reason, at}`, a flag that survives rule imports and is cleared only by `enable_rule` or `wamcp rules enable`.

#### Rule definition

```yaml
id: refund-triage
enabled: true
scope:
  account: business
  chat_type: dm
when:                                  # trigger + all conditions in one block
  event: message.received
  from_me: false
  ignore_backfill: true
  any_of:
    - keywords: ["refund", "money back", "chargeback"]
    - understand: { intent: [refund_request, complaint], min_confidence: 0.8 }
  time_window: business_hours
  skip_if_human_replied_within: 2m
never: [send_media, forward_message]   # sugar for deny
actions:
  - set_label: needs-attention
  - send_message:
      text: "Hi {{contact.display_name}}, sorry about that. I've flagged this and will reply within {{account.sla_reply_minutes}} minutes."
      typing_delay: natural
      rate_limit: { per_chat: "1/10m" }
  - remember_fact: { key: last_refund_request_at, value: "{{event.occurred_at}}", ttl: 90d }
  - notify_operator:
      text: "⚠️ Refund request from {{contact.display_name}}: {{understand.summary}}"
on_match: stop
policy:
  approval: approve
  max_sends_per_day: 50
```

**Template variable namespace** (published in `docs/templates.md`, enforced at validation): `event.*`, `message.*`, `contact.{id, display_name, phone (requires expose_phone: true)}`, `chat.*`, `group.*`, `understand.*`, `facts.*`, `account.{name, timezone, persona, sla_reply_minutes, ...custom}`, `now.*`. Unknown variables are a validation error, not an empty render.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-R1 | Triggers: every event type, `schedule.cron` (account timezone), `schedule.no_reply_within`, `manual` | AC: one fixture per trigger |
| FR-R2 | Conditions: sender / contact / group by canonical id, allow / deny lists, keywords, regex (RE2 via the `re2` package; pattern ≤ 512 chars, input ≤ 64 KB; no timeout needed), message type, media presence, mention of me, reply to me, quoted-message filters, language, `understand` fields with confidence, facts, time windows in the account's IANA zone with defined DST gap and overlap behaviour, counters, sampling, `llm_condition` | AC: a known-pathological PCRE pattern completes in < 10 ms on 64 KB; DST transition fixtures (gap, repeated hour, window crossing transition) |
| FR-R3 | Templating is logic-less (Mustache), no code or I/O, escaping per destination channel (plain for WhatsApp, Markdown-escaped for Slack, JSON-escaped for webhooks), name fields capped at 64 chars, rendered length ≤ 4 096 | AC: injection fixtures render inert on every channel |
| FR-R4 | Validation on save: schema; scope keys vs capabilities; action kinds; ≤ 10 actions; `call_tool` targets registered and tools allowed; templates parse and reference only known variables; regexes compile; intents in taxonomy; `llm_condition` on a rule with `counterparty_send` or `side_effecting` actions requires `approval: approve`; `call_tool` rules require at least one deterministic sender or allow-list condition | AC: negative test per check |
| FR-R5 | `test_rule(rule, event or message_id, context_overrides?)` returns the trace from a pinned context | AC: trace equals the live audit trace with clock, counters, and LLM results pinned |
| FR-R6 | The **database is authoritative**. Every change creates a `rule_versions` row (actor, diff, time); `rollback_rule(id, version)`. The rules directory is an **import source** (`wamcp rules import [--watch]`) that creates versions; a directory with any invalid file imports nothing | AC: rollback restores byte-identical YAML; file and MCP edits to one rule id produce two versions, not a silent overwrite |
| FR-R7 | Imported rules land `enabled: false` and `approval: approve` | AC |
| FR-R8 | New or edited rules with `counterparty_send` or `side_effecting` actions default to `approval: approve` (D4) | AC |
| FR-R9 | `explain_event(event_id, rule_id?)` returns the full trace including scope-skipped rules, state at the time, and LLM cache hits | AC: answers "why didn't rule X fire for message Y" without log access |
| FR-R10 | `remember_fact` whose value is templated from message- or model-derived fields (`message.*`, `understand.*`, `contact.display_name`) is classed `side_effecting` for approval purposes; facts carry `source` and are rendered as untrusted in prompts (FR-U5) | AC: red-team fact-poisoning case |
| FR-R11 | Audit volume: full traces stored for `matched`, `blocked`, `suppressed_by_state`, and `error`; `not_matched` summarised per event | AC: sizing fixture in §12 |

### 7.6 Policy gate

Runs for every planned or tool-initiated action of class `counterparty_send` or `side_effecting`. `observe` actions skip checks 3–9. `notify_operator` skips checks 3–9 and uses the operator channel's own limiter and digest. The first failing check decides; all checks are recorded.

0. **Sender block list**: inbound events from a `block_sender` contact are dropped before rules and LLM (evaluated in the plan phase; recorded here for completeness).
1. **Kill switches**: global, account, chat.
2. **Capability**.
3. **Deny lists**: recipient on the account deny list; action kind denied by scope-matched rules.
4. **First-contact rule**: the recipient has never sent this account a **DM** → blocked unless on `allow_initiate`. Group posts do not count. Operator numbers are implicitly allowed.
5. **Loop protection**: block if the inbound was `origin: self_system` or carries a bot marker; block if the last `max_consecutive_automated` (default 3) messages in the chat were automated regardless of interleaving by the same counterparty; block identical outbound text to the same chat within 10 min.
6. **Quiet hours / business hours** in the account zone, unless the action sets `override_quiet_hours: true` and the rule's scope sets `contact`, `chat`, `participant_in_group`, or `thread`.
7. **Rate limits**: fixed-window counters for per-day limits; token buckets for per-interval limits; per chat, per contact (daily cap, default 10), per rule, per account, global; per-chat reservations inside the account bucket so one contact cannot drain it. Web defaults: 1 send / 30 s / chat, 20 sends / h / account, 150 sends / day / account. Consumption happens **once, here, at execution**; `blocked` and `expired` refund. Buckets and counters are persisted per account.
8. **Content guard** (P2, optional): `block` or `flag` (no rewrite).
9. **Approval mode**: `auto` executes; `approve` queues (§8.4) and notifies the operator; `dry_run` records `would_send`.
10. **Execute**, with `typing_delay: natural` = 1–8 s scaled by text length for Web sends.

Additional rule: a rule-initiated `forward_message`, `send_*`, or `notify` whose recipient is not the inbound sender **and** whose template includes message-derived variables is forced to `approve` regardless of the rule's `policy`, and the destination must be on the rule's `destinations` allowlist.

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-P1 | Every gate decision is one audit row naming the failing check | AC |
| FR-P2 | Limiters survive restart | AC: restart does not reset `sends_today` |
| FR-P3 | Approvals expire (`approval_ttl`, default 4 h, per-rule override) and record `expired`; `wamcp approvals resubmit <code>` re-runs the gate with a fresh key; an "approvals expired in last 24 h > N" alert exists | AC: expired actions never execute later |
| FR-P4 | **Self-commands** are accepted only in the DM between an `operator.numbers` phone and the automation number (or the automation number's self-chat), only on messages that are not forwarded, edited, or quoted, and only when `origin: other_device`. Commands: `!p` (list pending with previews), `!a <code>`, `!r <code>`, `!e <code> <new text>` (edit then approve), `!pause [chat] [duration]`, `!resume [chat]`, `!status`. Chats are addressed by phone number or unique display-name prefix. Three wrong codes in 10 min lock WhatsApp-side approvals for 1 h and alert | AC: a non-operator sending `!pause` has no effect; a forwarded `!a` has no effect |
| FR-P5 | **Approval codes** are random 6-character base32 (≈30 bits), single-use, bound to the action, expire with the approval. The notification carries code, recipient, inbound excerpt, rendered text, and rule id | AC: brute-force fixture hits the lock |
| FR-P6 | **Separation of duties.** An action can never be approved by the token or actor that created it. `approve_action` requires the `approver` scope, which is never granted to stdio or `rules` tokens by default. Approvals via CLI and self-command are recorded with the human principal | AC: a `send` token's own `APPROVAL_PENDING` cannot be cleared by that token |
| FR-P7 | Approvals are bound to `(event_id, body_hash)` of the triggering message and cancelled on edit or delete | AC |
| FR-P8 | Kill switches reachable from MCP, CLI, and self-command | AC: FR-A6 timing |

### 7.7 MCP surface

**Transports**: `stdio` proxy (`wamcp mcp --stdio`, reads a local token file written by `wamcp serve` with mode 0600) and Streamable HTTP with bearer tokens. HTTP binds to loopback by default; `Origin` and `Host` are validated; non-loopback binding requires TLS or a reverse proxy. The metrics endpoint is separately bound and authenticated.

**Token scopes**: `read:messages`, `read:contacts`, `read:media`, `read:audit`, `read:rules`, `raw` (see FR-U10), `send`, `llm` (LLM-invoking tools, with a per-token budget), `rules`, `approver`, `admin`. Each token names its accounts and may carry a chat or label allowlist. The stdio proxy's token defaults to `read:*`, `send`, `llm`, `rules`. Tokens have a default TTL (90 days), `last_used_at`, audited create / revoke / rotate, and are managed by `wamcp tokens create|ls|revoke|rotate`.

| Group | Tools | Min scope |
| --- | --- | --- |
| Accounts | `list_accounts`, `get_account_status` | any read |
| Accounts | `pair_account`, `pause_account`, `resume_account`, `unthrottle_account` | admin |
| Chats | `list_chats(filter: unread | needs_attention | awaiting_reply | label, since_cursor)`, `get_chat` | read:messages |
| Chats | `archive_chat`, `pin_chat`, `mute_chat`, `set_chat_automation(paused)` | send |
| Chats | `set_chat_automation(active)` (un-pause, clear escalated) | admin |
| Messages | `get_messages`, `get_thread`, `search_messages`, `get_events` | read:messages |
| Messages | `download_media` (returns `{untrusted: true, mime, bytes}`) | read:media |
| Messages | `send_message`, `send_media`, `send_location`, `send_contact`, `send_template`, `send_interactive`, `react_to_message`, `forward_message`, `edit_message`, `mark_read` | send |
| Messages | `delete_message` | send + `confirm: true` |
| Groups | `list_groups`, `get_group`, `get_group_participants` | read:contacts |
| Groups | `get_invite_link`, `create_group`, `update_group`, `add_participants`, `set_admin` | send (P4, flag) |
| Groups | `remove_participants`, `leave_group` | send + `confirm: true` (P4, flag) |
| Contacts | `list_contacts`, `search_contacts(query)`, `get_contact`, `get_facts`, `list_labels` | read:contacts |
| Contacts | `remember_fact`, `forget_fact`, `set_label`, `remove_label` | send |
| Understanding | `understand`, `summarize_chat`, `draft_reply`, `transcribe_media`, `list_intents` | llm |
| Rules | `list_rules`, `get_rule`, `test_rule`, `explain_event`, `export_rules` | read:rules |
| Rules | `create_rule`, `update_rule`, `delete_rule` (`confirm`), `rollback_rule`, `import_rules`, `enable_rule` (also clears `suspended`) | rules; re-enabling a suspended rule: admin |
| Policy | `get_policy`, `list_pending_approvals`, `list_actions(state?)` | read:audit |
| Policy | `approve_action`, `reject_action` | approver |
| Policy | `set_policy`, `resolve_action` | admin |
| Monitoring | `subscribe_events`, `unsubscribe_events`, `get_audit_log(event_id?, rule_id?, chat_id?, since, until)`, `get_metrics` | read:audit |

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-C1 | Every tool has a JSON schema with bounded lengths and list sizes; unknown fields rejected | AC: a property-based fuzzer generating 1 000 invalid inputs per tool receives `VALIDATION_ERROR` for all and never a 500 |
| FR-C2 | Destructive tools require `confirm: true` and carry `destructiveHint` | AC: `CONFIRMATION_REQUIRED` without it |
| FR-C3 | Results capped (§12) with `truncated` and a cursor | AC |
| FR-C4 | Per-token tool-call limit (60 / min) and per-token LLM budget; send tools share the account bucket | AC: `RATE_LIMITED{retry_after_ms}` |
| FR-C5 | Typed errors: `FORBIDDEN`, `NOT_FOUND`, `CAPABILITY_UNSUPPORTED`, `RATE_LIMITED`, `POLICY_BLOCKED{check}`, `APPROVAL_PENDING{approval_id}`, `CONFIRMATION_REQUIRED`, `VALIDATION_ERROR{path}`, `CONNECTOR_UNAVAILABLE`, `UNDERSTAND_FAILED`, `LLM_DISABLED`, `LLM_BUDGET_EXHAUSTED` | AC: one test per code per tool group that can raise it |
| FR-C6 | Resources `whatsapp://{account}/chats`, `.../chats/{id}`, `.../groups/{id}`, `.../contacts/{id}`, `.../rules`, `.../rules/{id}`, `.../pending-approvals`; chat resources subscribable | AC |
| FR-C7 | Prompts: `triage_inbox`, `reply_in_my_voice`, `write_rule` (returns YAML for review; never saved automatically) | AC: `write_rule` output passes FR-R4 validation and, run through `test_rule` against the example message the prompt was given, matches |
| FR-C8 | Two stdio clients attach to one server concurrently through the proxy | AC |

### 7.8 Operator interfaces

**CLI** (authoritative inventory; every command referenced elsewhere appears here):

`wamcp init` · `wamcp serve` · `wamcp status` · `wamcp doctor` · `wamcp tail [--account --chat --type]` · `wamcp accounts add|ls|pair|pause|resume|unthrottle|set` · `wamcp rules ls|add|test|explain|enable|disable|export|import [--watch]|rollback` · `wamcp approvals ls [--rule --chat]|approve|reject|resubmit|approve-all --rule` · `wamcp actions ls [--state]|resolve|retry` · `wamcp audit [--event --rule --chat --since]` · `wamcp alerts test` · `wamcp tokens create|ls|revoke|rotate` · `wamcp secrets rotate` · `wamcp backup [--account]` · `wamcp restore --db-only|--full <file>` · `wamcp migrate --dry-run|--apply` · `wamcp data export|purge --chat|--contact|--account`.

**Self-commands** over WhatsApp (FR-P4).

**Admin web UI** (P4): localhost only or behind the operator's own auth.

---

## 8. State machines

### 8.1 Connection (per account)

```
disconnected ──start()──▶ connecting ──auth ok──▶ connected
     ▲                        │ └──qr needed──▶ pairing ──scanned──▶ connected
     │                   auth fail
     │                        ▼
     │                   logged_out ◀── logout from phone
     └────────stop()──────────┘
connected ──socket drop──▶ reconnecting ──backoff (cap 20 s)──▶ connecting
connected ──conflict (another session took over)──▶ conflict_wait ──30 s, one retry──▶ connecting
conflict_wait ──retry fails──▶ logged_out
reconnecting ──24 h without success──▶ degraded (alert, retry hourly)
connected ──no inbound for stale_threshold while phone last seen recently──▶ stale (alert; stays connected)
```

`logged_out`, `degraded`, and `stale` are operator alerts. `/readyz` returns 503 for `logged_out` and `degraded`.

### 8.2 Chat automation state

```
active ──escalate──▶ escalated ──operator clears (admin) / auto-clear after N days (default 7)──▶ active
active ──pause(duration?)──▶ paused ──resume (admin) / paused_until elapsed──▶ active
```

Leaving `escalated` removes the `needs-attention` label.

### 8.3 Action lifecycle

```
planned ──gate──▶ blocked{check} | dry_run                       (terminal)
planned ──gate──▶ awaiting_approval ──approve──▶ approved
                                   ──reject | expire | trigger edited──▶ rejected | expired | cancelled
planned ──gate(auto)──▶ approved
approved ──executor──▶ executing{messageId} ──accepted──▶ sent
                                           ──frameWritten:false──▶ retry_wait ──▶ executing (max 3)
                                           ──rejected──▶ failed (notified)
                                           ──timeout | crash──▶ unknown ──id observed──▶ sent
                                                                       ──window elapsed, id not found──▶ failed
                                                                       ──operator resolve──▶ sent | failed
```

Approval state is derived from `actions.state`; there is one source of truth.

### 8.4 Approval

An approval holds the rendered action, trace, preview, code, `expires_at`, and `(event_id, body_hash)`. Approving re-runs the gate before execution. Approvers: CLI, self-command, UI, or an `approver` token that is not the creating token.

---

## 9. Architecture

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                     MCP clients                          │
                 └───────────────▲──────────────────────────▲───────────────┘
                                 │ stdio proxy / HTTP+token  │ notifications
┌────────────────────────────────┴──────────────────────────┴────────────────┐
│  MCP server: tools · resources · prompts · subscriptions · scopes          │
├────────────────────────────────────────────────────────────────────────────┤
│  Operator channel (alerts, approvals; bypasses gate; own limiter/digest)   │
├────────────────┬────────────────┬─────────────────┬────────────────────────┤
│  Policy gate   │  Rule engine   │  Understanding  │  Action executor       │
│  10 checks     │  plan/fetch/   │  context, LLM,  │  persistent queue,     │
│                │  evaluate      │  budgets, cache │  pre-generated ids     │
├────────────────┴────────────────┴─────────────────┴────────────────────────┤
│  Post-persist queue (bounded) · per-chat seq order · worker pools / account│
├──────────────────────────────┬─────────────────────────────────────────────┤
│  WebConnector (Baileys)      │  CloudApiConnector (P3)                     │
├──────────────────────────────┴─────────────────────────────────────────────┤
│  data/_operator/ (global rules, tokens, operator config)                   │
│  PostgreSQL 16: schema acct_<id> per account (events, messages, session…)  │
│  data/<account>/media/  ·  backups/<account>/                              │
└────────────────────────────────────────────────────────────────────────────┘
```

**Process model.** One `wamcp serve` process under systemd (`Restart=on-failure`, `RestartSec=10`, `StartLimitBurst=5`) or Docker (`restart: on-failure`); the reference unit and compose file ship in P0a. In-process crash-loop detection: 5 starts in 10 minutes → alert, exit with a non-restartable status. Startup failures (corruption, migration failure, missing master key) emit an operator alert **before** exiting. Group commit: writes are batched within a 50 ms window. LLM calls and media downloads use per-account bounded pools.

**Data model (per-account database).**

| Table | Key columns | Invariants / indexes |
| --- | --- | --- |
| `events` | rowid (cursor), id (ULID), type, provider_id, discriminator, chat_id, seq, occurred_at, received_at, is_backfill, payload | append-only; unique `(chat_id, provider_id, type, discriminator)` where provider_id not null; unique `(chat_id, seq)` |
| `messages` | id, provider_id, chat_id, sender_id, event_id, type, body, media_id, quoted_provider_id, is_from_me, origin, occurred_at, deleted_at, body_hash | FTS5 on body; index `(chat_id, occurred_at)`; index `(chat_id, is_from_me, origin, occurred_at)` |
| `chats` | id, type, name, automation_state, paused_until, llm_enabled, last_seq | |
| `contacts` | id (canonical), display_name, phone (encrypted), llm_enabled | |
| `identities` | jid, contact_id, kind (phone | lid), first_seen | unique jid |
| `group_participants` | group_id, contact_id, role, joined_at, left_at | |
| `media` | id, mime, ext, size, sha256, path, downloaded_at, purge_after | |
| `facts` | subject_type, subject_id, key, value, source, created_at, expires_at | unique `(subject_type, subject_id, key)` |
| `summaries` | chat_id, up_to_seq, text, model, created_at | |
| `rules`, `rule_versions` | id, version, yaml, enabled, suspended_reason, suspended_at, error_count | |
| `actions` | id, idempotency_key, created_day, state, class, rule_id, event_id, body_hash, message_id, approval_code, expires_at, attempts, result | unique `(idempotency_key, created_day)`; unique message_id |
| `audit_log` | id, actor, kind, subject_id, decision, detail (references and hashes, not bodies), prev_hash, hash, created_at | append-only, hash-chained |
| `rate_buckets`, `counters` | key, value, window_start, updated_at | |
| `session_state` | key, value (Signal state) | updated in the event transaction |
| `llm_usage` | day, scope (account | chat:<id> | sender:<id>), calls, tokens_in, tokens_out | |

---

## 10. Security and threat model

### 10.1 Assets

Session keys (full account access), message content and media, contact identities, the master key, LLM provider key, MCP tokens, Cloud API tokens, the rule set, the audit log, backups.

### 10.2 Threats and controls

| Threat | Vector | Controls |
| --- | --- | --- |
| **Prompt injection (direct)** | Message, caption, name, group description, voice transcript carries instructions | FR-U5 provenance and quoting; FR-U9 enumerated output; actions only from rules and tools; `write_rule` never auto-saved |
| **Prompt injection (second-order)** | Attacker text persisted as a fact or folded into a summary and replayed | Facts and summaries carry `source` and render as untrusted; FR-R10 approval for message-derived facts; red-team cases |
| **Injection that fires a declared action** | A crafted message makes an LLM condition match and the rule's own `forward` or `call_tool` fires | FR-R4: `llm_condition` on send or side-effecting rules forces `approve`; `call_tool` rules need a deterministic sender condition; §14.4 false-positive criterion |
| **Publishing to third parties under the operator's identity** | Rule forwards or notifies a group with message-derived text | §7.6 additional rule: forced `approve` and per-rule destination allowlist; per-channel escaping |
| **Denial of wallet** | Flooding LLM-triggering rules or tools | FR-U11 budgets per account, chat, sender; no LLM for unknown senders by default; `llm` scope budgets |
| **Rate-limit exhaustion against real customers** | One contact drains the account bucket | Per-contact daily cap, per-chat reservations, `block_sender` at step 0 |
| **Compromised read token** | Full-account dump | Split read scopes; chat/label allowlists per token; `get_invite_link` is `send`; `raw` scope for opted-out content |
| **Approval bypass by the agent** | Agent approves its own action | FR-P6 separation of duties; `approver` scope; stdio token has no `approver` |
| **Self-command spoofing** | Another linked device, a stolen session, a forwarded command | FR-P4: operator-number DM only, non-forwarded, non-edited; random single-use codes; lockout; `device.linked` and `conflict` alerts |
| **Session key theft** | Database or disk read by another user or malware | Signal session state, tokens, provider keys, and phone numbers are encrypted in the application with AES-256-GCM under a master key read from `WAMCP_MASTER_KEY_FILE` (mode 0600, outside the data directory); Postgres is bound to loopback or the compose network with a generated password; disk-level encryption of the Postgres volume is the operator's responsibility and `wamcp doctor` warns when it cannot confirm it. Same-user malware with access to the running process is **out of scope** |
| **Backup exposure** | Backups contain sessions and bodies | Backups encrypted under the master key with the key id recorded; 0600; retention enforced; `data purge` regenerates affected backups; `doctor` warns if backups live on the data disk |
| **Webhook spoofing** (Cloud API) | Forged POST | HMAC `X-Hub-Signature-256`; verify token; body ≤ 1 MB; replay protection by dedup key, not by timestamp (Meta retries legitimately for hours) |
| **SSRF / exfiltration via targets** | Rule points at an internal URL or sends full context to a CRM | Targets registered by name (§10.6) with a `data_policy`; outbound allowlist; private ranges blocked by default; no redirects |
| **Argument injection into `call_tool`** | Tool arguments templated from `understand.entities` | Per-target `side_effecting` tools force `approve`; red-team case |
| **Template injection**, **regex DoS** | | FR-R3; FR-R2 length caps with RE2 |
| **Media-borne attacks** | Polyglot or document-embedded injection read by the client LLM | FR-M6 sniffed extension, denied types, metadata stripped; `download_media` returns `untrusted: true`; red-team case |
| **DNS rebinding on loopback** | Browser-originated requests to the local HTTP transport | `Origin` and `Host` validation; metrics endpoint authenticated |
| **Supply chain** | Compromised npm dependency runs with session keys | Lockfile with provenance verification and audit gate in CI; minimal dependencies; connector-in-separate-process is a P4 stretch |
| **ToS enforcement** | Spam-like patterns | Conservative defaults, first-contact rule, loop protection, typing simulation, dedicated number (D10), automatic throttle on spam signals (§11) |

### 10.3 Authentication and authorization

Bearer tokens, random 256-bit, stored hashed, with scopes, account lists, optional chat/label allowlists, TTL, `last_used_at`, and audited lifecycle. The stdio proxy reads a local token file written by `wamcp serve`. Cloud API uses a system-user token with minimum permissions. Audit rows record `actor` as the token id or human principal.

### 10.4 Data protection

- **At rest**: application-level AES-256-GCM for session state, tokens, provider keys, and phone numbers (tech-stack T6); message bodies are plaintext in Postgres so `tsvector` search works; media files encrypted with a per-account data key wrapped by the master key; `wamcp secrets rotate` re-wraps data keys and retained backups.
- **In transit**: TLS to WhatsApp, Meta, and the model provider; MCP HTTP requires TLS off loopback.
- **Retention**: per account; defaults messages and events 180 d, media 30 d, audit 365 d, facts per TTL, presence not stored. Daily purge, audited, cascades to FTS, facts, summaries, `understand` cache, and backups.
- **Deletion and export**: `wamcp data export` (JSON) and `wamcp data purge --chat|--contact|--account` with confirmation; purge cascades as above.
- **LLM boundary**: only assembled context leaves the host; phone numbers are replaced by stable pseudonyms unless the rule sets `expose_phone: true` (audited); opt-out per FR-U10. The PRD documents that `notify_operator` over WhatsApp lands in the operator's WhatsApp cloud backup; the default operator channel for summaries is a non-WhatsApp channel.
- **Audit integrity**: rows store references and content hashes, not bodies; hash-chained; optional external append-only sink.

### 10.5 Legal and policy

- The Web connector breaches WhatsApp's Terms of Service. `wamcp init` and `pair_account` **MUST** display this and require typed acknowledgement per account.
- The operator is responsible for consent and local law; the system provides retention, opt-out, export, and purge controls.
- Cloud API usage follows Meta's messaging policies; template and window logic enforce the technical parts.
- WhatsApp two-step verification on the automation number is recommended in the pairing flow.

### 10.6 Registered outbound targets

```yaml
targets:
  crm-webhook:
    kind: http
    url: https://crm.example.com/hooks/whatsapp
    auth: { header: Authorization, secret_ref: CRM_TOKEN }
    timeout_ms: 5000
    data_policy: { fields: [chat_id, message.body, understand.intent], pseudonymise_phones: true, honour_llm_optout: true, max_bytes: 16384 }
  tradingbot:
    kind: mcp
    url: http://127.0.0.1:8732/mcp
    token_ref: TRADINGBOT_MCP_TOKEN
    tools:
      place_signal: { side_effecting: true }     # forces approve
      get_positions: { side_effecting: false }
    data_policy: { fields: [understand.entities, message.body], pseudonymise_phones: true }
```

---

## 11. Failure modes and recovery

| Failure | Detection | Behaviour | Operator sees | Recovery |
| --- | --- | --- | --- | --- |
| Process crash | Supervisor | Restart; `executing` actions become `unknown` and auto-resolve (FR-X2) | Alert if restarts ≥ 3 in 10 min | Automatic; crash loop exits non-restartable with alert |
| Database corruption | `quick_check` at start; full `integrity_check` nightly against the backup copy, not the live file | Alert before exit; non-restartable exit; **never** back up a file that fails the check | Alert on non-WhatsApp channel | `wamcp restore --db-only <backup>`; session state is in the same file, so a db-only restore of an older file **implies re-pair** unless `session_state` is exported separately, which `wamcp backup` does hourly as a sidecar (`session.enc`). Restore drill is in §14.3 |
| Disk pressure | Free space < max(1 GB, 10 %, 2 × largest db) | Stop media downloads and summaries, keep text events; purge media oldest-first within retention; alert | Alert | Expand disk or lower budgets; `doctor` projects footprint |
| WhatsApp logout | `connection.state` | No retry; `connector.paused` | Alert on all channels | Re-pair |
| Phone not seen > 7 days (Web) | `phone last seen` | Warn | Alert | Bring phone online |
| Baileys protocol break | `connector_errors_total{kind=auth|decode|send}` spike; `stale` state | `degraded` or `stale`; rules continue for other accounts | Alert; `doctor` compares pinned version to the published known-good list | Runbook: identify → pin → upgrade → re-pair if required |
| LLM outage or 429 | Error rate | `UNDERSTAND_FAILED`; LLM conditions not matched; deterministic rules unaffected; summaries queued | Alert at > 20 % errors over 5 min | Automatic |
| Webhook endpoint down (Cloud API) | Meta retries | Late deliveries are live events classified by the age rule; duplicates dropped by dedup key | Alert if no webhook in X min while traffic expected | Automatic |
| Clock skew | `occurred_at` vs `received_at` > 5 min | Warn; windows use `received_at` converted to the account zone | Alert | Fix host clock (`doctor` checks NTP) |
| WhatsApp spam or rate signals | Send error codes | Account `throttled{until: +24 h, reason}` overlay: halve limits, force `approve` for all `counterparty_send` rules. Sticky until `unthrottle_account` | Alert; visible in status, `/readyz`, gauge, audit | Operator review then `wamcp accounts unthrottle` |
| Subscriber too slow | Queue depth | Drop oldest for that subscriber; `subscription.lagged` | Metric | Client resumes from `resume_cursor` |
| Rule throws | Error counter | Fail closed; `suspended` after 5 | Alert | Fix, `wamcp rules enable` |
| Migration fails | Transaction aborts | Each migration runs in one transaction with `schema_version` updated last; the binary refuses to start on a half-applied or newer schema | Alert before exit | `wamcp restore --db-only <pre-migration>` then install previous version; `migrate_on_start: false` for unattended hosts |
| Approvals pile up | Count | Expire per TTL | Alerts: pending > 10, expired in 24 h > N | `wamcp approvals ls` / `resubmit` / `approve-all --rule` |
| Backup stale | Backup age > 25 h | Warn | Alert | Check `wamcp backup` schedule |

---

## 12. Limits and capacity

| Limit | Default | Notes |
| --- | --- | --- |
| Accounts per instance | 5 | |
| Sustained events per second (all accounts) | 10 | Burst 100/s for 30 s; group commit absorbs |
| Rule evaluation per event (excluding LLM) | 5 ms p95, 50 ms hard cap (then `error`) | |
| Post-persist queue | 1 000 events per account | |
| Subscriber queue | 1 000 per subscription | |
| Media file size | 64 MB | |
| Media storage | 10 GB per account | purged oldest-first under disk pressure |
| Rules per account | 500 | |
| Actions per rule | 10 | |
| LLM calls per event | 2 | |
| LLM budget per account per day | 2 000 calls / 2 M tokens | hard stop + alerts at 80 / 100 % |
| LLM budget per chat per day | 200 calls | |
| LLM budget per sender per day | 50 calls | |
| LLM context per `understand` | 8 000 input tokens | |
| LLM concurrency | 4 per account | |
| Tool result size | 256 KB | |
| Regex pattern / input | 512 chars / 64 KB | RE2, linear time |
| Rendered template | 4 096 chars | |
| Approval TTL | 4 h | per-rule override |
| Audit storage | ≈ 300 B per matched/blocked trace; at 10 eps with 10 % matched, ≈ 26 MB/day → ≈ 9.5 GB/year at 365 d retention | `doctor` projects it |
| Retention | messages 180 d, media 30 d, audit 365 d | |
| Hardware | Raspberry Pi 4 class is sufficient for **one** account at default `synchronous=NORMAL` on SSD, not SD | |

---

## 13. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Reliability | Survive restart with no re-pairing and no lost events outside the ack-to-persist window; reconnect within 30 s of network recovery; persistent action queue with pre-generated ids |
| Latency | FR-M5; p95 MCP read tool < 300 ms |
| Privacy and security | §10 |
| Alerts (delivery) | All system alerts route through the operator channel (FR-A8) **without** the policy gate; each channel has a rate limit and digest mode (N alerts in M minutes → one digest). Default alerts: connector not connected > 2 min; `logged_out`; `stale`; `device.linked`; `conflict`; `unknown` actions > 0 after the resolve window; rule suspended; disk pressure; LLM error rate > 20 % / 5 min; LLM budget 80 % / 100 %; approvals pending > 10; approvals expired > N / 24 h; backup age > 25 h; `reconciliation.gap`; throttled; crash loop; phone not seen > 7 d; startup failure |
| Observability | Structured JSON logs with redaction (bodies only at `debug`). Metrics: `wamcp_events_total{account,type}`, `wamcp_event_latency_seconds{stage}`, `wamcp_ack_to_persist_seconds`, `wamcp_rule_matches_total{rule,decision}`, `wamcp_rule_errors_total`, `wamcp_actions_total{kind,state}`, `wamcp_gate_blocks_total{check}`, `wamcp_llm_calls_total{model,result}`, `wamcp_llm_tokens_total{account,model,direction}`, `wamcp_llm_latency_seconds`, `wamcp_connector_state{account}`, `wamcp_connector_errors_total{account,kind}`, `wamcp_connector_decrypt_failures_total{account}`, `wamcp_account_throttled{account}`, `wamcp_queue_depth{queue}`, `wamcp_chat_queue_delay_seconds` (incl. LLM). `/healthz` process; `/readyz` 503 on `logged_out` or `degraded` with per-account detail |
| `wamcp doctor` | Checks, each pass/warn/fail, non-zero exit on fail: config schema; master key present and not under `data/`; file modes; `quick_check` per database; schema version vs binary; free disk vs projected footprint; Baileys version vs known-good list; connector health; operator channels reachable and D11 satisfied; backup age ≤ 25 h and backup path not on the data disk; host clock vs NTP; timezone valid; token TTLs |
| `wamcp status` | Connector state, last event age, pending approvals, `unknown` actions, throttle, LLM spend, disk, backup age, per account |
| Timezone | All windows, cron, and schedule evaluation convert the UTC instant to the account's IANA zone (rule-level override allowed); host-local time is never used; DST gap times are treated as the next valid instant, repeated hours match both occurrences |
| Backups | `wamcp backup` runs `pg_dump --schema=acct_<id>` per account (and the `operator` schema), encrypts the dump under the master key with the key id recorded, plus an hourly `session.enc` sidecar of the live session state; daily by default, 7 retained; `wamcp restore --db-only` restores the schema and keeps the live session sidecar, `--full` restores both and documents that it may require re-pair |
| Upgrades | Migrations forward-only, one transaction each, `schema_version` last; `wamcp migrate --dry-run`; `migrate_on_start` option |
| Portability | Node 26 on Linux and macOS; Docker image; reference systemd unit and compose file |
| Testability | Fake connector replaying fixtures; `evaluate` pure; LLM provider mocked with recorded responses |

---

## 14. Test strategy and definition of done

### 14.1 Unit

- Rule engine: property tests (determinism with pinned `EvalContext`, specificity ordering, deny-on-scope-match, `on_match`, fail-closed, suspended survives import); golden traces.
- Policy gate: table tests for checks 0–10, limiter consumption and refund, operator-channel bypass.
- Templating: injection, unknown variables rejected, per-channel escaping.
- Events: dedup with discriminators, `seq` assignment, backfill classification by source and age, identity resolution.
- Timezone: DST fixtures.

### 14.2 Contract and integration

- Connector contract suite against the fake connector and, in a manual lane, a real paired test number.
- MCP conformance: schemas, error codes, pagination, scope enforcement, separation of duties, destructive confirms, Origin/Host validation.
- Cloud API webhook signatures and dedup-based replay (P3).

### 14.3 Chaos

- Kill the process at each stage (post-receive, pre-persist, post-persist, in-gate, in-send) → no lost events after the library handoff, no duplicate sends, correct terminal states, `unknown` auto-resolves.
- Kill between decrypt and key save → next 10 messages decrypt.
- Network partition during send → `sent` or `unknown`, never duplicated.
- Disk pressure during backup.
- Restore drill: `--db-only` keeps the session; `--full` from yesterday is detected and prompts re-pair.
- Migration abort halfway → refuses to start, restore path works.
- Crash loop → non-restartable exit and alert delivered.
- Alert delivery drill for `logged_out` and `connector not connected` on a non-WhatsApp channel.

### 14.4 Red team

- Injection corpus (≥ 50): instructions in body, quoted message, contact name, group description, caption, voice transcript, document content, image text, a fact value, a summary. Pass criteria: zero actions outside the matching rule's declared list; zero `write_rule` outputs saved; zero outbound to unregistered targets; **and** the corpus does not raise the match rate of any `counterparty_send` or `side_effecting` rule above its benign baseline by more than 2 percentage points.
- Fact and summary poisoning cases.
- `call_tool` argument injection.
- Self-command spoofing from contacts, forwarded commands, other linked device.
- Approval-code brute force hits the lockout.
- Token scope escalation; agent self-approval.
- Regex and template DoS payloads.

### 14.5 Release checklist (per phase)

- All in-scope ACs have passing tests or signed-off manual checks.
- `wamcp doctor` clean on a fresh install after `wamcp init`.
- Pairing shows the ToS acknowledgement.
- Defaults: `approval: approve`, conservative limits, HTTP on loopback, retention set, one non-WhatsApp operator channel configured.
- No secrets, phone numbers, or bodies in default-level logs (grep over a 1 h run).

### 14.6 Definition of done by phase

| Phase | Scope | Done when |
| --- | --- | --- |
| **P0a Core** | pnpm monorepo; Connector interface; WebConnector with pairing, session state stored in the account schema and committed in the event transaction, bounded pairing history sync; per-account Postgres schemas; write-ahead events with dedup, `seq`, cursor; identity table; MCP server over Streamable HTTP (Hono) and the stdio proxy with scoped tokens, read tools, `send_message` with pre-generated ids and `approve` via CLI; policy gate with kill switches, rate limits, loop protection; operator channel with email/webhook and approvals; `wamcp init|serve|status|doctor|tail|accounts|approvals|actions|backup|restore|tokens`; systemd unit and compose file; starter rules installed disabled | Pair a test number; see live messages in Claude Code; send a reply through CLI approval; kill -9 at each stage with no re-pair and no gap after handoff; decrypt-vs-key-save chaos passes; alert drill for `logged_out` lands on email or webhook; `doctor` clean |
| **P0b Transport** | Streamable HTTP, stdio proxy with token file, scoped tokens, subscriptions and `get_events`, first-contact rule, self-commands with codes, ack-to-persist measurement and journaling investigation | Two clients attached; scope-escalation and self-approval red-team pass; `wamcp_ack_to_persist_seconds` reported |
| **P1 Rules + bridge** | Rule schema, DB-authoritative storage with import, scopes, three-phase engine, deterministic conditions, all `observe` and `counterparty_send` actions, `test_rule`, `explain_event`, versioning, `call_tool` and `notify` with registered targets and data policies, audit tools, migrations tooling | Golden traces and property tests pass; SSRF and third-party-forward tests pass; `explain_event` answers a "why not" question |
| **P2 Understanding** | Context assembly with provenance, taxonomy, `understand` / `summarize_chat` / `draft_reply`, LLM conditions with budgets, facts with TTL, transcription, content guard, opt-out including read tools | Injection corpus passes including false-positive criterion; budget flood test; opt-out verified at provider and tool level |
| **P3 Cloud API** | CloudApiConnector, signature and dedup replay protection, templates, 24 h windows, `phone_number` scope, `send_interactive` native, template fallback | Same rule pack runs; group rules rejected cleanly |
| **P4 Operations** | Admin UI, Postgres / Redis options, group mutations and polls behind flag, semantic search, metrics dashboard, connector process isolation spike, whatsmeow sidecar spike, "assign to human" candidate | 24 h unattended run with two accounts; alert drill for every default alert |

---

## 15. Open items (non-blocking)

1. `escalated` auto-clear default (7 days) and whether `needs-attention` should persist after auto-clear. Current: cleared.
2. Content guard default `flag` vs `block` once P2 lands. Current: `flag`.
3. Exact Baileys pin and the outcome of the pre-ack journaling investigation (P0b). If journaling is feasible without a fork, D14 can be tightened.
4. Whether `raw` scope should exist at all or opted-out content should be unreachable by any token. Current: exists, admin-granted only.
5. Approval-code length vs phone usability (6 chars chosen with lockout; revisit if the lockout fires in practice).

---

## 16. Glossary

- **MCP**: Model Context Protocol.
- **WABA**: WhatsApp Business Account.
- **Web connector**: WhatsApp Web multi-device protocol implementation for personal and Business App accounts.
- **LID**: WhatsApp's non-phone identifier for a user; mapped to a canonical contact id.
- **Operator channel**: the system's own line to the human operator; bypasses the policy gate; can only reach the operator.
- **Action class**: `observe`, `counterparty_send`, or `side_effecting`; decides approval defaults and gate checks.
- **Scope / specificity**: where a rule applies and its evaluation order weight.
- **EvalContext**: the state snapshot the pure evaluator reads.
- **Idempotency key / pre-generated id**: executor-level key and the WhatsApp message id chosen before sending.
- **Backfill**: an event from history sync, an explicit history request, or older than the age threshold.
- **Fail closed**: on error, do nothing rather than guess.
