import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { MasterKey } from './master-key.js'

/**
 * Versioned AES-256-GCM envelope: v1.<keyId>.<iv b64>.<ciphertext b64>.<tag b64>
 * The associated data binds a ciphertext to its purpose (for example "session_state:acct_main")
 * so a value cannot be moved between columns or accounts.
 */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

const VERSION = 'v1'

export function encrypt(key: MasterKey, plaintext: Buffer | string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  const ct = Buffer.concat([cipher.update(data), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, key.id, iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join('.')
}

export function decrypt(key: MasterKey, envelope: string, aad: string): Buffer {
  const parts = envelope.split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) throw new CryptoError('malformed ciphertext envelope')
  const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string]
  if (keyId !== key.id)
    throw new CryptoError(`ciphertext was encrypted with key ${keyId}, current key is ${key.id}`)
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, Buffer.from(ivB64, 'base64'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()])
  } catch {
    throw new CryptoError('ciphertext authentication failed')
  }
}

export function decryptString(key: MasterKey, envelope: string, aad: string): string {
  return decrypt(key, envelope, aad).toString('utf8')
}

export function envelopeKeyId(envelope: string): string | undefined {
  const parts = envelope.split('.')
  return parts.length === 5 && parts[0] === VERSION ? parts[1] : undefined
}
