# wamcp: WhatsApp MCP server

Real-time monitoring of one or more WhatsApp accounts, a policy gate in front of every action, and an MCP server so an agent such as Claude Code can read, understand, and (with approval) act on your chats.

Status: **P0a**. Personal and Business App accounts over the WhatsApp Web protocol, Postgres storage, policy gate with approvals, MCP over Streamable HTTP and stdio. The rule engine (P1), LLM understanding (P2), and the Cloud API connector (P3) come next. See `docs/PRD-whatsapp-mcp.md` and `docs/tech-stack.md`.

> Pairing a personal or Business App number uses an unofficial library and breaches WhatsApp's Terms of Service. The number can be banned. Use a dedicated number.

## Day one

Requirements: Node 22, pnpm 10, Postgres 16 reachable (the shipped `docker-compose.yml` provides one), and one non-WhatsApp alert channel (an ntfy topic, a Telegram relay, a Slack incoming webhook, or SMTP email).

```bash
pnpm install && pnpm build
alias wamcp='node packages/cli/dist/index.js'

# 1. Setup: writes wamcp.yaml, .env, the master key, provisions the database, installs three disabled starter rules.
wamcp init

# 2. Check everything.
wamcp doctor

# 3. Pair the dedicated number: scan the QR from WhatsApp > Linked devices.
wamcp accounts pair main

# 4. Run the server.
wamcp serve
```

In a second terminal:

```bash
wamcp tail                      # live events as they are persisted
wamcp status                    # connection, approvals, unknown actions
wamcp approvals ls              # sends waiting for you
wamcp approvals approve ABC123  # or reject
```

## Connect Claude Code or Claude Desktop

`wamcp serve` writes a local token to `data/_operator/local-stdio.token`. Point your MCP client at the stdio proxy:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/whatsapp-utilities/packages/cli/dist/index.js", "mcp", "--stdio", "--config", "/path/to/wamcp.yaml"]
    }
  }
}
```

Tools the agent sees: `whatsapp_list_accounts`, `whatsapp_list_chats`, `whatsapp_get_messages`, `whatsapp_get_thread`, `whatsapp_search_messages`, `whatsapp_get_events`, `whatsapp_subscribe_events`, `whatsapp_send_message`, `whatsapp_react_to_message`, `whatsapp_mark_read`, `whatsapp_list_pending_approvals`, `whatsapp_get_audit_log`, and more. By default every send from a tool is queued for your approval (`tool_send_approval: approve` in `wamcp.yaml`).

For remote agents, create a scoped token and use the HTTP endpoint directly:

```bash
wamcp tokens create --name agent --scopes read:messages,read:audit,send --accounts main
# MCP endpoint: http://127.0.0.1:8787/mcp with Authorization: Bearer <token>
```

Approvals need a separate `approver` token or the CLI; a token can never approve its own action.

## Operating it

| Need | Command |
| --- | --- |
| Stop everything on one account | `wamcp accounts pause main` / `resume` |
| Stop everything everywhere | `wamcp kill` / `wamcp kill --off` |
| Sends whose outcome is unknown | `wamcp actions ls --state unknown`, then `wamcp actions resolve <id> --outcome sent` |
| Backups | `wamcp backup` (encrypted `pg_dump` per account plus a session sidecar) |
| Restore | `wamcp restore main backups/main/<file>.sql.enc` (`--full` also restores the session; may need re-pair) |
| Alert channel check | `wamcp alerts test` |
| Clear the automatic throttle | `wamcp accounts unthrottle main` |

Deploy with `docker-compose.yml`, `deploy/wamcp.service` (systemd), or `deploy/com.wamcp.plist` (launchd). Images are published to `ghcr.io/raswap/wamcp` on every merge to main; see `docs/ci-cd.md`.

## Development

```bash
pnpm lint && pnpm build && pnpm test   # tests start a throwaway local Postgres
wamcp serve --fake                     # in-memory connector, no WhatsApp
```

Repository layout: `packages/core` (storage, pipeline, gate, executor, operator channel), `packages/connector-web` (Baileys), `packages/mcp` (MCP server and transports), `packages/cli` (`wamcp`).
