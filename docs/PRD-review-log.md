# PRD Review Log

One hardening round was run against PRD v0.2 on 2026-10-06 with four independent adversarial reviewers (product, engineering, security, operations). Each finding below records its disposition in v0.3.

Disposition key: **A** accepted as proposed · **M** accepted with modification (reason given) · **R** rejected (reason given) · **D** deferred to a later phase (reason given).

Totals: 95 findings. 23 blocking. 83 accepted or modified, 7 deferred, 5 rejected.

## Product and operator experience (20)

| # | Tag | Finding (short) | Disp. | v0.3 location / reason |
| --- | --- | --- | --- | --- |
| P1 | BLOCKING | Approval notification is itself a gated send | A | Operator channel, FR-A8, `notify_operator` class in §7.3, §7.6 bypass |
| P2 | BLOCKING | Phone approval UX unusable (ULID codes, no preview, no listing) | M | FR-P4 / FR-P5: 6-char codes, `!p`, `!a`, `!r`, `!e`; lockout added because short codes need it |
| P3 | BLOCKING | Dedicated number vs commands from operator's own phone | A | D10 rewritten; `operator.numbers`; commands in the operator-number DM |
| P4 | BLOCKING | Urgent-notify p95 unreachable under approve default | A | Action classes; `observe` actions never need approval |
| P5 | BLOCKING | Action and tool names diverge; missing tools | A | §7.3 canonical table; one name per action; rule-only column |
| P6 | SHOULD | Agent can approve its own action | A | FR-P6 separation of duties, `approver` scope (same as S2) |
| P7 | SHOULD | Day one has no `init`, no business hours, no persona, no starter rules | A | FR-A1, FR-A9 |
| P8 | SHOULD | Initial history sync unspecified; Cloud API late deliveries mis-flagged | A | FR-M4 bounded sync; age-based classification |
| P9 | SHOULD | Sample rule references undefined variables; `version` in file | A | Variable namespace published and validated; `version` removed |
| P10 | SHOULD | YAML has four constraint blocks and no `deny` syntax | A | `when` merged; `never:` sugar |
| P11 | SHOULD | Intent taxonomy undefined | A | FR-U4, `list_intents`, validation |
| P12 | SHOULD | Facts duplicate; no label removal; no `resolve_action`; no bulk approvals | A | Facts upsert with TTL; `remove_label`, `list_labels`, `forget_fact`, `resolve_action`, `approve-all --rule` |
| P13 | SHOULD | `!mute` semantics conflict | A | `!pause [chat] [duration]` sets `paused` with `paused_until`; `mute_chat` is the WhatsApp mute only |
| P14 | SHOULD | Escalated chats go silent | A | `observe` actions run when paused or escalated |
| P15 | SHOULD | Red-team AC passes while injection fires a declared action | A | §14.4 false-positive criterion; FR-R4 `llm_condition` and `call_tool` constraints |
| P16 | SHOULD | Correction metric unmeasurable; FR-R5 and FR-C7 ACs wrong | A | §4.3 correction signal defined; FR-R5 pinned context; FR-C7 example-message AC |
| P17 | SHOULD | Team desk persona unserved | A | D13: deferred past v1 |
| P18 | NICE | Group mutations, polls, interactive fallback, content-guard rewrite are gold-plating | A | D12; `rewrite` removed; interactive fallback dropped until P3 |
| P19 | NICE | `list_chats` filters, `search_contacts`, per-token cursor missing | A | §7.7, FR-M12 |
| P20 | NICE | CLI inventory incomplete | A | §7.8 authoritative inventory |

## Engineering feasibility (26)

