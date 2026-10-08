import { WebConnector } from '@wamcp/connector-web'
import { type AccountRuntime, createAccountRuntime, FakeConnector, tablesFor } from '@wamcp/core'
import type { CliContext } from './context.js'

export interface BuildOptions {
  /** Use in-memory connectors; for commands that only read or write the database. */
  fake: boolean
  only?: string | undefined
  onQr?: (accountId: string, qr: string) => void
  onPairingCode?: (accountId: string, code: string) => void
  onState?: (accountId: string, state: string, reason?: string) => void
  pairingPhones?: Record<string, string>
}

/** Builds an AccountRuntime per configured account (PRD §9 process model). */
export async function buildRuntimes(ctx: CliContext, o: BuildOptions): Promise<Map<string, AccountRuntime>> {
  const out = new Map<string, AccountRuntime>()
  for (const cfg of ctx.config.accounts) {
    if (o.only && cfg.id !== o.only) continue
    const schemaName = `acct_${cfg.id}`
    const connector = o.fake
      ? new FakeConnector(cfg.id)
      : cfg.type === 'web'
        ? new WebConnector({
            accountId: cfg.id,
            db: ctx.handle.db,
            tables: tablesFor(schemaName),
            codec: ctx.codec,
            schemaName,
            log: ctx.log,
            historyDays: cfg.history_days,
            ...(o.pairingPhones?.[cfg.id] ? { pairingPhone: o.pairingPhones[cfg.id] as string } : {}),
            ...(o.onQr ? { onQr: (qr) => o.onQr?.(cfg.id, qr) } : {}),
            ...(o.onPairingCode ? { onPairingCode: (code) => o.onPairingCode?.(cfg.id, code) } : {}),
            ...(o.onState ? { onState: (s, r) => o.onState?.(cfg.id, s, r) } : {}),
          })
        : (() => {
            throw new Error(
              `account ${cfg.id}: type ${cfg.type} is not supported yet (Cloud API connector is P3)`,
            )
          })()
    out.set(
      cfg.id,
      createAccountRuntime({
        handle: ctx.handle,
        config: cfg,
        connector,
        codec: ctx.codec,
        clock: ctx.clock,
        log: ctx.log,
        operator: ctx.operator,
        backfillAgeThresholdMs: ctx.config.server.backfill_age_threshold_seconds * 1000,
        approvalTtlMs: ctx.config.server.approval_ttl_hours * 3600_000,
        unknownResolveWindowMs: ctx.config.server.unknown_resolve_window_minutes * 60_000,
      }),
    )
  }
  return out
}
