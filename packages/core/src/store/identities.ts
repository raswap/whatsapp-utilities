import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import type { AccountTables } from '../db/schema/account.js'
import type { IdentityHint } from '../events/types.js'
import { newId } from '../ids.js'
import type { Codec } from './codec.js'

export interface ResolvedIdentity {
  contactId: string
  created: boolean
  /** Set when this resolution merged two previously separate contacts. */
  mergedFrom?: string
}

export function jidKind(jid: string): 'phone' | 'lid' {
  return jid.endsWith('@lid') ? 'lid' : 'phone'
}

export function phoneFromJid(jid: string): string | undefined {
  const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(jid)
  return m ? `+${m[1]}` : undefined
}

/**
 * Maps every observed JID or LID to one canonical contact (PRD FR-M11). Phone numbers are stored
 * encrypted with a keyed hash for lookups.
 */
export class IdentityStore {
  constructor(
    private readonly db: Db,
    private readonly t: AccountTables,
    private readonly codec: Codec,
    private readonly schemaName: string,
  ) {}

  private aad(contactId: string) {
    return `contact_phone:${this.schemaName}:${contactId}`
  }

  async resolve(hint: IdentityHint): Promise<ResolvedIdentity> {
    const { identities, contacts } = this.t
    const existing = await this.db
      .select({ contactId: identities.contactId })
      .from(identities)
      .where(eq(identities.jid, hint.jid))
    let contactId = existing[0]?.contactId
    let created = false
    let mergedFrom: string | undefined

    const phone = hint.phone ?? phoneFromJid(hint.jid)
    if (!contactId && phone) {
      const byPhone = await this.db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.phoneHash, this.codec.hash(phone)))
      contactId = byPhone[0]?.id
    }
    if (!contactId && hint.sameAs) {
      const other = await this.db
        .select({ contactId: identities.contactId })
        .from(identities)
        .where(eq(identities.jid, hint.sameAs))
      contactId = other[0]?.contactId
    }
    if (!contactId) {
      contactId = newId()
      created = true
      await this.db.insert(contacts).values({
        id: contactId,
        pushName: hint.pushName ?? null,
        phoneEnc: phone ? this.codec.encrypt(phone, this.aad(contactId)) : null,
        phoneHash: phone ? this.codec.hash(phone) : null,
      })
    } else if (phone || hint.pushName) {
      await this.db
        .update(contacts)
        .set({
          ...(hint.pushName ? { pushName: hint.pushName } : {}),
          ...(phone
            ? {
                phoneEnc: sql`coalesce(${contacts.phoneEnc}, ${this.codec.encrypt(phone, this.aad(contactId))})`,
                phoneHash: this.codec.hash(phone),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contactId))
    }
    if (existing.length === 0) {
      await this.db
        .insert(identities)
        .values({ jid: hint.jid, contactId, kind: jidKind(hint.jid) })
        .onConflictDoNothing()
    }
    if (hint.sameAs) {
      const r = await this.link(hint.sameAs, contactId)
      if (r.mergedFrom) mergedFrom = r.mergedFrom
      contactId = r.contactId
    }
    return { contactId, created, ...(mergedFrom ? { mergedFrom } : {}) }
  }

  /**
   * Attaches `jid` to `contactId`, merging if `jid` already belonged to another contact.
   * Returns the surviving contact id, which may differ from the one passed in.
   */
  async link(jid: string, contactId: string): Promise<{ contactId: string; mergedFrom?: string }> {
    const { identities, contacts, messages, groupParticipants, events } = this.t
    const existing = await this.db
      .select({ contactId: identities.contactId })
      .from(identities)
      .where(eq(identities.jid, jid))
    const other = existing[0]?.contactId
    if (!other) {
      await this.db
        .insert(identities)
        .values({ jid, contactId, kind: jidKind(jid) })
        .onConflictDoNothing()
      return { contactId }
    }
    if (other === contactId) return { contactId }
    // Merge `other` into `contactId`: keep the older row (lower ULID) as canonical.
    const [keep, drop] = other < contactId ? [other, contactId] : [contactId, other]
    await this.db.update(identities).set({ contactId: keep }).where(eq(identities.contactId, drop))
    await this.db.update(messages).set({ senderId: keep }).where(eq(messages.senderId, drop))
    await this.db.update(events).set({ senderId: keep }).where(eq(events.senderId, drop))
    await this.db
      .update(groupParticipants)
      .set({ contactId: keep })
      .where(eq(groupParticipants.contactId, drop))
    const [dropRow] = await this.db.select().from(contacts).where(eq(contacts.id, drop))
    if (dropRow?.phoneHash) {
      await this.db
        .update(contacts)
        .set({
          phoneHash: sql`coalesce(${contacts.phoneHash}, ${dropRow.phoneHash})`,
          phoneEnc: dropRow.phoneEnc
            ? sql`coalesce(${contacts.phoneEnc}, ${this.codec.encrypt(this.codec.decrypt(dropRow.phoneEnc, this.aad(drop)), this.aad(keep))})`
            : contacts.phoneEnc,
          pushName: sql`coalesce(${contacts.pushName}, ${dropRow.pushName})`,
        })
        .where(eq(contacts.id, keep))
    }
    await this.db.delete(contacts).where(eq(contacts.id, drop))
    return { contactId: keep, mergedFrom: drop }
  }

  async jidsFor(contactId: string): Promise<string[]> {
    const rows = await this.db
      .select({ jid: this.t.identities.jid })
      .from(this.t.identities)
      .where(eq(this.t.identities.contactId, contactId))
    return rows.map((r) => r.jid)
  }

  async phoneOf(contactId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ enc: this.t.contacts.phoneEnc })
      .from(this.t.contacts)
      .where(eq(this.t.contacts.id, contactId))
    return row?.enc ? this.codec.decrypt(row.enc, this.aad(contactId)) : null
  }

  async contactsByIds(ids: string[]) {
    if (ids.length === 0) return []
    return this.db.select().from(this.t.contacts).where(inArray(this.t.contacts.id, ids))
  }
}
