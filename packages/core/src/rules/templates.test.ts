import { describe, expect, it } from 'vitest'
import {
  MAX_NAME_LENGTH,
  MAX_RENDERED_LENGTH,
  renderTemplate,
  type TemplateVars,
  templateVars,
} from './templates.js'
import { ACCOUNT, CHAT, makeEvent, SENDER, T0 } from './testing/fixtures.js'

const INJECTION = '*bold* _u_ `code` [link](http://x) # h > q | ~s~ \\ "q" \n{{evil}} <b>'
const vars: TemplateVars = {
  message: { body: INJECTION, n: 3, flag: true, none: null },
  contact: { display_name: 'A'.repeat(100) },
  chat: { name: 'C'.repeat(70) },
  group: { name: 'G'.repeat(65) },
  account: { name: 'N'.repeat(64) },
}

describe('renderTemplate (FR-R3)', () => {
  it('escapes per channel and never HTML-escapes', () => {
    expect(renderTemplate('{{message.body}}', vars, 'whatsapp')).toBe(INJECTION)
    const md = renderTemplate('{{message.body}}', vars, 'markdown')
    expect(md).toBe(
      '\\*bold\\* \\_u\\_ \\`code\\` \\[link\\]\\(http://x\\) \\# h \\> q \\| \\~s\\~ \\\\ "q" \n\\{\\{evil\\}\\} <b\\>',
    )
    const json = renderTemplate('{"t":"{{message.body}}"}', vars, 'json')
    expect(JSON.parse(json)).toEqual({ t: INJECTION })
    // the rendered text is data: a nested tag in a value is not re-rendered
    expect(renderTemplate('{{message.body}}', { message: { body: '{{account.name}}' } }, 'whatsapp')).toBe(
      '{{account.name}}',
    )
  })

  it('unescaped tags are rewritten so nothing bypasses the channel escaping', () => {
    expect(renderTemplate('{{{message.body}}}', vars, 'json')).toBe(JSON.stringify(INJECTION).slice(1, -1))
    expect(renderTemplate('{{& message.body}}', vars, 'markdown')).toContain('\\*bold\\*')
    expect(renderTemplate('{{&message.body}}', vars, 'markdown')).not.toContain('*bold*')
  })

  it('renders numbers, booleans and missing values; sections work', () => {
    expect(
      renderTemplate('{{message.n}}-{{message.flag}}-{{message.none}}-{{message.missing}}', vars, 'whatsapp'),
    ).toBe('3-true--')
    expect(
      renderTemplate(
        '{{#message.flag}}yes{{/message.flag}}{{^message.none}}no{{/message.none}}',
        vars,
        'json',
      ),
    ).toBe('yesno')
  })

  it('caps name fields at 64 chars and the output at 4 096', () => {
    expect(renderTemplate('{{contact.display_name}}', vars, 'whatsapp')).toBe('A'.repeat(MAX_NAME_LENGTH))
    expect(renderTemplate('{{chat.name}}', vars, 'whatsapp')).toHaveLength(64)
    expect(renderTemplate('{{group.name}}', vars, 'whatsapp')).toHaveLength(64)
    expect(renderTemplate('{{account.name}}', vars, 'whatsapp')).toHaveLength(64)
    expect(vars.contact?.display_name).toHaveLength(100) // input untouched
    const long = renderTemplate(`${'x'.repeat(4000)}{{message.body}}{{message.body}}`, vars, 'whatsapp')
    expect(long).toHaveLength(MAX_RENDERED_LENGTH)
  })
})

describe('templateVars (docs/templates.md)', () => {
  const base = {
    event: makeEvent({ payload: { kind: 'image', caption: 'cap', mimeType: 'image/jpeg' } }),
    quoted: { body: 'quoted text' },
    contact: { id: SENDER, displayName: 'Asha K', pushName: 'asha' },
    contactPhone: null,
    chat: { id: CHAT, name: 'Asha', type: 'dm', automationState: 'active', unreadCount: 2 },
    account: ACCOUNT,
    facts: { tier: 'gold' },
    now: T0,
  }

  it('builds every namespace from the event, stores and clock in the account zone', () => {
    const v = templateVars(base)
    expect(v.event).toEqual({
      id: '01EVENT',
      type: 'message.received',
      chat_id: CHAT,
      sender_id: SENDER,
      occurred_at: T0.toISOString(),
      received_at: T0.toISOString(),
      is_backfill: false,
      is_from_me: false,
      origin: null,
    })
    expect(v.message).toEqual({
      id: '01EVENT',
      provider_id: 'P1',
      body: 'cap',
      type: 'image',
      media_mime: 'image/jpeg',
      quoted_body: 'quoted text',
      is_from_me: false,
      occurred_at: T0.toISOString(),
    })
    expect(v.contact).toEqual({ id: SENDER, display_name: 'Asha K', phone: null })
    expect(v.chat).toEqual({
      id: CHAT,
      name: 'Asha',
      type: 'dm',
      automation_state: 'active',
      unread_count: 2,
    })
    expect(v.group).toEqual({})
    expect(v.understand).toEqual({})
    expect(v.facts).toEqual({ tier: 'gold' })
    expect(v.account).toEqual({ name: 'Main Account', timezone: 'UTC', persona: '' })
    expect(v.now).toEqual({
      iso: T0.toISOString(),
      date: '2026-06-01',
      time: '10:00',
      weekday: 'Mon',
      hour: 10,
      business_hours: true,
    })
  })

  it('falls back to the push name, exposes the phone only when given, and handles groups and non-message events', () => {
    const v = templateVars({
      ...base,
      event: makeEvent({ type: 'group.participant_added', chatId: '120@g.us', payload: {} }),
      quoted: null,
      contact: { id: SENDER, displayName: null, pushName: 'asha' },
      contactPhone: '+4915112345678',
      chat: { id: '120@g.us', name: null, type: 'group', automationState: 'paused', unreadCount: 0 },
      now: new Date('2026-06-06T23:30:00Z'),
    })
    expect(v.message).toEqual({})
    expect(v.contact).toEqual({ id: SENDER, display_name: 'asha', phone: '+4915112345678' })
    expect(v.group).toEqual({ id: '120@g.us', name: '', description: null, participant_count: null })
    expect(v.chat?.name).toBe('')
    expect(v.now).toMatchObject({
      date: '2026-06-06',
      time: '23:30',
      weekday: 'Sat',
      hour: 23,
      business_hours: false,
    })
    const bare = templateVars({
      ...base,
      contact: null,
      chat: null,
      quoted: null,
      event: makeEvent({ payload: {} }),
    })
    expect(bare.contact).toEqual({})
    expect(bare.chat).toEqual({})
    expect(bare.message).toMatchObject({ body: '', type: 'unknown', media_mime: null, quoted_body: null })
    const zoned = templateVars({
      ...base,
      account: { ...ACCOUNT, timezone: 'Asia/Kolkata' },
      contact: { id: SENDER, displayName: null, pushName: null },
    })
    expect(zoned.now).toMatchObject({ time: '15:30', hour: 15, date: '2026-06-01' })
    expect(zoned.contact?.display_name).toBe('')
  })
})
