# WhatsApp MCP: Product Requirements Document

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Owner | raswap |
| Repository | `raswap/whatsapp-utilities` |
| Last updated | 2026-10-01 |

---

## 1. Summary

Build a **WhatsApp MCP server** ("the system") that connects to one or more WhatsApp accounts (personal or business), **monitors them in real time**, exposes the account to AI agents through the **Model Context Protocol (MCP)**, and **automatically takes actions** (reply, forward, label, notify, escalate, call out to other systems) according to a **layered ruleset** that can be scoped to the account, a chat, a group, a contact, a message type, a time window, or any combination.

The system has three faces:

1. **Connector + monitor**: a long-running process that keeps the WhatsApp session alive, receives every inbound event (messages, replies, reactions, group changes, read receipts, calls) and persists it.
2. **Rule engine + understanding layer**: evaluates each event against the active rules. Rules can be deterministic (keyword, sender, time) or semantic (an LLM classifies the intent, sentiment, urgency, and conversation context before a rule fires).
3. **MCP server**: lets any MCP client (Claude Desktop, Claude Code, a custom agent) read chats, send messages, inspect context, and manage rules through typed tools, resources, and live notifications.

---

## 2. Problem statement

WhatsApp is where a large share of personal, customer, and team communication happens, but it offers no programmable, context-aware automation to end users:

- Personal and small-business accounts have **no official API**. Automation today means manual phone work or fragile scripts.
- The official Business Platform (Cloud API) is webhook-based and stateless. It gives raw messages, not **conversation understanding** or **rules**.
- Existing bots are keyword responders. They do not understand *"this is the third time this customer asked about a refund and they are getting angry"*, and they cannot apply different behaviour per chat, per group, or per contact.
- AI agents (via MCP) can reason about messages but have no safe, governed way to **act** on WhatsApp.

We want one system that gives a human operator **fine-grained control** over what an agent is allowed to see and do on each part of their WhatsApp, while the agent handles the reading, understanding, and routine replies.

---

## 3. Goals and non-goals

### Goals

| # | Goal | Success measure |
| --- | --- | --- |
| G1 | Connect to personal, WhatsApp Business App, and WhatsApp Business Platform (Cloud API) accounts through one abstraction | Same MCP tools work on all three account types |
| G2 | Real-time monitoring with durable storage | Inbound event visible to rules and MCP clients < 2 s after arrival; zero message loss across reconnects |
| G3 | Send messages, read replies, and follow threads | Agent can send, see the reply, and see the quoted/thread context in one tool call |
| G4 | Context understanding | For any message, the system can produce: intent, sentiment, urgency, entities, a conversation summary, and relevant history |
| G5 | Layered ruleset with precedence | Rules at account, group, chat, contact, message-type, and time scopes compose predictably |
| G6 | Safe autonomy | Every outbound action passes through a policy gate: rate limits, quiet hours, allow/deny lists, approval mode, dry run, audit log |
| G7 | Multi-account | One server instance can run N accounts with isolated rules, storage, and credentials |

### Non-goals (v1)

- Bulk marketing or cold outreach to numbers that have not messaged first (this is the fastest path to a banned account and is out of scope).
- Reading end-to-end content we are not a party to. The system only sees what the connected account can see.
- A full CRM. We store conversation state and contact metadata, not pipelines or invoices.
- Replacing the WhatsApp UI. The operator keeps using the phone / WhatsApp Web normally.

---

## 4. Users and personas

| Persona | Account type | What they want |
| --- | --- | --- |
| **Solo operator** (the primary user) | Personal + Business App | Triage personal and work WhatsApp with an AI assistant: auto-acknowledge, summarise groups, draft replies, never miss urgent messages |
| **Small business** | Business App or Cloud API | Answer FAQs automatically, hand off complex cases, respect business hours, track open customer threads |
| **Team / support desk** | Cloud API (WABA with multiple numbers) | Route by number, by language, by intent; escalate to humans; audit everything |
| **Developer / agent builder** | Any | A clean MCP surface to build their own agents on top of WhatsApp |

