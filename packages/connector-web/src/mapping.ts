import type { ChatType, EventType, IdentityHint, MessageKind, MessagePayload, RawEvent } from '@wamcp/core'
import type {
  Chat,
  Contact,
  GroupMetadata,
  GroupParticipant,
  MessageUserReceiptUpdate,
  ParticipantAction,
  WACallEvent,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
} from '@whiskeysockets/baileys'
import { getContentType, isJidGroup, isLidUser, jidNormalizedUser } from '@whiskeysockets/baileys'
import type Long from 'long'

export type Source = 'live' | 'history'

export function chatTypeOf(jid: string): ChatType {
  if (jid === 'status@broadcast') return 'status'
  if (jid.endsWith('@g.us')) return 'group'
  if (jid.endsWith('@broadcast')) return 'broadcast'
  if (jid.endsWith('@newsletter')) return 'channel'
  return 'dm'
}

export function tsToDate(ts: number | Long | null | undefined, fallback = new Date()): Date {
  if (ts === null || ts === undefined) return fallback
  const n = typeof ts === 'number' ? ts : (ts as Long).toNumber()
  return n > 0 ? new Date(n * 1000) : fallback
}

function norm(jid: string | null | undefined): string | undefined {
  return jid ? jidNormalizedUser(jid) : undefined
}

/** Resolves chat id and sender from a key, preferring phone-number JIDs and recording LID links. */
export function resolveKey(
  key: WAMessageKey,
  selfJid?: string,
): { chatId: string; senderJid: string | undefined; hints: IdentityHint[] } | null {
  const remote = norm(key.remoteJid)
  if (!remote) return null
  const hints: IdentityHint[] = []
  const remoteAlt = norm(key.remoteJidAlt)
  let chatId = remote
  if (isLidUser(remote) && remoteAlt && !isLidUser(remoteAlt)) {
    chatId = remoteAlt
    hints.push({ jid: remote, kind: 'lid', sameAs: remoteAlt })
  } else if (remoteAlt && isLidUser(remoteAlt)) {
    hints.push({ jid: remoteAlt, kind: 'lid', sameAs: remote })
  }
  let senderJid: string | undefined
  if (isJidGroup(chatId) || chatTypeOf(chatId) !== 'dm') {
    const p = norm(key.participant)
    const pAlt = norm(key.participantAlt)
    senderJid = p
    if (p && pAlt) {
      const [lid, pn] = isLidUser(p) ? [p, pAlt] : [pAlt, p]
      if (isLidUser(lid) && !isLidUser(pn)) {
        senderJid = pn
        hints.push({ jid: lid, kind: 'lid', sameAs: pn })
      }
    }
    if (key.fromMe && selfJid) senderJid = selfJid
  } else {
    senderJid = key.fromMe ? selfJid : chatId
  }
  return { chatId, senderJid, hints }
}

type Unwrapped = { content: NonNullable<WAMessage['message']>; ephemeral: boolean; viewOnce: boolean }

function unwrap(m: WAMessage['message']): Unwrapped | null {
  let content = m ?? null
  let ephemeral = false
  let viewOnce = false
  for (let i = 0; i < 4 && content; i++) {
    if (content.ephemeralMessage?.message) {
      ephemeral = true
      content = content.ephemeralMessage.message
    } else if (content.viewOnceMessage?.message) {
      viewOnce = true
      content = content.viewOnceMessage.message
    } else if (content.viewOnceMessageV2?.message) {
      viewOnce = true
      content = content.viewOnceMessageV2.message
    } else if (content.viewOnceMessageV2Extension?.message) {
      viewOnce = true
      content = content.viewOnceMessageV2Extension.message
    } else if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message
    } else if (content.editedMessage?.message) {
      content = content.editedMessage.message
    } else break
  }
  return content ? { content, ephemeral, viewOnce } : null
}

const PROTOCOL_REVOKE = 0
const PROTOCOL_EDIT = 14

