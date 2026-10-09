export const EVENT_TYPES = [
  'message.received',
  'message.sent',
  'message.edited',
  'message.deleted',
  'message.reaction',
  'message.status',
  'message.transcribed',
  'chat.opened',
  'chat.archived',
  'chat.pinned',
  'chat.muted',
  'chat.unread_changed',
  'group.created',
  'group.participant_added',
  'group.participant_removed',
  'group.participant_promoted',
  'group.participant_demoted',
  'group.subject_changed',
  'group.description_changed',
  'group.settings_changed',
  'group.left',
  'contact.updated',
  'identity.linked',
  'presence.updated',
  'call.incoming',
  'call.missed',
  'call.rejected',
  'connection.state',
  'connector.paused',
  'connector.resumed',
  'device.linked',
  'reconciliation.gap',
  'subscription.lagged',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export type ChatType = 'dm' | 'group' | 'community' | 'broadcast' | 'channel' | 'status'
export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'reaction'
  | 'system'
  | 'unknown'
export type Origin = 'self_system' | 'other_device'

export interface MessagePayload {
  kind: MessageKind
  body?: string
  caption?: string
  mediaRef?: string
  mimeType?: string
  quotedProviderId?: string
  mentions?: string[]
  isForwarded?: boolean
  isEphemeral?: boolean
  isViewOnce?: boolean
}
export interface StatusPayload {
  recipientJid: string
  status: 'delivered' | 'read' | 'played'
}
export interface ReactionPayload {
  reactorJid: string
  emoji: string | null
}
export interface EditPayload {
  body: string
}
export interface ConnectionPayload {
  state:
    | 'connecting'
    | 'pairing'
    | 'connected'
    | 'reconnecting'
    | 'conflict_wait'
    | 'degraded'
    | 'stale'
    | 'logged_out'
    | 'disconnected'
  reason?: string
}
export interface IdentityLinkedPayload {
  contactId: string
  jids: string[]
  mergedFrom?: string
}
export interface LaggedPayload {
  dropped: number
  resumeCursor: number
}
export type EventPayload =
  | MessagePayload
  | StatusPayload
  | ReactionPayload
  | EditPayload
  | ConnectionPayload
  | IdentityLinkedPayload
  | LaggedPayload
  | Record<string, unknown>

export interface IdentityHint {
  jid: string
  kind: 'phone' | 'lid'
  /** Another JID known to belong to the same person. */
  sameAs?: string
  pushName?: string
  /** E.164 phone when known; encrypted before storage. */
  phone?: string
}

/** What a connector hands to the pipeline. Nothing here has touched the database yet. */
export interface RawEvent {
  type: EventType
  providerId?: string
  discriminator?: string
  chatId?: string
  chatType?: ChatType
  chatName?: string
  senderJid?: string
  occurredAt: Date
  isFromMe: boolean
  /** 'history' for pairing-time sync or explicit history requests; 'live' otherwise. */
  source: 'live' | 'history'
  payload: EventPayload
  identityHints?: IdentityHint[]
}

/** The persisted envelope (PRD §7.2). */
export interface StoredEvent {
  cursor: number
  id: string
  accountId: string
  type: EventType
  providerId: string | null
  discriminator: string
  chatId: string | null
  senderId: string | null
  seq: number | null
  occurredAt: Date
  receivedAt: Date
  isBackfill: boolean
  isFromMe: boolean
  origin: Origin | null
  payload: EventPayload
}

export const MESSAGE_TYPES: ReadonlySet<EventType> = new Set(['message.received', 'message.sent'])
export const PERSISTED_TYPES_EXEMPT: ReadonlySet<EventType> = new Set(['presence.updated'])

export function discriminatorFor(raw: RawEvent): string {
  if (raw.discriminator) return raw.discriminator
  switch (raw.type) {
    case 'message.status': {
      const p = raw.payload as StatusPayload
      return `${p.recipientJid}:${p.status}`
    }
    case 'message.reaction': {
      const p = raw.payload as ReactionPayload
      return `${p.reactorJid}:${p.emoji ?? ''}`
    }
    default:
      return ''
  }
}