---

## 5. Account types and connectivity

| Account type | Transport | Auth | Capabilities | Risk |
| --- | --- | --- | --- | --- |
| **Personal** | WhatsApp Web multi-device protocol (library: Baileys for Node, whatsmeow for Go) | QR code or pairing code, session keys persisted locally | Full read/write: DMs, groups, communities, media, reactions, presence, status | Unofficial. Violates WhatsApp ToS. Ban risk rises with spam-like behaviour. Must be rate-limited and human-like |
| **WhatsApp Business App** | Same as personal (the Business App is a client of the same protocol) | Same | Same + catalog/labels metadata | Same |
| **WhatsApp Business Platform (Cloud API)** | Official Meta Graph API + webhooks | System user access token, WABA ID, phone number ID, webhook verify token | Send text/media/interactive/template messages; receive messages and status callbacks. 24-hour customer service window; outside it only approved templates. Groups are **not** supported | Official and supported. Metered pricing per conversation. No group access |

Design consequence: the system defines one **Connector interface** with two implementations, `WebConnector` (unofficial protocol) and `CloudApiConnector` (official). Capabilities are advertised per connector so rules and MCP tools can degrade gracefully (for example, a group rule is rejected on a Cloud API account).

---

## 6. Functional requirements

### 6.1 Account management

- FR-A1: Add an account by type. Web accounts pair via QR / pairing code shown in the terminal or admin UI. Cloud API accounts are configured with credentials from environment or a secrets file.
- FR-A2: Session persistence. Web sessions survive process restarts without re-pairing. Credentials are encrypted at rest.
- FR-A3: Auto-reconnect with exponential backoff. Reconnect reasons (logged out, conflict, network) are surfaced as events.
- FR-A4: Per-account isolation: separate storage namespace, rules, rate limiter, and audit log.
- FR-A5: Account-level kill switch: pause all automated actions on an account instantly while monitoring continues.

### 6.2 Real-time monitoring

The connector emits a normalised **Event** for everything it observes:

| Event | Fields (beyond the common envelope) |
| --- | --- |
| `message.received` | chat, sender, body, media, quoted message, mentions, is_forwarded, is_ephemeral |
| `message.sent` | as above, plus `origin` (`phone`, `mcp`, `rule`) so the operator's own manual replies are distinguished |
| `message.edited` / `message.deleted` / `message.reaction` | target message id, new content or emoji |
| `message.status` | delivered / read / played, per recipient |
| `chat.opened` / `chat.archived` / `chat.pinned` / `chat.muted` | chat id, new state |
| `group.created` / `group.participant_added` / `group.participant_removed` / `group.subject_changed` / `group.settings_changed` | group id, actor, affected participants |
| `contact.updated` | name, push name, profile picture change |
| `presence.updated` | online / typing / recording |
| `call.incoming` / `call.missed` | caller, is_video |
| `connection.state` | connected / reconnecting / logged_out, reason |

Requirements:

- FR-M1: Every event is persisted before any rule runs (write-ahead). Replays and crash recovery read from the store.
- FR-M2: Deduplication by provider message id; retries from the connector never create duplicate events.
- FR-M3: On reconnect, the Web connector syncs missed history (as far as the protocol allows) and emits events with `is_backfill = true` so rules can choose to ignore them.
- FR-M4: Media (image, audio, video, document, sticker, location, contact card) is downloaded on demand or eagerly per rule, stored on local disk / object storage, and referenced by URI. Voice notes can be transcribed by an optional pipeline so rules can match on spoken content.
- FR-M5: Latency target: event available to rules and MCP subscribers within 2 seconds of arrival at the connector.
- FR-M6: MCP clients can subscribe to a stream of events filtered by account, chat, group, or event type and receive them as MCP notifications.

### 6.3 Actions

Each action is available both as an MCP tool (agent-initiated) and as a rule action (system-initiated). All actions pass through the policy gate (6.6).