| # | Tag | Finding (short) | Disp. | v0.3 location / reason |
| --- | --- | --- | --- | --- |
| E1 | BLOCKING | Library acks before handler; write-ahead not honourable | M | D14 and G2 state the honest bound; ack-to-persist window measured; pre-ack journaling is a P0b investigation rather than a required fork |
| E2 | BLOCKING | Async Signal key save loses decryptability on crash | A | FR-A3: session state in the event transaction; chaos case |
| E3 | BLOCKING | Dedup key drops status and edit events | A | FR-M2 discriminator |
| E4 | BLOCKING | `seq`, 2 s reorder, and write-ahead cannot coexist | A | FR-M3: insertion order; reorder claim removed |
| E5 | BLOCKING | No gap-fetch on Web; loss metric unmeasurable | A | FR-M4 redefined; `requestHistory` handle; FR-M13 reconciliation |
| E6 | BLOCKING | Purity claim false | A | Three-phase engine with `EvalContext` and state deltas |
| E7 | BLOCKING | Idempotency tautology; retry undefined; 24 h vs unique | A | FR-X1 / FR-X2 pre-generated ids, `frameWritten`, auto-resolve, `(key, created_day)` |
| E8 | SHOULD | `synchronous=NORMAL` is not power-safe | A | FR-M1 states crash durability; `FULL` optional |
| E9 | SHOULD | 50 eps × 50 ms infeasible; Pi claim | A | §12: 10 eps, 5 ms p95, group commit, Pi qualified |
| E10 | SHOULD | RE2 cannot time out; timeout unimplementable | A | FR-R2 length caps; AC rewritten |
| E11 | SHOULD | Burst queue has no location | A | FR-M7 post-persist queue |
| E12 | SHOULD | ULID cursor skips late inserts | A | FR-M12 rowid cursor |
| E13 | SHOULD | Backoff cap contradicts reconnect AC | A | FR-A4 cap 20 s, reset on network change |
| E14 | SHOULD | `origin: phone` not derivable | A | FR-M10 `self_system` / `other_device` |
| E15 | SHOULD | LID vs phone JID identity | A | FR-M11 identities table |
| E16 | SHOULD | Serial per-chat LLM head-of-line blocking | A | FR-M5 concurrent fetch; inclusive metric |
| E17 | SHOULD | Data model gaps | A | §9 columns, indexes, unique facts, derived approval state, operator db for global rules |
| E18 | SHOULD | Limiter semantics undefined | A | §7.6 check 7 |
| E19 | SHOULD | P0 too large; hidden dependencies | A | P0a / P0b split; `wamcp tokens` in P0a |
| E20 | SHOULD | `is_backfill` defined twice | A | FR-M4 union definition |
| E21 | SHOULD | Global rules skipped; deny timing ambiguous | A | Empty scope = global; denies on scope match |
| E22 | SHOULD | Red-team AC satisfiable under successful injection | A | Same as P15 |
| E23 | SHOULD | Two sources of truth for rules | A | FR-R6 database authoritative; directory is import |
| E24 | SHOULD | Vague ACs | A | FR-A6, FR-C1, FR-C5, FR-M9 rewritten with observables |
| E25 | NICE | `mute` has three meanings | A | Same as P13 |
| E26 | NICE | Small inconsistencies (typing range, FR-M7 vs M1, conflict diagram, quiet-hours exemption, cron event id, stdio token source) | A | All fixed in §7.6, FR-M1, §8.1, FR-X1, §7.7 |

## Security, privacy, and abuse (25)

| # | Tag | Finding (short) | Disp. | v0.3 location / reason |
| --- | --- | --- | --- | --- |
| S1 | BLOCKING | `call_tool`, group ops, external notify default to auto | A | Action classes; `side_effecting` defaults to approve; per-target `side_effecting` flags |
| S2 | BLOCKING | Agent self-approval; `rules` token can set `auto` | A | FR-P6; `approver` scope; `auto` is an audited admin action (D4) |
| S3 | BLOCKING | Second-order injection via facts and summaries | A | FR-U5 provenance; FR-R10; red-team cases |
| S4 | BLOCKING | `llm: false` is false for read tools | A | FR-U10 read tools exclude unless `raw`; client retention disclaimer |
| S5 | BLOCKING | No LLM spend cap | A | FR-U11 budgets; `llm` scope |
| S6 | BLOCKING | `read` scope is a full dump | A | Split read scopes; allowlists; `get_invite_link` under `send` |
| S7 | SHOULD | Audit holds bodies, not tamper-evident, purge incomplete | A | §9 audit refs + hashes, hash chain; §10.4 purge cascade |
| S8 | SHOULD | Encryption at rest hand-wavy | A | SQLCipher; key sources named; same-user malware out of scope |
| S9 | SHOULD | Backups unencrypted, unmanaged | A | §10.2 backup row; §13 backups |
| S10 | SHOULD | Token lifecycle missing | A | §7.7 tokens: TTL, `last_used_at`, audited, CLI |
| S11 | SHOULD | Self-command spoofing via linked devices and forwards | A | FR-P4 constraints; `device.linked` / `conflict` alerts |
| S12 | SHOULD | Approval ids guessable; ≥ 96-bit codes | M | 6-char random codes with single use, binding, and lockout (FR-P5). 96-bit codes are not typeable from a phone; the lockout plus operator-DM-only acceptance makes guessing require an already-compromised operator device. Open item 5 tracks it |
| S13 | SHOULD | Approvals not invalidated on edit | A | FR-P7, FR-X4 |
| S14 | SHOULD | Third-party publication via forward / notify | A | §7.6 additional rule; per-channel escaping; name caps |
| S15 | SHOULD | Target data policy missing | A | §10.6 `data_policy` |
| S16 | SHOULD | Media handed to client LLM unmarked | A | FR-M6; `download_media` returns `untrusted: true` |
| S17 | SHOULD | 14-day auto flip | A | D4 rewritten; throttle is sticky |
| S18 | SHOULD | Loop protection and buckets drainable by one contact | A | §7.6 checks 0, 5, 7 |
| S19 | SHOULD | Notify floods | A | Operator channel limiter and digest |
| S20 | SHOULD | Un-pause and re-enable under non-admin scopes | A | §7.7 scope table |
| S21 | SHOULD | Identity not stable; names in scope; first-contact via groups | A | FR-M11; check 4 counts DMs only |
| S22 | NICE | Origin/Host validation; metrics endpoint | A | §7.7 transports |
| S23 | NICE | Webhook timestamp rejection contradicts retries | A | Dedup-based replay protection |
| S24 | NICE | Supply chain; process boundary | M | Lockfile, provenance, audit gate accepted; connector process isolation deferred to a P4 spike |
| S25 | NICE | `expose_phone`; self-chat lands in cloud backup | A | §10.4 |

