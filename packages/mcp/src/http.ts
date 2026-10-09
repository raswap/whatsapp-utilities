import { randomUUID } from 'node:crypto'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Principal, TokenStore } from '@wamcp/core'
import { Hono } from 'hono'
import type { Logger } from 'pino'
import type { Registry } from './context.js'
import { type BuiltServer, buildServer } from './server.js'

export interface HttpOptions {
  registry: Registry
  tokens: TokenStore
  log: Logger
  /** Host header values accepted besides loopback forms. */
  allowedHosts?: string[]
  /** Origin header values accepted besides loopback origins. */
  allowedOrigins?: string[]
  /** Tool calls per minute per token. */
  callsPerMinute?: number
  /** Readiness probe. */
  ready?: () => Promise<{ ok: boolean; detail: Record<string, unknown> }>
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  built: BuiltServer
  principal: Principal
  createdAt: number
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function hostAllowed(host: string | undefined, extra: string[]): boolean {
  if (!host) return false
  return LOOPBACK.test(host) || extra.includes(host)
}

function originAllowed(origin: string | undefined, extra: string[]): boolean {
  if (!origin) return true // non-browser clients
  try {
    const u = new URL(origin)
    return LOOPBACK.test(u.host) || extra.includes(origin)
  } catch {
    return false
  }
}

async function isInitialize(req: Request): Promise<boolean> {
  try {
    const body = (await req.clone().json()) as { method?: string } | Array<{ method?: string }>
    const msgs = Array.isArray(body) ? body : [body]
    return msgs.some((m) => m?.method === 'initialize')
  } catch {
    return false
  }
}

/** Sliding one-minute window per token, in memory (one process). */
class CallLimiter {
  private hits = new Map<string, number[]>()
  constructor(private readonly perMinute: number) {}
  allow(key: string, now = Date.now()): { ok: boolean; retryAfterMs: number } {
    const arr = (this.hits.get(key) ?? []).filter((t) => t > now - 60_000)
    if (arr.length >= this.perMinute) {
      this.hits.set(key, arr)
      return { ok: false, retryAfterMs: (arr[0] as number) + 60_000 - now }
    }
    arr.push(now)
    this.hits.set(key, arr)
    return { ok: true, retryAfterMs: 0 }
  }
}

/**
 * Streamable HTTP transport on Hono (tech-stack T9, T10). Bearer tokens map to principals; each
 * MCP session gets its own server instance bound to that principal. Origin and Host are validated
 * against loopback plus the configured allowlists (DNS rebinding protection).
 */
export function createHttpApp(opts: HttpOptions) {
  const app = new Hono()
  const sessions = new Map<string, Session>()
  const limiter = new CallLimiter(opts.callsPerMinute ?? 60)
  const log = opts.log.child({ component: 'mcp-http' })

  app.get('/healthz', (c) => c.json({ ok: true }))
  app.get('/readyz', async (c) => {
    const r = opts.ready ? await opts.ready() : { ok: true, detail: {} }
    return c.json(r, r.ok ? 200 : 503)
  })

  app.use('/mcp', async (c, next) => {
    if (!hostAllowed(c.req.header('host'), opts.allowedHosts ?? []))
      return c.json({ error: 'FORBIDDEN', message: 'Host not allowed' }, 403)
    if (!originAllowed(c.req.header('origin'), opts.allowedOrigins ?? []))
      return c.json({ error: 'FORBIDDEN', message: 'Origin not allowed' }, 403)
    await next()
  })

  const authenticate = async (c: {
    req: { header(n: string): string | undefined }
  }): Promise<Principal | null> => {
    const auth = c.req.header('authorization') ?? ''
    const m = /^Bearer\s+(\S+)$/i.exec(auth)
    if (!m) return null
    return opts.tokens.verify(m[1] as string)
  }

  app.all('/mcp', async (c) => {
    const sessionId = c.req.header('mcp-session-id')
    const existing = sessionId ? sessions.get(sessionId) : undefined
    let principal: Principal | null = existing?.principal ?? null
    if (!principal) {
      principal = await authenticate(c)
      if (!principal)
        return c.json({ error: 'UNAUTHORIZED', message: 'missing or invalid bearer token' }, 401, {
          'www-authenticate': 'Bearer',
        })
    } else {
      // A session is bound to the token that opened it; the token must still be valid.
      const again = await authenticate(c)
      if (!again || again.id !== principal.id)
        return c.json({ error: 'UNAUTHORIZED', message: 'token does not match session' }, 401)
    }
    if (c.req.method === 'POST') {
      const r = limiter.allow(principal.id)
      if (!r.ok)
        return c.json(
          { error: 'RATE_LIMITED', message: 'too many calls', retry_after_ms: r.retryAfterMs },
          429,
          { 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) },
        )
    }
    let session = existing
    if (!session) {
      if (sessionId) return c.json({ error: 'NOT_FOUND', message: 'unknown session' }, 404)
      if (c.req.method !== 'POST' || !(await isInitialize(c.req.raw))) {
        return c.json(
          { error: 'VALIDATION_ERROR', message: 'a new session must start with an initialize request' },
          400,
        )
      }
      const built = buildServer(opts.registry, principal)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, session as Session)
          log.info({ session: id, principal: principal?.id }, 'mcp session opened')
        },
        onsessionclosed: (id) => {
          const s = sessions.get(id)
          sessions.delete(id)
          void s?.built.close()
          log.info({ session: id }, 'mcp session closed')
        },
      })
      session = { transport, built, principal, createdAt: Date.now() }
      await built.server.connect(transport)
    }
    return session.transport.handleRequest(c.req.raw)
  })

  return {
    app,
    sessions,
    async closeAll() {
      for (const [id, s] of sessions) {
        sessions.delete(id)
        await s.transport.close()
        await s.built.close()
      }
    },
  }
}