| Action | Notes |
| --- | --- |
| `send_text` | Supports reply-to (quoting a message), mentions, link preview on/off |
| `send_media` | Image, video, audio / voice note, document, sticker; with caption |
| `send_location`, `send_contact`, `send_poll` | Web connector only for polls |
| `send_template` | Cloud API only. Named template + variables; required outside the 24 h window |
| `send_interactive` | Cloud API buttons / lists; Web connector falls back to numbered text options |
| `react` | Add or remove an emoji reaction |
| `mark_read`, `set_typing`, `set_presence` | Used to make automated replies feel natural and to control read receipts |
| `forward` | Forward a message to another chat (within the same account) |
| `edit_message`, `delete_message` | Where the protocol allows |
| `label` / `tag` | Attach system labels to chats or messages (synced to WhatsApp Business labels when supported) |
| `archive`, `pin`, `mute` | Chat state changes |
| `group.*` | Create group, add / remove participants, promote / demote admin, change subject / description / settings, get invite link, leave |
| `notify` | Push to an external channel: webhook, email, Slack, a different WhatsApp chat (for example "forward urgent to my own number") |
| `escalate` | Hand the thread to a human: mark as needs-attention, optionally notify, and pause automation on that chat |
| `call_tool` | Invoke another MCP server's tool or an HTTP webhook with the message context (bridge to CRM, calendar, ticketing, the trading bot, etc.) |
| `schedule` | Delay any action to a future time or until a condition (for example "if no reply in 2 h") |
| `remember` | Store a fact about the contact or chat in the context store for future rules and prompts |

### 6.4 Reading and understanding

- FR-U1: `get_messages(chat, limit, before, after, include_media)` returns messages with quoted context and sender metadata.
- FR-U2: `get_thread(message_id)` walks the quote chain so an agent sees the full reply thread.
- FR-U3: `search(query, scope)` performs full-text search across one chat, one account, or all accounts. Optional semantic search via embeddings.
- FR-U4: `understand(message_id | chat_id)` runs the understanding pipeline and returns a structured object:

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
  "context_used": { "messages": 18, "contact_facts": 2, "group_summary": false }
}
```

- FR-U5: **Context assembly** for any message draws from: the last N messages in the chat, the quoted thread, stored facts about the contact, a rolling summary of the chat (updated incrementally), group description and recent group summary, the account-level persona / instructions, and the current time and business hours.
- FR-U6: The understanding pipeline is **model-pluggable**. Default provider is the Claude API with a fast model for classification (Haiku 4.5) and a stronger model for drafting and summarising (Sonnet 5.5 or Opus 5.5), each configurable per account and per rule. A local-model adapter is a stretch goal for privacy-sensitive deployments.
- FR-U7: Results are cached per message so repeated rule evaluations and MCP calls do not re-run the model.
- FR-U8: `draft_reply(chat_id, instructions?)` returns a suggested reply without sending it, so approval-mode workflows and human review are possible.

### 6.5 Rules and control levels

#### Scopes (control levels)

Rules attach to a **scope**. Scopes form a hierarchy; a more specific scope overrides or extends a broader one.

| Level | Scope key | Examples |
| --- | --- | --- |
| 1 | `global` | Quiet hours for every account |
| 2 | `account` | "On my business account, auto-acknowledge every new customer" |
| 3 | `phone_number` (Cloud API only; a WABA can have several numbers) | Route the support number differently from the sales number |
| 4 | `chat_type` (`dm`, `group`, `community`, `broadcast`, `channel`, `status`) | "Never auto-reply in groups" |
| 5 | `label` / `segment` (a dynamic set of chats or contacts) | "VIP customers", "Family", "Suppliers" |
| 6 | `group` (a specific group) | "In the Ops group, summarise daily at 18:00 and flag anything mentioning 'outage'" |
| 7 | `chat` (a specific DM) | "In this chat, only notify me, never reply" |
| 8 | `contact` (a person, across every chat they appear in) | "Anything from my landlord is urgent" |
| 9 | `participant_in_group` (a specific person inside a specific group) | "Only react to the admin's announcements" |
| 10 | `message_type` (`text`, `image`, `voice`, `document`, `location`, `poll`, `call`) | "Transcribe voice notes from clients" |
| 11 | `time_window` | Business hours, weekends, holidays |
| 12 | `thread` (a single reply chain) | "Pause automation on this escalated thread" |

Scopes compose with AND: a rule can be scoped to `account:business AND chat_type:dm AND time_window:after_hours`.

#### Precedence and inheritance

- Rules are evaluated most-specific first. Each rule declares `on_match: continue | stop`. The default is `continue` for observe-only rules (label, notify, remember) and `stop` for responders (send, escalate) so two rules never both reply.
- Rules carry an explicit `priority` integer to break ties inside the same scope.
- A **deny at any level wins**: if any matching rule says `deny: [send_text]`, no rule at any level can send text on that event. This is how "never auto-reply in groups" is enforced even if a contact rule would otherwise reply.
- Per-chat **automation state** (`active`, `paused`, `escalated`) overrides everything; `escalate` sets it to `escalated` until a human clears it.

#### Rule definition

Rules are declarative (YAML or JSON), stored in the database, editable through MCP tools, a CLI, and files on disk (hot-reloaded). Example:

```yaml
id: refund-triage
scope:
  account: business
  chat_type: dm
