import pino from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '../clock.js'
import { AccountConfigSchema } from '../config/schema.js'
import { FakeConnector, textMessage } from '../connectors/fake.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { accountSchemaName } from '../ids.js'
import { plainCodec } from '../store/codec.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { Pipeline } from './pipeline.js'
import type { StoredEvent } from './types.js'

let tdb: TestDatabase
const log = pino({ level: 'silent' })
let n = 0

async function makePipeline(opts: { persistPresence?: boolean; batchSize?: number } = {}) {
  const id = `p${++n}`
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id, type: 'web', display_name: id, timezone: 'UTC' }),
  )
  const schema = accountSchemaName(id)
  const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))
  const pipeline = new Pipeline({
    accountId: id,
    schemaName: schema,
    db: tdb.handle.db,
    tables: tablesFor(schema),
    codec: plainCodec,
    clock,
    log,
    ...opts,
  })
  const connector = new FakeConnector(id)
  pipeline.attach(connector)
  await pipeline.start()
  await connector.start()
  return { pipeline, connector, clock, schema }
}

beforeAll(async () => {
  tdb = await createTestDatabase()
})
afterAll(async () => {
  await tdb.drop()
})

describe('event store semantics', () => {
  it('assigns per-chat seq, deduplicates by provider id, and keeps distinct status events', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const base = { chatId: 'a@s.whatsapp.net', senderJid: 'a@s.whatsapp.net', occurredAt: clock.now() }
    await connector.emit(textMessage({ ...base, providerId: 'M1', body: 'one' }))
    await connector.emit(textMessage({ ...base, providerId: 'M1', body: 'one again' })) // duplicate
    await connector.emit(textMessage({ ...base, providerId: 'M2', body: 'two' }))
    await connector.emit({
      ...base,
      type: 'message.status',
      providerId: 'M1',
      isFromMe: true,
      source: 'live',
      payload: { recipientJid: 'a@s.whatsapp.net', status: 'delivered' },
    })
    await connector.emit({
      ...base,
      type: 'message.status',
      providerId: 'M1',
      isFromMe: true,
      source: 'live',
      payload: { recipientJid: 'a@s.whatsapp.net', status: 'read' },
    })
    await connector.emit(
      textMessage({
        chatId: 'b@s.whatsapp.net',
        senderJid: 'b@s.whatsapp.net',
        providerId: 'M1',
        body: 'other chat same id',
        occurredAt: clock.now(),
      }),
    )

    const all = await pipeline.events.listAfter(0, 100)
    const chatA = all.filter((e) => e.chatId === 'a@s.whatsapp.net')
    expect(chatA.map((e) => e.seq)).toEqual([1, 2, 3, 4])
    expect(chatA.map((e) => e.type)).toEqual([
      'message.received',
      'message.received',
      'message.status',
      'message.status',
    ])
    expect(all.filter((e) => e.chatId === 'b@s.whatsapp.net').map((e) => e.seq)).toEqual([1])
    expect(pipeline.metrics.duplicates).toBe(1)
    const msgs = await pipeline.messages.getMessages({ chatId: 'a@s.whatsapp.net' })
    expect(msgs.items.map((m) => m.body)).toEqual(['two', 'one'])
  })

  it('classifies backfill by source and by age, and projects edits and deletes', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const chatId = 'c@s.whatsapp.net'
    const old = new Date(clock.now().getTime() - 10 * 60_000)
    await connector.emit(
      textMessage({
        chatId,
        senderJid: chatId,
        providerId: 'H1',
        body: 'from history',
        occurredAt: clock.now(),
        source: 'history',
      }),
    )
    await connector.emit(
      textMessage({ chatId, senderJid: chatId, providerId: 'L1', body: 'late live', occurredAt: old }),
    )
    await connector.emit(
      textMessage({ chatId, senderJid: chatId, providerId: 'L2', body: 'fresh', occurredAt: clock.now() }),
    )
    await connector.emit({
      type: 'message.edited',
      chatId,
      senderJid: chatId,
      providerId: 'L2',
      occurredAt: clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { body: 'fresh (edited)' },
    })
    await connector.emit({
      type: 'message.deleted',
      chatId,
      senderJid: chatId,
      providerId: 'L1',
      occurredAt: clock.now(),
      isFromMe: false,
      source: 'live',
      payload: {},
    })
    const evs = await pipeline.events.listAfter(0, 100, { chatIds: [chatId] })
    expect(evs.filter((e) => e.type === 'message.received').map((e) => e.isBackfill)).toEqual([
      true,
      true,
      false,
    ])
    const msgs = await pipeline.messages.getMessages({ chatId })
    expect(msgs.items.map((m) => m.body)).toEqual(['fresh (edited)', 'from history'])
    const withDeleted = await pipeline.messages.getMessages({ chatId, includeDeleted: true })
    expect(withDeleted.items.find((m) => m.providerId === 'L1')?.deletedAt).not.toBeNull()
  })

  it('paginates messages by cursor without gaps or duplicates and walks a quote thread', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const chatId = 'd@s.whatsapp.net'
    for (let i = 0; i < 120; i++) {
      clock.advance(1000)
      await connector.emit(
        textMessage({
          chatId,
          senderJid: chatId,
          providerId: `P${i}`,
          body: `m${i}`,
          occurredAt: clock.now(),
          ...(i > 0 && i % 3 === 0
            ? { payload: { kind: 'text', body: `m${i}`, quotedProviderId: `P${i - 3}` } }
            : {}),
        }),
      )
    }
    const seen: string[] = []
    let before: string | undefined
    for (;;) {
      const page = await pipeline.messages.getMessages({ chatId, limit: 50, ...(before ? { before } : {}) })
      seen.push(...page.items.map((m) => m.providerId))
      if (!page.nextCursor) break
      before = page.nextCursor
    }
    expect(seen.length).toBe(120)
    expect(new Set(seen).size).toBe(120)
    expect(seen[0]).toBe('P119')
    const thread = await pipeline.messages.getThread(chatId, 'P9')
    expect(thread.map((m) => m.providerId)).toEqual(['P0', 'P3', 'P6', 'P9'])
    const hits = await pipeline.messages.search({ query: 'm42', chatIds: [chatId] })
    expect(hits.map((m) => m.providerId)).toEqual(['P42'])
  })
})

