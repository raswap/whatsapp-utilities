import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { serve as honoServe, type ServerType } from '@hono/node-server'
import {
  type AccountRuntime,
  type ConnectorState,
  hashToken,
  operatorSettings,
  provisionAccount,
  provisionOperator,
  tokens as tokensTable,
} from '@wamcp/core'
import { createHttpApp } from '@wamcp/mcp'
import { eq } from 'drizzle-orm'
import type { CliContext } from './context.js'
import { buildRuntimes } from './runtimes.js'

export const LOCAL_TOKEN_FILE = 'local-stdio.token'
export const EXIT_DO_NOT_RESTART = 3
const STARTS_KEY = 'process_starts'

export interface ServerOptions {
  fake?: boolean
  /** Sweep interval in ms (executor maintenance). */
  sweepMs?: number
  /** Crash-loop guard: this many starts within windowMs exits with status 3. */
  crashLoop?: { max: number; windowMs: number }
  /** Skip binding HTTP (tests). */
  http?: boolean
}

export interface RunningServer {
  runtimes: Map<string, AccountRuntime>
  httpServer: ServerType | null
  port: number | null
  localToken: string
  stop(): Promise<void>
}

/** Records this start and reports whether we are in a crash loop (PRD §9 process model). */
export async function recordStart(
  ctx: CliContext,
  now: Date,
  guard: { max: number; windowMs: number },
): Promise<{ loop: boolean; recentStarts: number }> {
  const [row] = await ctx.handle.db
    .select({ v: operatorSettings.value })
    .from(operatorSettings)
    .where(eq(operatorSettings.key, STARTS_KEY))
  const starts = ((row?.v as string[] | undefined) ?? [])
    .map((s) => new Date(s))
    .filter((d) => d.getTime() > now.getTime() - guard.windowMs)
  starts.push(now)
  await ctx.handle.db
    .insert(operatorSettings)
    .values({ key: STARTS_KEY, value: starts.map((d) => d.toISOString()) })
    .onConflictDoUpdate({
      target: operatorSettings.key,
      set: { value: starts.map((d) => d.toISOString()), updatedAt: now },
    })
  return { loop: starts.length > guard.max, recentStarts: starts.length }
}

/** Ensures a local admin-ish token exists for the stdio proxy; plaintext lives in a 0600 file under data/_operator. */
export async function ensureLocalToken(ctx: CliContext): Promise<string> {
  const dir = resolve(ctx.configPath, '..', ctx.config.server.data_dir, '_operator')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = resolve(dir, LOCAL_TOKEN_FILE)
  if (existsSync(file)) {
    const plain = readFileSync(file, 'utf8').trim()
    const [row] = await ctx.handle.db
      .select({ id: tokensTable.id, revokedAt: tokensTable.revokedAt, expiresAt: tokensTable.expiresAt })
      .from(tokensTable)
      .where(eq(tokensTable.hash, hashToken(plain)))
    if (row && !row.revokedAt && (!row.expiresAt || row.expiresAt > ctx.clock.now())) return plain
  }
  const created = await ctx.tokens.create({
    name: 'local-stdio',
    scopes: [
      'read:messages',
      'read:contacts',
      'read:media',
      'read:audit',
      'read:rules',
      'send',
      'llm',
      'rules',
    ],
    accountIds: ['*'],
    ttlDays: null,
  })
  writeFileSync(file, `${created.plaintext}\n`, { mode: 0o600 })
  return created.plaintext
}

const ALERT_STATES: ReadonlySet<ConnectorState> = new Set([
  'logged_out',
  'degraded',
  'stale',
  'conflict_wait',
])

export async function startServer(ctx: CliContext, o: ServerOptions = {}): Promise<RunningServer> {
  const log = ctx.log.child({ component: 'serve' })
  await provisionOperator(ctx.handle)
  for (const a of ctx.config.accounts) await provisionAccount(ctx.handle, a)
  const guard = o.crashLoop ?? { max: 5, windowMs: 10 * 60_000 }
  const { loop, recentStarts } = await recordStart(ctx, ctx.clock.now(), guard)
  if (loop) {
    await ctx.operator.notify({
      kind: 'alert',
      title: 'wamcp crash loop',
      body: `${recentStarts} starts in ${Math.round(guard.windowMs / 60_000)} minutes; staying down (exit ${EXIT_DO_NOT_RESTART}).`,
    })
    throw Object.assign(new Error('crash loop detected'), { exitCode: EXIT_DO_NOT_RESTART })
  }
  const localToken = await ensureLocalToken(ctx)
  const runtimes = await buildRuntimes(ctx, {
    fake: o.fake ?? false,
    onState: (accountId, state, reason) => {
      if (ALERT_STATES.has(state as ConnectorState)) {
        void ctx.operator.notify({
          kind: 'alert',
          title: `Account ${accountId}: ${state}`,
          body: reason ?? state,
          accountId,
        })
      }
    },
  })
  const registry = { accounts: runtimes, globalKill: () => ctx.operatorState.globalKill() }
  for (const rt of runtimes.values()) {
    await rt.start()
    log.info({ account: rt.config.id }, 'account started')
  }
  const sweep = setInterval(() => {
    for (const rt of runtimes.values())
      void rt.executor.sweep().catch((e) => log.error({ err: (e as Error).message }, 'sweep failed'))
  }, o.sweepMs ?? 30_000)
  sweep.unref()

  let httpServer: ServerType | null = null
  let port: number | null = null
  let httpApp: ReturnType<typeof createHttpApp> | null = null
  if (o.http !== false) {
    httpApp = createHttpApp({
      registry,
      tokens: ctx.tokens,
      log: ctx.log,
      allowedOrigins: ctx.config.server.http.allowed_origins,
      ready: async () => {
        const detail: Record<string, unknown> = {}
        let ok = true
        for (const rt of runtimes.values()) {
          const s = rt.connector.health().state
          detail[rt.config.id] = s
          if (s === 'logged_out' || s === 'degraded') ok = false
        }
        return { ok, detail }
      },
    })
    httpServer = honoServe({
      fetch: httpApp.app.fetch,
      hostname: ctx.config.server.http.bind,
      port: ctx.config.server.http.port,
    })
    await new Promise<void>((r) => (httpServer as ServerType).once('listening', r))
    const addr = httpServer.address()
    port = typeof addr === 'object' && addr ? addr.port : ctx.config.server.http.port
    log.info({ bind: ctx.config.server.http.bind, port }, 'MCP HTTP listening')
  }

  return {
    runtimes,
    httpServer,
    port,
    localToken,
    async stop() {
      clearInterval(sweep)
      await httpApp?.closeAll()
      if (httpServer) {
        ;(httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
        await new Promise<void>((r) => (httpServer as ServerType).close(() => r()))
      }
      for (const rt of runtimes.values()) await rt.stop()
    },
  }
}