when:
  event: message.received
  not_from_me: true
  any_of:
    - keywords: ["refund", "money back", "chargeback"]
    - understand:
        intent: [refund_request, complaint]
        min_confidence: 0.8
conditions:
  time_window: business_hours        # named window defined at account level
  rate_limit: { per_chat: "1/10m" }   # do not fire more than once per 10 minutes per chat
actions:
  - label: needs-attention
  - send_text:
      template: "Hi {{contact.first_name}}, sorry about that. I've flagged this and will reply within {{sla.reply_minutes}} minutes."
      typing_delay: natural
  - remember: { key: last_refund_request_at, value: "{{event.timestamp}}" }
  - notify:
      channel: whatsapp
      to: "self"
      text: "⚠️ Refund request from {{contact.name}}: {{understand.summary}}"
on_match: stop
policy:
  approval: auto            # auto | approve | dry_run
  max_sends_per_day: 50
```

Requirements:

- FR-R1: Triggers: every event type in 6.2, plus `schedule.cron`, `schedule.after` (no reply within X), and `manual` (fired through MCP).
- FR-R2: Conditions: sender / contact / group filters, allow / deny lists, keyword and regex, message type, media presence, mention of me, reply-to-me, quoted message filters, language, `understand` outputs (intent, sentiment, urgency, confidence), stored facts, time windows, counters and rate limits, random sampling (for A/B), and a free-form LLM predicate (`llm_condition: "The sender is asking for a meeting time"`).
- FR-R3: Actions: everything in 6.3, with Mustache-style templating over the event, contact, chat, understanding result, and stored facts. Actions run sequentially; a failed action can `abort`, `skip`, or `retry`.
- FR-R4: Rule testing: `test_rule(rule, event | message_id)` evaluates without executing and returns the match trace (which conditions passed, what the actions would do). Rules can be created in `dry_run` mode and promoted later.
- FR-R5: Versioning: every rule change is recorded with who / what / when, and can be rolled back.
- FR-R6: Rule packs: a directory of rules can be imported or exported as a bundle for reuse across accounts.

### 6.6 Policy gate and safety

Every outbound action, from a rule or an MCP tool, passes through a single policy gate:

- FR-P1: **Approval modes** per account, scope, or rule: `auto` (execute), `approve` (queue; a human approves through MCP, CLI, or by replying to a self-notification with "ok"), `dry_run` (log only).
- FR-P2: **Rate limits**: per chat, per account, per rule, global. Defaults for Web connector accounts are deliberately conservative (for example 20 sends / hour / account, 1 send / 30 s / chat, randomised typing delays) to reduce ban risk.
- FR-P3: **Quiet hours and business hours** per account with timezone.
- FR-P4: **Allow / deny lists** for recipients, and a hard rule that the system never initiates a conversation with a number that has not messaged first unless the operator explicitly allowlists it.
- FR-P5: **Loop protection**: never auto-reply to a message that was itself generated by this system or by a detected bot; cap consecutive automated messages in a chat without a human message in between.
- FR-P6: **Content guard**: an optional LLM check on outgoing text against account-level guidelines (no commitments on price, no medical advice, and so on) before sending.
- FR-P7: **Audit log**: every evaluated rule, decision, action, approval, and MCP tool call is logged with inputs, outputs, actor, and latency. Queryable via MCP.
- FR-P8: **Kill switches**: global, per account, per chat. Reachable through MCP, CLI, and a WhatsApp command sent from the operator's own number (for example `!pause`).

### 6.7 MCP surface

Transports: `stdio` (for Claude Desktop / Claude Code) and Streamable HTTP with bearer-token auth (for remote agents). All tools take an `account_id` unless the server is configured with a default account.

**Tools**

| Group | Tools |
| --- | --- |
| Accounts | `list_accounts`, `get_account_status`, `pair_account`, `pause_account`, `resume_account` |
| Chats | `list_chats` (filters: type, unread, label, updated_since), `get_chat`, `archive_chat`, `pin_chat`, `mute_chat`, `set_chat_automation` (active / paused / escalated) |
| Messages | `get_messages`, `get_thread`, `search_messages`, `send_message`, `send_media`, `send_template`, `react_to_message`, `forward_message`, `edit_message`, `delete_message`, `mark_read`, `download_media` |
| Groups | `list_groups`, `get_group`, `get_group_participants`, `create_group`, `update_group`, `add_participants`, `remove_participants`, `set_admin`, `get_invite_link`, `leave_group` |
| Contacts | `list_contacts`, `get_contact`, `remember_fact`, `get_facts`, `set_label` |
| Understanding | `understand`, `summarize_chat`, `draft_reply`, `transcribe_media` |
| Rules | `list_rules`, `get_rule`, `create_rule`, `update_rule`, `delete_rule`, `test_rule`, `enable_rule`, `import_rules`, `export_rules` |
| Policy | `get_policy`, `set_policy`, `list_pending_approvals`, `approve_action`, `reject_action` |
| Monitoring | `subscribe_events` (filters), `unsubscribe_events`, `get_audit_log`, `get_metrics` |

**Resources**

- `whatsapp://{account}/chats` and `whatsapp://{account}/chats/{chat_id}` (chat metadata + recent messages, subscribable; the server sends `resources/updated` on new activity).
- `whatsapp://{account}/groups/{group_id}`
- `whatsapp://{account}/contacts/{contact_id}`
- `whatsapp://{account}/rules` and `whatsapp://{account}/rules/{rule_id}`
- `whatsapp://{account}/pending-approvals`