describe('identity resolution', () => {
  it('maps phone JID and LID of one person to one contact and merges on a late link', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const chatId = '120363@g.us'
    await connector.emit(
      textMessage({
        chatId,
        senderJid: '919999000001@s.whatsapp.net',
        providerId: 'G1',
        body: 'hi from phone jid',
        occurredAt: clock.now(),
      }),
    )
    await connector.emit(
      textMessage({
        chatId,
        senderJid: '5551234@lid',
        providerId: 'G2',
        body: 'hi from lid',
        occurredAt: clock.now(),
      }),
    )
    let evs = await pipeline.events.listAfter(0, 100, { chatIds: [chatId] })
    const [c1, c2] = evs.map((e) => e.senderId)
    expect(c1).not.toBe(c2)
    // Connector later learns both belong to the same person.
    await connector.emit(
      textMessage({
        chatId,
        senderJid: '5551234@lid',
        providerId: 'G3',
        body: 'linked',
        occurredAt: clock.now(),
        identityHints: [
          { jid: '5551234@lid', kind: 'lid', sameAs: '919999000001@s.whatsapp.net', pushName: 'Asha' },
        ],
      }),
    )
    evs = await pipeline.events.listAfter(0, 100)
    const linked = evs.find((e) => e.type === 'identity.linked')
    expect(linked).toBeDefined()
    const msgs = await pipeline.messages.getMessages({ chatId })
    expect(new Set(msgs.items.map((m) => m.senderId)).size).toBe(1)
    const canonical = msgs.items[0]?.senderId as string
    expect((await pipeline.identities.jidsFor(canonical)).sort()).toEqual([
      '5551234@lid',
      '919999000001@s.whatsapp.net',
    ])
    expect(await pipeline.identities.phoneOf(canonical)).toBe('+919999000001')
  })
})