## Operations and recovery (24)

| # | Tag | Finding (short) | Disp. | v0.3 location / reason |
| --- | --- | --- | --- | --- |
| O1 | BLOCKING | Alerts have no delivery mechanism | A | FR-A8 operator channel; D11 requires a non-WhatsApp channel; `wamcp alerts test` |
| O2 | BLOCKING | Corruption handling contradictory; crash loop backs up corrupt file | A | §9 process model; §11 corruption row |
| O3 | BLOCKING | No restore; stale session restore breaks decryption silently | A | `wamcp restore --db-only|--full`; hourly `session.enc` sidecar; restore drill; decrypt-failure metric |
| O4 | BLOCKING | Backups deferred to P4; key rotation invalidates them | M | Backup/restore moved to P0a; rotation re-wraps backups. "Require off-disk destination" softened to a `doctor` warning because a mandatory second disk is too heavy for a solo operator |
| O5 | BLOCKING | `unknown` unresolvable | A | FR-X2 auto-resolve; `list_actions`, `resolve_action`, `wamcp actions` |
| O6 | SHOULD | Migration failure path | A | §11 migration row; `wamcp migrate`; `migrate_on_start` |
| O7 | SHOULD | Throttle invisible and irreversible | A | `throttled` overlay; `unthrottle_account` |
| O8 | SHOULD | Disk thresholds inconsistent | A | §11 disk row: max(1 GB, 10 %, 2 × db); purge first |
| O9 | SHOULD | Disk pause drops events into ignored backfill | A | Keep text events; stop media and summaries only |
| O10 | SHOULD | Watchdog undefined; crash loops | A | systemd / compose shipped in P0a; crash-loop detection |
| O11 | SHOULD | Protocol-break detection and runbook | A | `connector_errors_total`, `stale` state, known-good list, runbook row |
| O12 | SHOULD | "Why didn't rule X fire" unanswerable | A | FR-R9 `explain_event`; audit filters |
| O13 | SHOULD | Audit volume unbounded | A | FR-R11; §12 sizing |
| O14 | SHOULD | `doctor` unspecified | A | §13 check list |
| O15 | SHOULD | Timezone and DST | A | §13 timezone row; FR-R2 fixtures |
| O16 | SHOULD | Isolation claim vs one SQLite file | A | D9 per-account databases and session stores |
| O17 | SHOULD | Phone-not-seen alert | A | §11, §13 |
| O18 | SHOULD | Auto-disable vs reload flapping | A | `suspended` flag survives import |
| O19 | SHOULD | LLM spend control | A | Same as S5 |
| O20 | SHOULD | Full integrity check stalls the writer | A | `quick_check` live; full check on backup copy |
| O21 | NICE | `/readyz` green while degraded; no `wamcp status` | A | §8.1, §13 |
| O22 | NICE | Expired approvals pile up silently | A | FR-P3 alert and `resubmit` |
| O23 | NICE | Chaos suite gaps; alert drill deferred | A | §14.3 cases; alert drill in P0a DoD |
| O24 | NICE | CLI inventory | A | Same as P20 |

## Rejected or deferred items, with reasons

| # | Disposition | Reason |
| --- | --- | --- |
| E1 (fork Baileys to journal pre-ack) | Deferred to a P0b investigation | A hard fork is a maintenance burden; measure the window first, then decide |
| S12 (≥ 96-bit approval codes) | Modified | Not typeable from a phone; compensating controls added |
| S24 (connector process boundary) | Deferred to P4 spike | Significant architecture change; supply-chain controls cover the near term |
| O4 (mandatory off-disk backup) | Modified to a `doctor` warning | Too heavy a requirement for the primary persona |
| P17 (team desk persona) | Deferred (D13) | Out of v1 scope; recorded as a P4 candidate |
| P18 (group mutations) | Deferred to P4 behind a flag (D12) | Highest ban risk, no v1 persona needs it |
| Open item 4 (`raw` scope existence) | Open | Reviewer S4 proposed the scope; whether it should exist at all is left for the owner |

## Exit decision

The round surfaced blocking findings that changed decisions in §2 (D4, D9, D10, and new D11 through D14). Per the loop's exit criterion, one more targeted pass is warranted on the affected sections only: §2, §6, §7.2, §7.3, §7.6, §7.7, §9, §14.6. The next step is for the owner to review those sections before P0a begins.
