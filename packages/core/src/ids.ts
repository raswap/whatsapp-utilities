import { randomBytes, randomInt } from 'node:crypto'
import { monotonicFactory } from 'ulid'

const ulid = monotonicFactory()

/** Time-ordered unique id for events, actions, approvals. */
export function newId(): string {
  return ulid()
}

/**
 * WhatsApp Web style message id, chosen by us before sending so that the action row and the
 * wire message share one identifier (PRD FR-X1). Shape mirrors what WhatsApp Web clients generate.
 */
export function newMessageId(): string {
  return `3EB0${randomBytes(14).toString('hex').toUpperCase()}`
}

/** Short approval code: 6 chars from a base32 alphabet without ambiguous glyphs (~30 bits). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function newApprovalCode(): string {
  let out = ''
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

/** Postgres schema name for an account id. */
export function accountSchemaName(accountId: string): string {
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(accountId)) throw new Error(`invalid account id: ${accountId}`)
  return `acct_${accountId}`
}
