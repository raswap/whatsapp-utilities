import { createHmac } from 'node:crypto'
import { decryptString, encrypt } from '../crypto/aead.js'
import type { MasterKey } from '../crypto/master-key.js'

/** Encrypts sensitive columns and produces deterministic lookup hashes for them. */
export interface Codec {
  encrypt(plaintext: string, aad: string): string
  decrypt(envelope: string, aad: string): string
  /** Keyed hash for equality lookups (phone numbers). */
  hash(value: string): string
}

export function codecFor(key: MasterKey): Codec {
  return {
    encrypt: (p, aad) => encrypt(key, p, aad),
    decrypt: (e, aad) => decryptString(key, e, aad),
    hash: (v) => createHmac('sha256', key.bytes).update(v).digest('hex'),
  }
}

/** Test-only codec with no secrecy; never use outside tests. */
export const plainCodec: Codec = {
  encrypt: (p) => `plain:${p}`,
  decrypt: (e) => e.replace(/^plain:/, ''),
  hash: (v) => `h:${v}`,
}
