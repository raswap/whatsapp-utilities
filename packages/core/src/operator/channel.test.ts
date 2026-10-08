import { createServer, type Server } from 'node:http'
import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '../clock.js'
import { OperatorSchema } from '../config/schema.js'
import { MemorySender, OperatorChannel } from './channel.js'

const log = pino({ level: 'silent' })
let server: Server
let url = ''
const received: Array<{ auth?: string; body: unknown }> = []
let failNext = false

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => {
      data += c
    })
    req.on('end', () => {
      received.push({
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        body: JSON.parse(data),
      })
      if (failNext) {
        failNext = false
        res.writeHead(500).end()
        return
      }
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hook`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('operator channel', () => {
  it('posts JSON to a webhook with a bearer token from the environment', async () => {
    const config = OperatorSchema.parse({
      channels: [{ kind: 'webhook', name: 'hook', url, auth_env: 'HOOK_TOKEN' }],
    })
    const ch = new OperatorChannel({ config, env: { HOOK_TOKEN: 's3cret' }, log, clock: new ManualClock() })
    const r = await ch.notify({
      kind: 'alert',
      title: 'logged out',
      body: 'account main is logged out',
      accountId: 'main',
    })
    expect(r).toEqual([{ channel: 'webhook:hook', ok: true, latencyMs: expect.any(Number) }])
    expect(received.at(-1)?.auth).toBe('Bearer s3cret')
    expect(received.at(-1)?.body).toMatchObject({ kind: 'alert', title: 'logged out', account: 'main' })
  })

  it('reports failures without throwing', async () => {
    const config = OperatorSchema.parse({ channels: [{ kind: 'webhook', name: 'hook', url }] })
    const ch = new OperatorChannel({ config, env: {}, log, clock: new ManualClock() })
    failNext = true
    const r = await ch.notify({ kind: 'alert', title: 'x', body: 'y' })
    expect(r[0]?.ok).toBe(false)
    expect(r[0]?.error).toMatch(/HTTP 500/)
    expect(ch.stats.failed).toBe(1)
  })

  it('digests when over the per-minute limit, and test() always goes through', async () => {
    const clock = new ManualClock()
    const memory = new MemorySender()
    const config = OperatorSchema.parse({ channels: [], rate_limit_per_minute: 2, digest_window_minutes: 1 })
    const ch = new OperatorChannel({ config, env: {}, log, clock, extraSenders: [memory] })
    await ch.notify({ kind: 'alert', title: 'a1', body: 'x' })
    await ch.notify({ kind: 'alert', title: 'a2', body: 'x' })
    await ch.notify({ kind: 'alert', title: 'a3', body: 'x' })
    await ch.notify({ kind: 'alert', title: 'a4', body: 'x' })
    expect(memory.messages.map((m) => m.title)).toEqual(['a1', 'a2'])
    expect(ch.stats.digested).toBe(2)
    await ch.test()
    expect(memory.messages.at(-1)?.kind).toBe('test')
    await ch.flushDigest()
    const digest = memory.messages.at(-1)
    expect(digest?.kind).toBe('digest')
    expect(digest?.body).toContain('a3')
    expect(digest?.body).toContain('a4')
    clock.advance(61_000)
    await ch.notify({ kind: 'alert', title: 'a5', body: 'x' })
    expect(memory.messages.at(-1)?.title).toBe('a5')
  })

  it('email channel fails cleanly when SMTP_URL is missing', async () => {
    const config = OperatorSchema.parse({
      channels: [{ kind: 'email', name: 'mail', to: ['op@example.com'], from: 'wamcp@example.com' }],
    })
    const ch = new OperatorChannel({ config, env: {}, log, clock: new ManualClock() })
    const r = await ch.notify({ kind: 'alert', title: 'x', body: 'y' })
    expect(r[0]?.ok).toBe(false)
    expect(r[0]?.error).toMatch(/SMTP_URL/)
  })
})
