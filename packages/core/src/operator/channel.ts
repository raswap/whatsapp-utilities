import nodemailer, { type Transporter } from 'nodemailer'
import type { Logger } from 'pino'
import type { Clock } from '../clock.js'
import type { OperatorConfig } from '../config/schema.js'

export type OperatorMessageKind = 'alert' | 'approval' | 'info' | 'digest' | 'test'

export interface OperatorMessage {
  kind: OperatorMessageKind
  title: string
  body: string
  accountId?: string
  data?: Record<string, unknown>
}

export interface DeliveryResult {
  channel: string
  ok: boolean
  latencyMs: number
  error?: string
}

export interface ChannelSender {
  name: string
  kind: string
  send(msg: OperatorMessage): Promise<void>
}

export interface OperatorChannelOptions {
  config: OperatorConfig
  env: NodeJS.ProcessEnv
  log: Logger
  clock: Clock
  fetchImpl?: typeof fetch
  /** Test hook: replaces nodemailer transports. */
  mailTransport?: Transporter
  /** Test hook: additional senders (for example an in-memory one). */
  extraSenders?: ChannelSender[]
}

function webhookSender(
  c: Extract<OperatorConfig['channels'][number], { kind: 'webhook' }>,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): ChannelSender {
  return {
    name: c.name,
    kind: 'webhook',
    async send(msg) {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'wamcp' }
      if (c.auth_env && env[c.auth_env]) headers.authorization = `Bearer ${env[c.auth_env]}`
      const res = await fetchImpl(c.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: msg.kind,
          title: msg.title,
          body: msg.body,
          account: msg.accountId ?? null,
          data: msg.data ?? {},
          sent_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(c.timeout_ms),
        redirect: 'error',
      })
      if (!res.ok) throw new Error(`webhook ${c.name} returned HTTP ${res.status}`)
    },
  }
}

function emailSender(
  c: Extract<OperatorConfig['channels'][number], { kind: 'email' }>,
  env: NodeJS.ProcessEnv,
  transport?: Transporter,
): ChannelSender {
  let t = transport
  return {
    name: c.name,
    kind: 'email',
    async send(msg) {
      if (!t) {
        const url = env[c.smtp_url_env]
        if (!url) throw new Error(`email channel ${c.name}: ${c.smtp_url_env} is not set`)
        t = nodemailer.createTransport(url)
      }
      await t.sendMail({ from: c.from, to: c.to.join(', '), subject: `[wamcp] ${msg.title}`, text: msg.body })
    },
  }
}

/**
 * The system's own line to the human (PRD FR-A8). Bypasses the policy gate; has its own per-minute
 * limit and a digest mode so alert floods become one message.
 */
export class OperatorChannel {
  private readonly senders: ChannelSender[]
  private readonly log: Logger
  private readonly sentAt: number[] = []
  private readonly digestBuffer: OperatorMessage[] = []
  private digestTimer: NodeJS.Timeout | null = null
  readonly stats = { delivered: 0, failed: 0, digested: 0 }

  constructor(private readonly opts: OperatorChannelOptions) {
    this.log = opts.log.child({ component: 'operator-channel' })
    const fetchImpl = opts.fetchImpl ?? fetch
    this.senders = [
      ...opts.config.channels.map((c) =>
        c.kind === 'webhook'
          ? webhookSender(c, opts.env, fetchImpl)
          : emailSender(c, opts.env, opts.mailTransport),
      ),
      ...(opts.extraSenders ?? []),
    ]
  }

  get channelNames() {
    return this.senders.map((s) => `${s.kind}:${s.name}`)
  }

  /** Delivers to every channel, or buffers into a digest when over the per-minute limit. Never throws. */
  async notify(msg: OperatorMessage): Promise<DeliveryResult[]> {
    const now = this.opts.clock.now().getTime()
    while (this.sentAt.length && (this.sentAt[0] as number) < now - 60_000) this.sentAt.shift()
    if (
      msg.kind !== 'test' &&
      msg.kind !== 'digest' &&
      this.sentAt.length >= this.opts.config.rate_limit_per_minute
    ) {
      this.digestBuffer.push(msg)
      this.stats.digested++
      this.scheduleDigest()
      return []
    }
    this.sentAt.push(now)
    return this.deliver(msg)
  }

  private scheduleDigest() {
    if (this.digestTimer) return
    this.digestTimer = setTimeout(
      () => void this.flushDigest(),
      this.opts.config.digest_window_minutes * 60_000,
    )
    this.digestTimer.unref?.()
  }

  async flushDigest(): Promise<DeliveryResult[]> {
    if (this.digestTimer) {
      clearTimeout(this.digestTimer)
      this.digestTimer = null
    }
    if (this.digestBuffer.length === 0) return []
    const items = this.digestBuffer.splice(0)
    const body = items.map((m) => `• [${m.kind}] ${m.title}\n  ${m.body.split('\n')[0]}`).join('\n')
    return this.deliver({ kind: 'digest', title: `${items.length} notifications`, body })
  }

  private async deliver(msg: OperatorMessage): Promise<DeliveryResult[]> {
    const results = await Promise.all(
      this.senders.map(async (s): Promise<DeliveryResult> => {
        const t0 = performance.now()
        try {
          await s.send(msg)
          this.stats.delivered++
          return { channel: `${s.kind}:${s.name}`, ok: true, latencyMs: Math.round(performance.now() - t0) }
        } catch (e) {
          this.stats.failed++
          this.log.warn({ channel: s.name, err: (e as Error).message }, 'operator channel delivery failed')
          return {
            channel: `${s.kind}:${s.name}`,
            ok: false,
            latencyMs: Math.round(performance.now() - t0),
            error: (e as Error).message,
          }
        }
      }),
    )
    return results
  }

  /** `wamcp alerts test`. */
  test(): Promise<DeliveryResult[]> {
    return this.deliver({
      kind: 'test',
      title: 'wamcp alert test',
      body: 'If you can read this, the operator channel works.',
    })
  }
}

/** In-memory sender for tests and `wamcp tail`. */
export class MemorySender implements ChannelSender {
  readonly kind = 'memory'
  readonly messages: OperatorMessage[] = []
  constructor(readonly name = 'memory') {}
  async send(msg: OperatorMessage) {
    this.messages.push(msg)
  }
}