/** Converts a Baileys message into zero or one RawEvent. Pure. */
export function messageToRaw(msg: WAMessage, opts: { source: Source; selfJid?: string }): RawEvent | null {
  const id = msg.key?.id
  if (!id) return null
  const resolved = resolveKey(msg.key, opts.selfJid)
  if (!resolved) return null
  const { chatId, senderJid, hints } = resolved
  const occurredAt = tsToDate(msg.messageTimestamp)
  const base = {
    chatId,
    chatType: chatTypeOf(chatId),
    ...(senderJid ? { senderJid } : {}),
    occurredAt,
    isFromMe: msg.key.fromMe === true,
    source: opts.source,
    identityHints: [
      ...hints,
      ...(senderJid && msg.pushName && !msg.key.fromMe
        ? [
            {
              jid: senderJid,
              kind: isLidUser(senderJid) ? ('lid' as const) : ('phone' as const),
              pushName: msg.pushName,
            },
          ]
        : []),
    ],
  }

  const un = unwrap(msg.message)
  if (!un) {
    // Undecryptable or stub-only message: keep it as a system message so the chat still shows activity.
    const stub = msg.messageStubType ?? null
    return {
      type: base.isFromMe ? 'message.sent' : 'message.received',
      providerId: id,
      ...base,
      payload: {
        kind: 'system',
        ...(stub !== null ? { stubType: stub, undecryptable: stub === 2 } : {}),
      } as MessagePayload,
    }
  }
  const { content, ephemeral, viewOnce } = un

  if (content.protocolMessage) {
    const p = content.protocolMessage
    const targetId = p.key?.id
    if (!targetId) return null
    if (p.type === PROTOCOL_EDIT && p.editedMessage) {
      const edited = unwrap(p.editedMessage)
      const body = edited ? extractBody(edited.content) : ''
      return { type: 'message.edited', providerId: targetId, ...base, payload: { body: body ?? '' } }
    }
    if (p.type === PROTOCOL_REVOKE)
      return { type: 'message.deleted', providerId: targetId, ...base, payload: {} }
    return null
  }

  if (content.reactionMessage) {
    const r = content.reactionMessage
    const targetId = r.key?.id
    if (!targetId || !senderJid) return null
    return {
      type: 'message.reaction',
      providerId: targetId,
      ...base,
      payload: { reactorJid: senderJid, emoji: r.text ? r.text : null },
    }
  }

  const ctype = getContentType(content)
  const kind = kindOf(ctype, content)
  const ctx = contextInfoOf(content)
  const payload: MessagePayload = {
    kind,
    ...(extractBody(content) !== null ? { body: extractBody(content) as string } : {}),
    ...(ctx?.stanzaId ? { quotedProviderId: ctx.stanzaId } : {}),
    ...(ctx?.mentionedJid?.length ? { mentions: ctx.mentionedJid.map((j) => jidNormalizedUser(j)) } : {}),
    ...(ctx?.isForwarded ? { isForwarded: true } : {}),
    ...(ephemeral ? { isEphemeral: true } : {}),
    ...(viewOnce || msg.key.isViewOnce ? { isViewOnce: true } : {}),
    ...(mimeOf(content) ? { mimeType: mimeOf(content) as string } : {}),
  }
  return { type: base.isFromMe ? 'message.sent' : 'message.received', providerId: id, ...base, payload }
}

type Content = NonNullable<WAMessage['message']>

function contextInfoOf(c: Content) {
  const ctype = getContentType(c)
  const inner = ctype
    ? (c[ctype] as
        | {
            contextInfo?: Content['extendedTextMessage'] extends infer T
              ? T extends { contextInfo?: infer C }
                ? C
                : never
              : never
          }
        | undefined)
    : undefined
  return inner && typeof inner === 'object' && 'contextInfo' in inner
    ? (inner.contextInfo ?? undefined)
    : undefined
}

export function extractBody(c: Content): string | null {
  if (c.conversation) return c.conversation
  if (c.extendedTextMessage?.text) return c.extendedTextMessage.text
  if (c.imageMessage?.caption) return c.imageMessage.caption
  if (c.videoMessage?.caption) return c.videoMessage.caption
  if (c.documentMessage?.caption) return c.documentMessage.caption
  if (c.pollCreationMessage?.name) return c.pollCreationMessage.name
  if (c.pollCreationMessageV2?.name) return c.pollCreationMessageV2.name
  if (c.pollCreationMessageV3?.name) return c.pollCreationMessageV3.name
  if (c.locationMessage) return c.locationMessage.name ?? c.locationMessage.address ?? null
  if (c.contactMessage?.displayName) return c.contactMessage.displayName
  return null
}

