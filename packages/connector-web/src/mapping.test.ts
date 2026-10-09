import type { WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import {
  callToRaw,
  chatTypeOf,
  contactToRaw,
  messageToRaw,
  participantsToRaw,
  receiptToRaw,
  resolveKey,
  statusUpdateToRaw,
} from './mapping.js'

const T = 1_780_000_000 // seconds

describe('mapping', () => {
  it('maps a plain DM text', () => {
    const m = {
      key: { remoteJid: '919999000001@s.whatsapp.net', fromMe: false, id: 'ABC' },
      message: { conversation: 'hello' },
      messageTimestamp: T,
      pushName: 'Asha',
    } as WAMessage
    const r = messageToRaw(m, { source: 'live', selfJid: 'me@s.whatsapp.net' })
    expect(r).toMatchObject({
      type: 'message.received',
      providerId: 'ABC',
      chatId: '919999000001@s.whatsapp.net',
      chatType: 'dm',
      senderJid: '919999000001@s.whatsapp.net',
      isFromMe: false,
      source: 'live',
      payload: { kind: 'text', body: 'hello' },
    })
    expect(r?.occurredAt.getTime()).toBe(T * 1000)
    expect(r?.identityHints).toEqual([
      { jid: '919999000001@s.whatsapp.net', kind: 'phone', pushName: 'Asha' },
    ])
  })

  it('maps a LID-addressed DM to the phone JID chat and links the LID', () => {
    const m = {
      key: {
        remoteJid: '5551@lid',
        remoteJidAlt: '919999000002@s.whatsapp.net',
        fromMe: false,
        id: 'L1',
        addressingMode: 'lid',
      },
      message: {
        extendedTextMessage: {
          text: 'via lid',
          contextInfo: { stanzaId: 'Q1', mentionedJid: ['me@s.whatsapp.net'], isForwarded: true },
        },
      },
      messageTimestamp: T,
    } as unknown as WAMessage
    const r = messageToRaw(m, { source: 'live' })
    expect(r?.chatId).toBe('919999000002@s.whatsapp.net')
    expect(r?.identityHints?.[0]).toEqual({
      jid: '5551@lid',
      kind: 'lid',
      sameAs: '919999000002@s.whatsapp.net',
    })
    expect(r?.payload).toMatchObject({
      kind: 'text',
      body: 'via lid',
      quotedProviderId: 'Q1',
      mentions: ['me@s.whatsapp.net'],
      isForwarded: true,
    })
  })

  it('maps group messages with participant and participantAlt', () => {
    const m = {
      key: {
        remoteJid: '1203@g.us',
        fromMe: false,
        id: 'G1',
        participant: '7777@lid',
        participantAlt: '919999000003@s.whatsapp.net',
      },
      message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } },
      messageTimestamp: T,
    } as unknown as WAMessage
    const r = messageToRaw(m, { source: 'history' })
    expect(r).toMatchObject({
      chatType: 'group',
      senderJid: '919999000003@s.whatsapp.net',
      source: 'history',
      payload: { kind: 'image', body: 'look', mimeType: 'image/jpeg' },
    })
    expect(r?.identityHints?.[0]).toEqual({
      jid: '7777@lid',
      kind: 'lid',
      sameAs: '919999000003@s.whatsapp.net',
    })
  })

  it('from-me messages are message.sent with the self jid as sender', () => {
    const m = {
      key: { remoteJid: '919999000001@s.whatsapp.net', fromMe: true, id: '3EB0AA' },
      message: { conversation: 'reply' },
      messageTimestamp: T,
    } as WAMessage
    const r = messageToRaw(m, { source: 'live', selfJid: 'me@s.whatsapp.net' })
    expect(r).toMatchObject({ type: 'message.sent', isFromMe: true, senderJid: 'me@s.whatsapp.net' })
  })

  it('unwraps ephemeral and view-once wrappers, and voice notes are voice', () => {
    const m = {
      key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'E1' },
      message: {
        ephemeralMessage: {
          message: { viewOnceMessageV2: { message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } } } },
        },
      },
      messageTimestamp: T,
    } as unknown as WAMessage
    expect(messageToRaw(m, { source: 'live' })?.payload).toMatchObject({
      kind: 'voice',
      isEphemeral: true,
      isViewOnce: true,
    })
  })

  it('protocol edit and revoke map to edited and deleted on the target id', () => {
    const edit = {
      key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'P1' },
      message: {
        protocolMessage: { type: 14, key: { id: 'ORIG' }, editedMessage: { conversation: 'fixed text' } },
      },
      messageTimestamp: T,
    } as unknown as WAMessage
    expect(messageToRaw(edit, { source: 'live' })).toMatchObject({
      type: 'message.edited',
      providerId: 'ORIG',
      payload: { body: 'fixed text' },
    })
    const revoke = {
      key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'P2' },
      message: { protocolMessage: { type: 0, key: { id: 'ORIG' } } },
      messageTimestamp: T,
    } as unknown as WAMessage
    expect(messageToRaw(revoke, { source: 'live' })).toMatchObject({
      type: 'message.deleted',
      providerId: 'ORIG',
    })
  })

  it('reactions map to message.reaction with the reactor', () => {
    const m = {
      key: { remoteJid: '1203@g.us', fromMe: false, id: 'R1', participant: 'b@s.whatsapp.net' },
      message: { reactionMessage: { key: { id: 'ORIG' }, text: '👍' } },
      messageTimestamp: T,
    } as unknown as WAMessage
    expect(messageToRaw(m, { source: 'live' })).toMatchObject({
      type: 'message.reaction',
      providerId: 'ORIG',
      payload: { reactorJid: 'b@s.whatsapp.net', emoji: '👍' },
    })
  })

  it('undecryptable stubs become system messages flagged undecryptable', () => {
    const m = {
      key: { remoteJid: 'a@s.whatsapp.net', fromMe: false, id: 'S1' },
      messageStubType: 2,
      messageTimestamp: T,
    } as unknown as WAMessage
    expect(messageToRaw(m, { source: 'live' })?.payload).toMatchObject({
      kind: 'system',
      undecryptable: true,
    })
  })

  it('receipts produce one status event per milestone; DM status updates map too', () => {
    const rs = receiptToRaw(
      {
        key: { remoteJid: '1203@g.us', fromMe: true, id: 'M1' },
        receipt: { userJid: 'b@s.whatsapp.net', receiptTimestamp: T, readTimestamp: T + 5 },
      },
      'me@s.whatsapp.net',
    )
    expect(rs.map((r) => (r.payload as { status: string }).status)).toEqual(['delivered', 'read'])
    const su = statusUpdateToRaw(
      { key: { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: 'M2' }, update: { status: 4 } },
      'me@s.whatsapp.net',
    )
    expect(su).toMatchObject({
      type: 'message.status',
      providerId: 'M2',
      payload: { recipientJid: 'a@s.whatsapp.net', status: 'read' },
    })
  })

  it('calls, participants, contacts, chat types', () => {
    expect(
      callToRaw({
        chatId: 'a@s.whatsapp.net',
        from: 'a@s.whatsapp.net',
        id: 'C1',
        date: new Date(),
        status: 'offer',
        offline: false,
        isVideo: true,
      }),
    ).toMatchObject({ type: 'call.incoming', payload: { isVideo: true } })
    expect(
      callToRaw({
        chatId: 'a@s.whatsapp.net',
        from: 'a@s.whatsapp.net',
        id: 'C1',
        date: new Date(),
        status: 'accept',
        offline: false,
      }),
    ).toBeNull()
    const ps = participantsToRaw({
      id: '1203@g.us',
      author: 'admin@s.whatsapp.net',
      action: 'add',
      participants: [{ id: '9@lid', phoneNumber: '919999000009@s.whatsapp.net' }],
    })
    expect(ps[0]).toMatchObject({
      type: 'group.participant_added',
      chatId: '1203@g.us',
      payload: { participant: '9@lid' },
    })
    expect(ps[0]?.identityHints?.[0]).toMatchObject({ jid: '9@lid', sameAs: '919999000009@s.whatsapp.net' })
    const c = contactToRaw({ id: '919999000001@s.whatsapp.net', lid: '5551@lid', notify: 'Asha' })
    expect(c?.identityHints).toEqual([
      { jid: '919999000001@s.whatsapp.net', kind: 'phone', pushName: 'Asha', phone: '+919999000001' },
      { jid: '5551@lid', kind: 'lid', sameAs: '919999000001@s.whatsapp.net' },
    ])
    expect(chatTypeOf('status@broadcast')).toBe('status')
    expect(chatTypeOf('x@newsletter')).toBe('channel')
    expect(resolveKey({ remoteJid: undefined } as never)).toBeNull()
  })
})
