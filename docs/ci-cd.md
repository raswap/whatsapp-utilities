# CI and CD

Decided with the owner on 2026-10-08 (tech-stack T23 to T26).

## Continuous integration (`.github/workflows/ci.yml`)

Runs on every pull request and on pushes to `main`: install, Biome lint, tsc build, vitest with coverage against a throwaway local Postgres. The coverage summary is posted as a PR comment and uploaded as an artifact.

Also on every PR and weekly: CodeQL for JavaScript/TypeScript (`codeql.yml`). Dependabot opens weekly grouped PRs for npm, GitHub Actions, and the Docker base image; `@whiskeysockets/baileys` is excluded because protocol upgrades are deliberate.

## Continuous delivery (`.github/workflows/release.yml`)

- Every push to `main` builds the image and pushes `ghcr.io/raswap/wamcp:main` and `ghcr.io/raswap/wamcp:sha-<short>`.
- A tag `vX.Y.Z` pushes `ghcr.io/raswap/wamcp:X.Y.Z` and `:X.Y`, and creates a GitHub Release with generated notes.
- No server credentials live in GitHub. The host pulls: `docker compose pull && docker compose up -d`.

The GHCR package is private by default for a private repository. The host needs a read-only token: `docker login ghcr.io -u raswap -p <PAT with read:packages>`.

## Branch protection on `main` (set once, by hand)

The GitHub tooling available to the automation cannot change repository settings, so set these at
`https://github.com/raswap/whatsapp-utilities/settings/branches` → Add rule for `main`:

- Require a pull request before merging.
- Require status checks to pass before merging, and require branches to be up to date. Select `test` (from `ci`) and `analyze` (from `codeql`).
- Do not allow bypassing the above settings.
- Optionally: require linear history.

## Deployment paths

Both are supported with equal weight (owner is undecided):

1. **Docker host**: `docker-compose.yml` runs Postgres 16 and wamcp. Needs `.env` with `POSTGRES_PASSWORD`, a `wamcp.yaml`, and a `master.key` file (created by `wamcp init`). The MCP port is bound to loopback on the host.
2. **systemd host**: local Postgres, `deploy/wamcp.service`, environment in `/etc/wamcp/env`, code in `/opt/wamcp`. Exit status 3 is reserved for "do not restart".

A macOS launchd plist will be added with the CLI slice.