function kindOf(ctype: keyof Content | undefined, c: Content): MessageKind {
  switch (ctype) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text'
    case 'imageMessage':
      return 'image'
    case 'videoMessage':
      return 'video'
    case 'audioMessage':
      return c.audioMessage?.ptt ? 'voice' : 'audio'
    case 'documentMessage':
      return 'document'
    case 'stickerMessage':
      return 'sticker'
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location'
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'contact'
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return 'poll'
    case undefined:
      return 'unknown'
    default:
      return 'unknown'
  }
}

function mimeOf(c: Content): string | undefined {
  return (
    c.imageMessage?.mimetype ??
    c.videoMessage?.mimetype ??
    c.audioMessage?.mimetype ??
    c.documentMessage?.mimetype ??
    c.stickerMessage?.mimetype ??
    undefined
  )
}

/** Per-recipient receipts for our own messages. */
export function receiptToRaw(u: MessageUserReceiptUpdate, selfJid?: string): RawEvent[] {
  const resolved = resolveKey(u.key, selfJid)
  const id = u.key.id
  if (!resolved || !id || !u.receipt.userJid) return []
  const recipient = jidNormalizedUser(u.receipt.userJid)
  const out: RawEvent[] = []
  const mk = (status: 'delivered' | 'read' | 'played', ts: number | Long | null | undefined): RawEvent => ({
    type: 'message.status',
    providerId: id,
    chatId: resolved.chatId,
    chatType: chatTypeOf(resolved.chatId),
    occurredAt: tsToDate(ts),
    isFromMe: true,
    source: 'live',
    payload: { recipientJid: recipient, status },
  })
  if (u.receipt.receiptTimestamp) out.push(mk('delivered', u.receipt.receiptTimestamp))
  if (u.receipt.readTimestamp) out.push(mk('read', u.receipt.readTimestamp))
  if (u.receipt.playedTimestamp) out.push(mk('played', u.receipt.playedTimestamp))
  return out
}

const STATUS: Record<number, 'delivered' | 'read' | 'played' | undefined> = {
  3: 'delivered',
  4: 'read',
  5: 'played',
}

/** DM delivery status on our own messages arrives as a message update. */
export function statusUpdateToRaw(u: WAMessageUpdate, selfJid?: string): RawEvent | null {
  const status = typeof u.update.status === 'number' ? STATUS[u.update.status] : undefined
  const resolved = resolveKey(u.key, selfJid)
  if (!status || !resolved || !u.key.id || chatTypeOf(resolved.chatId) !== 'dm') return null
  return {
    type: 'message.status',
    providerId: u.key.id,
    chatId: resolved.chatId,
    chatType: 'dm',
    occurredAt: new Date(),
    isFromMe: true,
    source: 'live',
    payload: { recipientJid: resolved.chatId, status },
  }
}

export function callToRaw(c: WACallEvent): RawEvent | null {
  const type: EventType | null =
    c.status === 'offer'
      ? 'call.incoming'
      : c.status === 'timeout'
        ? 'call.missed'
        : c.status === 'reject'
          ? 'call.rejected'
          : null
  if (!type) return null
  const from = jidNormalizedUser(c.from)
  return {
    type,
    providerId: c.id,
    discriminator: c.status,
    chatId: c.isGroup && c.groupJid ? c.groupJid : from,
    chatType: c.isGroup ? 'group' : 'dm',
    senderJid: from,
    occurredAt: c.date,
    isFromMe: false,
    source: 'live',
    payload: { isVideo: c.isVideo === true, ...(c.callerPn ? { callerPn: c.callerPn } : {}) },
    identityHints: c.callerPn
      ? [{ jid: from, kind: isLidUser(from) ? 'lid' : 'phone', sameAs: jidNormalizedUser(c.callerPn) }]
      : [],
  }
}

const PARTICIPANT_EVENT: Record<ParticipantAction, EventType | null> = {
  add: 'group.participant_added',
  remove: 'group.participant_removed',
  promote: 'group.participant_promoted',
  demote: 'group.participant_demoted',
  modify: null,
}

