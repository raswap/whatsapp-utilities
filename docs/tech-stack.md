# Engineering Decisions: Tech Stack

Decided with the owner on 2026-10-08 before the first line of P0a code. Each row is a decision, not a suggestion; changing one is a new decision with its own entry in this file.

| # | Area | Decision | Notes |
| --- | --- | --- | --- |
| T1 | Runtime | TypeScript on Node.js 26 (LTS from 2026-10-28) | ESM throughout. Decided 2026-10-09: moved from 22 ahead of the 26 LTS promotion; Node major bumps stay deliberate |
| T2 | WhatsApp Web library | `@whiskeysockets/baileys` pinned to exactly `7.0.0-rc14` | The `latest` tag; tracks current protocol including LID identities. Upgrades are deliberate and go through `wamcp doctor`'s known-good list |
| T3 | Database | PostgreSQL 16, shipped in `docker-compose.yml` beside the server | Replaces the PRD v0.3 SQLite choice (D9). Backups via `pg_dump` per schema |
| T4 | Data access | Drizzle ORM for typed queries; DDL as SQL migration files with a `__SCHEMA__` placeholder, applied per schema by the application and tracked in `<schema>.schema_migrations` | Chosen over Prisma because Drizzle's `pgSchema(name)` supports schemas created at runtime; hand-written SQL keeps the per-schema runner CLI-free |
| T5 | Isolation | One Postgres schema per account (`acct_<id>`) with identical tables; shared data in the `operator` schema | Per-account backup, restore, and purge operate on a schema |
| T6 | Encryption at rest | Application-level AES-256-GCM for Signal session state, tokens, API keys, phone numbers. Message bodies are plaintext so `tsvector` search works | Disk-level encryption of the Postgres volume is the operator's responsibility and is documented |
| T7 | Master key | 32 random bytes in a key file outside the data directory, mode 0600; path from `WAMCP_MASTER_KEY_FILE`, default `~/.config/wamcp/master.key` | `wamcp init` creates it; `wamcp doctor` checks mode and location |
| T8 | MCP SDK | `@modelcontextprotocol/sdk` 1.x, modern `registerTool` / `registerResource` API | |
| T9 | MCP transports | Streamable HTTP and the stdio proxy both ship in P0a | HTTP bound to loopback by default; bearer tokens with scopes from the first commit |
| T10 | HTTP server | Hono on Node's `http` module | Hosts the MCP transport, `/healthz`, `/readyz`, metrics |
| T11 | Operator channels (P0a) | Generic HTTP webhook and SMTP email via nodemailer | WhatsApp DM to the operator number is P0b |
| T12 | Package manager and layout | pnpm workspace monorepo: `packages/core`, `packages/connector-web`, `packages/mcp`, `packages/cli` | |
| T13 | Build | `tsc` per package, emitting ESM with declarations | |
| T14 | Tests | vitest; global setup starts a throwaway local Postgres with `initdb` and `pg_ctl` on a random port, one database per test file | No Docker required for tests. CI installs the Postgres apt package |
| T15 | Lint and format | Biome | One config, replaces ESLint and Prettier |
| T16 | CLI | Commander | Binary name `wamcp` |
| T17 | Config | `wamcp.yaml` for configuration; secrets only from environment or `.env` (`DATABASE_URL`, SMTP password, provider keys) | Rules are also YAML |
| T18 | Logging | pino with a redaction list covering tokens, keys, phone numbers, and message bodies; `pino-pretty` in dev | Baileys receives the same logger |
| T19 | Identifiers | ULIDs for events, actions, approvals; WhatsApp message ids pre-generated before send | |
| T20 | Docker | `node:26-slim` multi-stage image | |
| T21 | License | None; all rights reserved | No `LICENSE` file is added on purpose |
| T22 | Delivery | One pull request per vertical slice, 4 to 6 for P0a, each against `main` with tests | |
| T23 | CI | GitHub Actions on every PR and push to `main`: Biome, tsc, vitest with coverage posted to the PR; CodeQL on PRs and weekly; Dependabot weekly for npm, Actions, and Docker with Baileys excluded | Decided 2026-10-08; see `docs/ci-cd.md` |
| T24 | CD | Every merge to `main` publishes `ghcr.io/raswap/wamcp:main` and a SHA tag; a `v*` tag publishes the version and creates a GitHub Release. No deploy credentials in GitHub; hosts pull | |
| T25 | Branch protection | `main` requires a PR and passing `ci` and `codeql` checks, up to date with base | Set by hand; the automation cannot change repo settings |
| T26 | Production host | Undecided; Docker compose and systemd paths are both shipped and documented | |

## P0a pull request plan

1. Decisions doc, PRD updates, monorepo scaffold, core storage and migrations, test harness, CI.
2. Event pipeline: connector interface, fake connector, event store with dedup and ordering, identities, subscriptions.
3. Policy gate, action executor, approvals, operator channel, audit log.
4. MCP server, Hono HTTP transport, stdio proxy, tokens and scopes.
5. Web connector on Baileys.
6. CLI, deploy files, starter rules, README.