**Prompts**

- `triage_inbox`: summarise unread chats by urgency and propose actions.
- `reply_in_my_voice`: draft a reply using the account persona and stored contact facts.
- `write_rule`: turn a natural-language instruction ("whenever my accountant sends a PDF, forward it to the Finance group and thank him") into a validated rule definition.

**Notifications**: event stream from 6.2 delivered as MCP `notifications/message` with a structured payload, filtered per subscription. Also `resources/updated` on subscribed chat resources.

### 6.8 Operator interfaces

- CLI: `wamcp accounts add|list|pair|pause`, `wamcp rules ls|add|test|export`, `wamcp tail` (live event stream), `wamcp approvals`.
- WhatsApp self-commands: messages the operator sends to their own number (`!pause`, `!resume`, `!status`, `!approve 42`) are treated as commands. This is the fastest control surface from a phone.
- Admin web UI (phase 3): live feed, rule editor, approval queue, audit explorer.

---

## 7. Architecture

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                     MCP clients                          │
                 │   Claude Desktop · Claude Code · custom agents           │
                 └───────────────▲──────────────────────────▲───────────────┘
                                 │ stdio / streamable HTTP   │ notifications
┌────────────────────────────────┴──────────────────────────┴────────────────┐
│                               MCP server                                   │
│  tools · resources · prompts · subscriptions · auth                        │
├────────────────────────────────────────────────────────────────────────────┤
│  Policy gate   │  Rule engine   │  Understanding  │  Action executor       │
│  approvals     │  scopes +      │  context        │  retries, scheduling,  │
│  rate limits   │  precedence    │  assembly, LLM  │  templating, bridges   │
│  audit         │  hot reload    │  cache          │  (webhook, other MCP)  │
├────────────────────────────────────────────────────────────────────────────┤
│                           Event bus (in-process → Redis/NATS optional)     │
├──────────────────────────────┬─────────────────────────────────────────────┤
│       WebConnector           │           CloudApiConnector                 │
│  Baileys multi-device,       │  Graph API client + webhook receiver,       │
│  QR/pairing, session store,  │  signature verification, template catalog,  │
│  history sync, media         │  status callbacks, 24 h window tracking     │
├──────────────────────────────┴─────────────────────────────────────────────┤
│  Storage: SQLite (default, single node) or Postgres · media on disk / S3   │
│  Encrypted secrets store · full-text index · optional vector index         │
└────────────────────────────────────────────────────────────────────────────┘
```

**Stack decision**: TypeScript on Node.js. Reasons: Baileys (the most maintained open-source Web-protocol library) is Node-only; the official MCP TypeScript SDK supports stdio and Streamable HTTP with subscriptions; one language across connectors, rules, and MCP. Rule evaluation is pure functions over immutable event objects so it is unit-testable without a live account.

**Processes**: a single long-running `wamcp serve` process runs connectors, bus, rules, and the MCP HTTP transport. `wamcp mcp --stdio` can run as a thin client that connects to the running server over HTTP, so Claude Desktop does not need to own the WhatsApp session.

**Data model (core tables)**: `accounts`, `chats`, `contacts`, `group_participants`, `messages`, `media`, `events` (append-only), `facts` (contact / chat memory), `summaries`, `rules`, `rule_versions`, `actions` (queued / executed / failed), `approvals`, `audit_log`.

---

## 8. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Reliability | Survive process restart with no re-pairing and no lost events. Reconnect within 30 s of network recovery. Idempotent action execution with persistent retry queue |
| Latency | p95 event-to-rule < 2 s; p95 MCP read tool < 300 ms (from local store); send round-trip bounded by WhatsApp |
| Privacy | All data local by default. Credentials and session keys encrypted at rest with an operator-provided key. Configurable retention (for example purge media after 30 days). No telemetry leaves the host unless explicitly enabled |
| LLM data handling | Only the assembled context for the specific message is sent to the model provider. Per-account opt-out of LLM processing for specific chats or labels (for example "Family") |
| Security | MCP HTTP transport requires bearer token; webhook endpoint verifies Meta signatures; secrets never logged; tool inputs validated with JSON schema |
| Observability | Structured logs, Prometheus-style metrics (events/s, rule matches, sends, failures, LLM latency and cost), health endpoint |
| Portability | Runs on a laptop, a Raspberry Pi, or a container. Single binary-style install via `npx` / Docker |
| Testability | Fake connector that replays recorded event fixtures; rule engine tested without WhatsApp |

---

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Account ban on personal / Business App accounts (unofficial protocol violates WhatsApp ToS) | Loss of the number | Conservative default rate limits, human-like delays, never initiate to strangers, loud warning at pairing time, recommend a dedicated number for automation, prefer Cloud API for business use |
| Baileys protocol breakage after WhatsApp updates | Connector downtime | Pin versions, connector behind an interface so a swap to whatsmeow (Go sidecar) is possible, health alerts on disconnect |
| Cloud API 24 h window and template approval | Replies rejected | Window tracking per chat; rule engine automatically substitutes an approved template outside the window or escalates |
| LLM misclassification triggering a wrong action | Embarrassing or costly reply | Confidence thresholds, `approve` mode by default for send actions on new rules, dry-run promotion flow, content guard |
| Automation loops with other bots | Spam, ban | Loop protection (FR-P5) |
| Sensitive data sent to a model provider | Privacy breach | Per-chat / per-label LLM opt-out, local-model adapter (stretch), redaction of phone numbers in prompts where not needed |
| Multi-device conflicts (phone and server both acting) | Confusing duplicate replies | Distinguish `origin` on sent messages; rule option `skip_if_human_replied_within: 2m` |

---

## 10. Phased delivery

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **P0: Foundation** (first build) | TypeScript project, Connector interface, WebConnector with QR pairing and session persistence, SQLite store, event bus, MCP server (stdio + HTTP) with accounts / chats / messages / groups read tools and `send_message`, `subscribe_events`, CLI `serve` / `tail` | Pair a personal account, see live messages in Claude Code via MCP, send a reply from Claude Code, restart the process without re-pairing |
| **P1: Rules + policy** | Rule schema and loader (YAML + DB), scope hierarchy and precedence, deterministic conditions, all core actions, policy gate (rate limits, quiet hours, approval, dry run, kill switches), audit log, `test_rule`, self-commands | Rules at account, group, chat, contact, and time scopes verified by fixture tests; approval flow works from phone |
| **P2: Understanding** | Context assembly, `understand` / `summarize_chat` / `draft_reply` tools, LLM conditions in rules, rolling chat summaries, facts memory, voice transcription, content guard | Refund-triage style rule works end to end on real traffic; classification cache hit rate measured |
| **P3: Business Platform** | CloudApiConnector (webhooks, send, templates, 24 h window), multi-number routing scope, template fallback | Same rule pack runs on a Cloud API number with group rules rejected cleanly |
| **P4: Operations** | Admin web UI, Postgres option, Redis bus, Docker image, metrics dashboard, rule packs marketplace-style import / export | Deployable on a server with two accounts and 24 h unattended run |

---

## 11. Open questions

1. **First account type**: start with a personal / Business App account (Web connector) or the official Cloud API? The PRD assumes Web connector first because it covers groups and personal use, with Cloud API in P3.
2. **Hosting**: will this run on a local machine that is always on, or on a server? This affects the default storage choice and whether the MCP HTTP transport needs TLS termination.
3. **MCP client**: is the primary consumer Claude Code / Claude Desktop, or a custom agent that will embed the rules? This decides how much autonomy lives in rules versus in the agent's own prompt.
4. **Default autonomy**: should new send-capable rules default to `approve` (human confirms every message) or `auto`? The PRD recommends `approve` for the first two weeks per account.
5. **Model provider**: Claude API by default. Should a local-model option be in scope for v1 for privacy-sensitive chats?
6. **Relationship to `raswap/tradingbot`**: should the trading bot be a first-class action target (for example "when a trusted contact sends a signal in the Signals group, call the bot's MCP tool")? If yes, the `call_tool` bridge is promoted to P1.
7. The original request ended with "this MCP or the whatsapp bot or real time monitoring should be built..." and was cut off. Confirm the intended ending (for example built in this repo, built in TypeScript, built as a standalone service).

---

## 12. Glossary

- **MCP**: Model Context Protocol, the open standard for exposing tools, resources, and prompts to AI clients.
- **WABA**: WhatsApp Business Account, the Meta-side container for one or more business phone numbers on the Cloud API.
- **Web connector**: implementation of the WhatsApp Web multi-device protocol used by personal and Business App accounts.
- **Scope**: the level at which a rule applies (account, group, chat, contact, and so on).
- **Policy gate**: the single checkpoint every outbound action passes through for approval, rate limiting, and auditing.