export function participantsToRaw(u: {
  id: string
  author: string
  participants: GroupParticipant[]
  action: ParticipantAction
}): RawEvent[] {
  const type = PARTICIPANT_EVENT[u.action]
  if (!type) return []
  return u.participants.map((p) => ({
    type,
    providerId: `${u.id}:${u.action}:${p.id}:${Date.now()}`,
    chatId: u.id,
    chatType: 'group' as const,
    ...(u.author ? { senderJid: jidNormalizedUser(u.author) } : {}),
    occurredAt: new Date(),
    isFromMe: false,
    source: 'live' as const,
    payload: { participant: jidNormalizedUser(p.id), ...(p.phoneNumber ? { phone: p.phoneNumber } : {}) },
    identityHints:
      p.phoneNumber && isLidUser(p.id)
        ? [{ jid: jidNormalizedUser(p.id), kind: 'lid' as const, sameAs: jidNormalizedUser(p.phoneNumber) }]
        : [],
  }))
}

export function groupUpdateToRaw(g: Partial<GroupMetadata>): RawEvent[] {
  if (!g.id) return []
  const out: RawEvent[] = []
  const mk = (type: EventType, payload: Record<string, unknown>): RawEvent => ({
    type,
    chatId: g.id as string,
    chatType: 'group',
    ...(g.subject ? { chatName: g.subject } : {}),
    occurredAt: new Date(),
    isFromMe: false,
    source: 'live',
    payload,
  })
  if (g.subject !== undefined) out.push(mk('group.subject_changed', { subject: g.subject }))
  if (g.desc !== undefined) out.push(mk('group.description_changed', { description: g.desc }))
  if (g.announce !== undefined || g.restrict !== undefined)
    out.push(mk('group.settings_changed', { announce: g.announce, restrict: g.restrict }))
  return out
}

export function chatUpdateToRaw(c: Partial<Chat>): RawEvent[] {
  if (!c.id) return []
  const out: RawEvent[] = []
  const mk = (type: EventType, payload: Record<string, unknown>): RawEvent => ({
    type,
    chatId: c.id as string,
    chatType: chatTypeOf(c.id as string),
    ...(c.name ? { chatName: c.name } : {}),
    occurredAt: new Date(),
    isFromMe: true,
    source: 'live',
    payload,
  })
  if (c.archived !== undefined && c.archived !== null) out.push(mk('chat.archived', { archived: c.archived }))
  if (c.pinned !== undefined && c.pinned !== null) out.push(mk('chat.pinned', { pinned: Boolean(c.pinned) }))
  if (c.muteEndTime !== undefined && c.muteEndTime !== null)
    out.push(mk('chat.muted', { muteEndTime: c.muteEndTime }))
  if (c.unreadCount !== undefined && c.unreadCount !== null)
    out.push(mk('chat.unread_changed', { unread: c.unreadCount }))
  return out
}

export function contactToRaw(c: Partial<Contact>): RawEvent | null {
  if (!c.id) return null
  const id = jidNormalizedUser(c.id)
  const phone = c.phoneNumber ? toE164(c.phoneNumber) : isLidUser(id) ? undefined : toE164(id)
  const hints: IdentityHint[] = [
    {
      jid: id,
      kind: isLidUser(id) ? 'lid' : 'phone',
      ...(c.notify ? { pushName: c.notify } : {}),
      ...(phone ? { phone } : {}),
    },
  ]
  if (c.lid && !isLidUser(id)) hints.push({ jid: jidNormalizedUser(c.lid), kind: 'lid', sameAs: id })
  if (c.phoneNumber && isLidUser(id))
    hints.push({ jid: id, kind: 'lid', sameAs: jidNormalizedUser(c.phoneNumber) })
  return {
    type: 'contact.updated',
    senderJid: id,
    occurredAt: new Date(),
    isFromMe: false,
    source: 'live',
    payload: { name: c.name ?? null, pushName: c.notify ?? null },
    identityHints: hints,
  }
}

function toE164(pnJid: string): string | undefined {
  const m = /^(\d{6,15})@/.exec(pnJid)
  return m ? `+${m[1]}` : undefined
}