describe('dispatcher and subscriptions', () => {
  it('delivers in per-chat seq order, persists a watermark, and resumes after a restart', async () => {
    const { pipeline, connector, clock, schema } = await makePipeline({ batchSize: 7 })
    const got: string[] = []
    pipeline.onEvent(async (e) => {
      got.push(`${e.chatId}:${e.seq}`)
    })
    for (let i = 0; i < 20; i++) {
      const chat = i % 2 ? 'x@s.whatsapp.net' : 'y@s.whatsapp.net'
      await connector.emit(
        textMessage({
          chatId: chat,
          senderJid: chat,
          providerId: `D${i}`,
          body: `d${i}`,
          occurredAt: clock.now(),
        }),
      )
    }
    await pipeline.drained()
    const x = got.filter((g) => g.startsWith('x')).map((g) => Number(g.split(':')[1]))
    const y = got.filter((g) => g.startsWith('y')).map((g) => Number(g.split(':')[1]))
    expect(x).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(y).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const watermark = pipeline.dispatchCursor
    expect(watermark).toBe(await pipeline.events.latestCursor())

    // Simulate a crash after persisting but before dispatching: insert directly, then start a new pipeline.
    await pipeline.stop()
    await pipeline.events.insert(
      textMessage({
        chatId: 'z@s.whatsapp.net',
        senderJid: 'z@s.whatsapp.net',
        providerId: 'Z1',
        body: 'undelivered',
        occurredAt: clock.now(),
      }),
    )
    const second = new Pipeline({
      accountId: 'restart',
      schemaName: schema,
      db: tdb.handle.db,
      tables: tablesFor(schema),
      codec: plainCodec,
      clock,
      log,
    })
    const late: string[] = []
    second.onEvent(async (e) => {
      late.push(e.providerId ?? '')
    })
    await second.start()
    await second.drained()
    expect(late).toEqual(['Z1'])
    expect(second.dispatchCursor).toBe(watermark + 1)
  })

  it('handler errors do not block delivery and are counted', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const delivered: string[] = []
    pipeline.onEvent(async () => {
      throw new Error('boom')
    })
    pipeline.onEvent(async (e) => {
      delivered.push(e.id)
    })
    await connector.emit(
      textMessage({
        chatId: 'e@s.whatsapp.net',
        senderJid: 'e@s.whatsapp.net',
        providerId: 'E1',
        body: 'x',
        occurredAt: clock.now(),
      }),
    )
    await pipeline.drained()
    expect(delivered.length).toBe(1)
    expect(pipeline.metrics.handlerErrors).toBe(1)
  })

  it('subscriptions filter, bound their queue, and send a lagged notice with a resume cursor', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const received: StoredEvent[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    pipeline.subscriptions.subscribe(
      { chatIds: ['s@s.whatsapp.net'], includeFromMe: false },
      async (e) => {
        received.push(e)
        if (first) {
          first = false
          await gate // stall the sink so the queue overflows
        }
      },
      3,
    )
    for (let i = 0; i < 8; i++) {
      await connector.emit(
        textMessage({
          chatId: 's@s.whatsapp.net',
          senderJid: 's@s.whatsapp.net',
          providerId: `S${i}`,
          body: `s${i}`,
          occurredAt: clock.now(),
        }),
      )
    }
    await connector.emit(
      textMessage({
        chatId: 'other@s.whatsapp.net',
        senderJid: 'o@s.whatsapp.net',
        providerId: 'O1',
        body: 'filtered out',
        occurredAt: clock.now(),
      }),
    )
    await pipeline.drained()
    release()
    await new Promise((r) => setTimeout(r, 50))
    const types = received.map((e) => e.type)
    expect(types[0]).toBe('message.received')
    expect(types).toContain('subscription.lagged')
    const lag = received.find((e) => e.type === 'subscription.lagged') as StoredEvent
    expect((lag.payload as { dropped: number }).dropped).toBeGreaterThan(0)
    expect(received.some((e) => e.chatId === 'other@s.whatsapp.net')).toBe(false)
    // Events after the lag notice are the newest ones, in order.
    const after = received.slice(received.indexOf(lag) + 1).map((e) => e.providerId)
    expect(after).toEqual(['S5', 'S6', 'S7'])
  })

  it('presence events bypass the store and reach subscribers directly', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const got: string[] = []
    pipeline.subscriptions.subscribe({ types: ['presence.updated'] }, (e) => {
      got.push(e.type)
    })
    await connector.emit({
      type: 'presence.updated',
      chatId: 'p@s.whatsapp.net',
      occurredAt: clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { state: 'composing' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual(['presence.updated'])
    expect(await pipeline.events.latestCursor()).toBe(0)
  })

  it('from-me messages get origin self_system only when we pre-generated the id', async () => {
    const { pipeline, connector, clock } = await makePipeline()
    const t = tablesFor(accountSchemaName(pipeline.events ? (connector.accountId as string) : ''))
    await tdb.handle.db.insert(t.actions).values({
      id: 'a1',
      idempotencyKey: 'k1',
      state: 'executing',
      kind: 'send_message',
      class: 'counterparty_send',
      source: 'cli',
      chatId: 'f@s.whatsapp.net',
      messageId: '3EB0SELF',
    })
    await connector.emit(
      textMessage({
        chatId: 'f@s.whatsapp.net',
        senderJid: 'me@s.whatsapp.net',
        providerId: '3EB0SELF',
        body: 'automated',
        occurredAt: clock.now(),
        type: 'message.sent',
        isFromMe: true,
      }),
    )
    await connector.emit(
      textMessage({
        chatId: 'f@s.whatsapp.net',
        senderJid: 'me@s.whatsapp.net',
        providerId: 'PHONE1',
        body: 'typed on phone',
        occurredAt: clock.now(),
        type: 'message.sent',
        isFromMe: true,
      }),
    )
    const msgs = await pipeline.messages.getMessages({ chatId: 'f@s.whatsapp.net' })
    expect(msgs.items.map((m) => [m.providerId, m.origin])).toEqual([
      ['PHONE1', 'other_device'],
      ['3EB0SELF', 'self_system'],
    ])
    expect(await pipeline.messages.lastHumanReplyAt('f@s.whatsapp.net')).not.toBeNull()
  })
})

describe('store branches', () => {
  it('identity hints: phone lookup, sameAs lookup, pushName update, and merge keeps the phone', async () => {
    const { pipeline, connector, clock, schema } = await makePipeline()
    const ids = pipeline.identities
    // phone from the jid; a later LID hint with an explicit phone joins the same contact
    const a = await ids.resolve({ jid: '919999000011@s.whatsapp.net', kind: 'phone' })
    const b = await ids.resolve({ jid: '11@lid', kind: 'lid', phone: '+919999000011', pushName: 'Pn' })
    expect(b).toMatchObject({ contactId: a.contactId, created: false })
    // sameAs lookup when neither jid nor phone matches
    const c = await ids.resolve({ jid: '12@lid', kind: 'lid', sameAs: '919999000011@s.whatsapp.net' })
    expect(c.contactId).toBe(a.contactId)
    // pushName-only update on a known contact, and a re-resolve without changes
    await ids.resolve({ jid: '12@lid', kind: 'lid', pushName: 'Renamed' })
    await ids.resolve({ jid: '12@lid', kind: 'lid' })
    expect((await ids.contactsByIds([a.contactId]))[0]?.pushName).toBe('Renamed')
    expect(await ids.contactsByIds([])).toEqual([])
    // merging two contacts where the dropped one carries the phone
    const x = await ids.resolve({ jid: '13@lid', kind: 'lid' })
    const y = await ids.resolve({ jid: '919999000013@s.whatsapp.net', kind: 'phone' })
    const merged = await ids.link('13@lid', y.contactId)
    expect(merged.mergedFrom).toBeDefined()
    expect(await ids.phoneOf(merged.contactId)).toBe('+919999000013')
    expect(await ids.phoneOf(x.contactId === merged.contactId ? y.contactId : x.contactId)).toBeNull()
    expect(await ids.link('13@lid', merged.contactId)).toEqual({ contactId: merged.contactId })
    expect(await ids.phoneOf('nope')).toBeNull()
    void clock
    void schema
    // a chat-less event (contact update) and a group event without an explicit chatType
    await connector.emit({
      type: 'contact.updated',
      senderJid: '919999000011@s.whatsapp.net',
      occurredAt: clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { name: 'A', pushName: null },
    })
    await connector.emit({
      type: 'group.subject_changed',
      chatId: '555@g.us',
      occurredAt: clock.now(),
      isFromMe: false,
      source: 'live',
      payload: { subject: 'S' },
    } as never)
    const evs = await pipeline.events.listAfter(0, 5, { types: ['contact.updated', 'group.subject_changed'] })
    expect(evs.map((e) => e.chatId)).toEqual([null, '555@g.us'])
    expect(await pipeline.events.getById('missing')).toBeNull()
    expect(await pipeline.events.getById(evs[0]?.id as string)).not.toBeNull()
    expect(
      await pipeline.events.listAfter(0, 100, { includeFromMe: false, includeBackfill: false }),
    ).toHaveLength(2)
    // a caption-only media message projects the caption as body
    await connector.emit({
      ...textMessage({ chatId: '555@g.us', senderJid: '11@lid', providerId: 'CAP', body: '' }),
      payload: { kind: 'image', caption: 'cap' },
    })
    expect((await pipeline.messages.getMessages({ chatId: '555@g.us' })).items[0]?.body).toBe('cap')
  })
})
