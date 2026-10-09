import type { WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import {
  callToRaw,
  chatTypeOf,
  chatUpdateToRaw,
  contactToRaw,
  extractBody,
  groupUpdateToRaw,
  messageToRaw,
  participantsToRaw,
  receiptToRaw,
  resolveKey,
  statusUpdateToRaw,
  tsToDate,
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

  it('resolves keys: broadcast and newsletter chat types, LID alt on phone remote, group from-me sender', () => {
    expect(chatTypeOf('x@broadcast')).toBe('broadcast')
    expect(resolveKey({ remoteJid: '1@s.whatsapp.net', remoteJidAlt: '5@lid', id: 'x' })?.hints).toEqual([
      { jid: '5@lid', kind: 'lid', sameAs: '1@s.whatsapp.net' },
    ])
    expect(
      resolveKey(
        {
          remoteJid: '1@g.us',
          participant: '2@s.whatsapp.net',
          participantAlt: '3@lid',
          fromMe: true,
          id: 'x',
        },
        'me@s.whatsapp.net',
      ),
    ).toMatchObject({ senderJid: 'me@s.whatsapp.net', hints: [{ jid: '3@lid', sameAs: '2@s.whatsapp.net' }] })
    // both participant ids are phone jids: no link recorded
    expect(
      resolveKey({
        remoteJid: '1@g.us',
        participant: '2@s.whatsapp.net',
        participantAlt: '4@s.whatsapp.net',
        id: 'x',
      }),
    ).toMatchObject({ senderJid: '2@s.whatsapp.net', hints: [] })
    expect(resolveKey({ remoteJid: '1@s.whatsapp.net', fromMe: true, id: 'x' })?.senderJid).toBeUndefined()
  })

  it('tsToDate handles Long, zero and missing timestamps', () => {
    const fb = new Date(0)
    expect(tsToDate(undefined, fb)).toBe(fb)
    expect(tsToDate(0, fb)).toBe(fb)
    expect(tsToDate({ toNumber: () => T } as never).getTime()).toBe(T * 1000)
  })

  it('messageToRaw returns null without id, remote jid, or protocol target', () => {
    expect(messageToRaw({ key: {} } as WAMessage, { source: 'live' })).toBeNull()
    expect(messageToRaw({ key: { id: 'x' } } as WAMessage, { source: 'live' })).toBeNull()
    const noTarget = {
      key: { remoteJid: 'a@s.whatsapp.net', id: 'P' },
      message: { protocolMessage: { type: 0 } },
    } as unknown as WAMessage
    expect(messageToRaw(noTarget, { source: 'live' })).toBeNull()
    const otherProto = {
      key: { remoteJid: 'a@s.whatsapp.net', id: 'P' },
      message: { protocolMessage: { type: 3, key: { id: 'ORIG' } } },
    } as unknown as WAMessage
    expect(messageToRaw(otherProto, { source: 'live' })).toBeNull()
    const editNoBody = {
      key: { remoteJid: 'a@s.whatsapp.net', id: 'P' },
      message: { protocolMessage: { type: 14, key: { id: 'ORIG' }, editedMessage: { stickerMessage: {} } } },
    } as unknown as WAMessage
    expect(messageToRaw(editNoBody, { source: 'live' })?.payload).toEqual({ body: '' })
    const reactionNoTarget = {
      key: { remoteJid: 'a@s.whatsapp.net', id: 'R' },
      message: { reactionMessage: { text: '' } },
    } as unknown as WAMessage
    expect(messageToRaw(reactionNoTarget, { source: 'live' })).toBeNull()
  })

  it('stub-less undecryptable messages and from-me reactions with empty text', () => {
    const noStub = {
      key: { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: 'S' },
      pushName: 'me',
    } as WAMessage
    expect(messageToRaw(noStub, { source: 'live' })).toMatchObject({
      type: 'message.sent',
      payload: { kind: 'system' },
    })
    const removed = {
      key: { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: 'R' },
      message: { reactionMessage: { key: { id: 'ORIG' }, text: '' } },
    } as unknown as WAMessage
    expect(messageToRaw(removed, { source: 'live', selfJid: 'me@s.whatsapp.net' })?.payload).toEqual({
      reactorJid: 'me@s.whatsapp.net',
      emoji: null,
    })
  })

  it('unwraps every wrapper kind and classifies every content kind', () => {
    const wrap = (message: Record<string, unknown>, wrapper: string) =>
      messageToRaw(
        {
          key: { remoteJid: 'a@s.whatsapp.net', id: 'W', isViewOnce: true },
          message: { [wrapper]: { message } },
        } as never,
        { source: 'live' },
      )?.payload
    expect(wrap({ videoMessage: { caption: 'v', mimetype: 'video/mp4' } }, 'viewOnceMessage')).toMatchObject({
      kind: 'video',
      body: 'v',
      isViewOnce: true,
      mimeType: 'video/mp4',
    })
    expect(
      wrap({ documentMessage: { caption: 'd', mimetype: 'application/pdf' } }, 'viewOnceMessageV2Extension'),
    ).toMatchObject({ kind: 'document', body: 'd' })
    expect(wrap({ documentMessage: { fileName: 'x' } }, 'documentWithCaptionMessage')).toMatchObject({
      kind: 'document',
    })
    expect(wrap({ audioMessage: { mimetype: 'audio/mp4' } }, 'editedMessage')).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/mp4',
    })

    const kind = (message: Record<string, unknown>) =>
      messageToRaw({ key: { remoteJid: 'a@s.whatsapp.net', id: 'K' }, message } as never, { source: 'live' })
        ?.payload
    expect(kind({ stickerMessage: { mimetype: 'image/webp' } })).toMatchObject({ kind: 'sticker' })
    expect(kind({ locationMessage: { address: 'addr' } })).toMatchObject({ kind: 'location', body: 'addr' })
    expect(kind({ locationMessage: { name: 'home', address: 'addr' } })).toMatchObject({ body: 'home' })
    expect(kind({ locationMessage: {} })).toEqual({ kind: 'location' })
    expect(kind({ liveLocationMessage: {} })).toMatchObject({ kind: 'location' })
    expect(kind({ contactMessage: { displayName: 'Bob' } })).toMatchObject({ kind: 'contact', body: 'Bob' })
    expect(kind({ contactsArrayMessage: {} })).toMatchObject({ kind: 'contact' })
    expect(kind({ pollCreationMessage: { name: 'p1' } })).toMatchObject({ kind: 'poll', body: 'p1' })
    expect(kind({ pollCreationMessageV2: { name: 'p2' } })).toMatchObject({ kind: 'poll', body: 'p2' })
    expect(kind({ pollCreationMessageV3: { name: 'p3' } })).toMatchObject({ kind: 'poll', body: 'p3' })
    expect(kind({ senderKeyDistributionMessage: {} })).toMatchObject({ kind: 'unknown' })
    expect(extractBody({ imageMessage: {} } as never)).toBeNull()
  })

  it('receipts: missing user jid or id yields nothing; played milestone', () => {
    expect(receiptToRaw({ key: { remoteJid: '1@g.us', id: 'M' }, receipt: {} })).toEqual([])
    expect(receiptToRaw({ key: { remoteJid: '1@g.us' }, receipt: { userJid: 'b@s.whatsapp.net' } })).toEqual(
      [],
    )
    const rs = receiptToRaw({
      key: { remoteJid: '1@g.us', id: 'M' },
      receipt: { userJid: 'b@s.whatsapp.net', playedTimestamp: T },
    })
    expect(rs.map((r) => (r.payload as { status: string }).status)).toEqual(['played'])
  })

  it('status updates ignore unknown statuses, groups and missing ids', () => {
    const key = { remoteJid: 'a@s.whatsapp.net', fromMe: true, id: 'M' }
    expect(statusUpdateToRaw({ key, update: { status: 1 } })).toBeNull()
    expect(statusUpdateToRaw({ key, update: {} })).toBeNull()
    expect(statusUpdateToRaw({ key: { ...key, id: undefined }, update: { status: 3 } })).toBeNull()
    expect(statusUpdateToRaw({ key: { ...key, remoteJid: '1@g.us' }, update: { status: 3 } })).toBeNull()
    expect(statusUpdateToRaw({ key, update: { status: 3 } })?.payload).toMatchObject({ status: 'delivered' })
  })

  it('calls: missed, rejected, group calls and callerPn links', () => {
    const base = { chatId: 'a@s.whatsapp.net', from: '9@lid', id: 'C', date: new Date(), offline: false }
    expect(callToRaw({ ...base, status: 'timeout' })?.type).toBe('call.missed')
    const rej = callToRaw({
      ...base,
      status: 'reject',
      isGroup: true,
      groupJid: '1@g.us',
      callerPn: '919@s.whatsapp.net',
    })
    expect(rej).toMatchObject({
      type: 'call.rejected',
      chatId: '1@g.us',
      chatType: 'group',
      payload: { isVideo: false, callerPn: '919@s.whatsapp.net' },
      identityHints: [{ jid: '9@lid', kind: 'lid', sameAs: '919@s.whatsapp.net' }],
    })
    expect(callToRaw({ ...base, status: 'offer', isGroup: true })?.chatId).toBe('9@lid')
  })

  it('participants: modify is ignored; no author or phone number', () => {
    expect(
      participantsToRaw({ id: '1@g.us', author: 'a@s.whatsapp.net', action: 'modify', participants: [] }),
    ).toEqual([])
    const [p] = participantsToRaw({
      id: '1@g.us',
      author: '',
      action: 'remove',
      participants: [{ id: '2@s.whatsapp.net' }],
    })
    expect(p).toMatchObject({
      type: 'group.participant_removed',
      payload: { participant: '2@s.whatsapp.net' },
      identityHints: [],
    })
    expect(p?.senderJid).toBeUndefined()
    expect(
      participantsToRaw({
        id: '1@g.us',
        author: '',
        action: 'promote',
        participants: [{ id: '2@s.whatsapp.net' }],
      })[0]?.type,
    ).toBe('group.participant_promoted')
    expect(
      participantsToRaw({
        id: '1@g.us',
        author: '',
        action: 'demote',
        participants: [{ id: '2@s.whatsapp.net' }],
      })[0]?.type,
    ).toBe('group.participant_demoted')
  })

  it('group and chat updates emit one event per changed field', () => {
    expect(groupUpdateToRaw({})).toEqual([])
    expect(groupUpdateToRaw({ id: '1@g.us' })).toEqual([])
    const g = groupUpdateToRaw({ id: '1@g.us', subject: 'S', desc: 'D', announce: true })
    expect(g.map((e) => e.type)).toEqual([
      'group.subject_changed',
      'group.description_changed',
      'group.settings_changed',
    ])
    expect(g[0]?.chatName).toBe('S')
    expect(groupUpdateToRaw({ id: '1@g.us', restrict: false })[0]?.payload).toEqual({
      announce: undefined,
      restrict: false,
    })

    expect(chatUpdateToRaw({})).toEqual([])
    expect(
      chatUpdateToRaw({
        id: 'a@s.whatsapp.net',
        archived: null,
        pinned: null,
        muteEndTime: null,
        unreadCount: null,
      }),
    ).toEqual([])
    const c = chatUpdateToRaw({
      id: 'a@s.whatsapp.net',
      name: 'N',
      archived: true,
      pinned: 5,
      muteEndTime: 9,
      unreadCount: 2,
    })
    expect(c.map((e) => [e.type, e.payload])).toEqual([
      ['chat.archived', { archived: true }],
      ['chat.pinned', { pinned: true }],
      ['chat.muted', { muteEndTime: 9 }],
      ['chat.unread_changed', { unread: 2 }],
    ])
    expect(c[0]?.chatName).toBe('N')
  })

  it('contacts: LID ids, explicit phone numbers, and missing ids', () => {
    expect(contactToRaw({})).toBeNull()
    const lid = contactToRaw({ id: '5@lid', phoneNumber: '919999000001@s.whatsapp.net', name: 'Asha' })
    expect(lid?.identityHints).toEqual([
      { jid: '5@lid', kind: 'lid', phone: '+919999000001' },
      { jid: '5@lid', kind: 'lid', sameAs: '919999000001@s.whatsapp.net' },
    ])
    expect(lid?.payload).toEqual({ name: 'Asha', pushName: null })
    expect(contactToRaw({ id: '7@lid' })?.identityHints).toEqual([{ jid: '7@lid', kind: 'lid' }])
    expect(contactToRaw({ id: 'abc@s.whatsapp.net' })?.identityHints).toEqual([
      { jid: 'abc@s.whatsapp.net', kind: 'phone' },
    ])
  })
})
