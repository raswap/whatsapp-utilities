import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CryptoError, decryptString, encrypt, envelopeKeyId } from './aead.js'
import { generateMasterKey, loadMasterKey, MasterKeyError } from './master-key.js'

const dir = mkdtempSync(join(tmpdir(), 'wamcp-key-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('master key', () => {
  it('generates a 0600 key file and reloads it with the same id', () => {
    const p = join(dir, 'master.key')
    const k = generateMasterKey(p)
    expect(k.bytes.length).toBe(32)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    const k2 = loadMasterKey(p)
    expect(k2.id).toBe(k.id)
    expect(k2.bytes.equals(k.bytes)).toBe(true)
  })
  it('refuses to overwrite an existing key', () => {
    const p = join(dir, 'master.key')
    expect(() => generateMasterKey(p)).toThrow(MasterKeyError)
  })
  it('rejects a key file that others can read', () => {
    const p = join(dir, 'loose.key')
    writeFileSync(p, Buffer.alloc(32, 1).toString('base64'), { mode: 0o644 })
    expect(() => loadMasterKey(p)).toThrow(/readable by others/)
  })
  it('rejects a key inside the data directory', () => {
    const data = join(dir, 'data')
    const p = join(data, 'master.key')
    generateMasterKey(p)
    expect(() => loadMasterKey(p, { forbidUnder: data })).toThrow(/inside the data directory/)
  })
  it('rejects a wrong-length key', () => {
    const p = join(dir, 'short.key')
    writeFileSync(p, Buffer.alloc(16, 1).toString('base64'), { mode: 0o600 })
    expect(() => loadMasterKey(p)).toThrow(/32 bytes/)
  })
})

describe('aead', () => {
  const key = generateMasterKey(join(dir, 'aead.key'))
  it('round-trips with matching associated data', () => {
    const env = encrypt(key, 'hello', 'session_state:acct_main')
    expect(envelopeKeyId(env)).toBe(key.id)
    expect(decryptString(key, env, 'session_state:acct_main')).toBe('hello')
  })
  it('fails when associated data differs (value moved between accounts)', () => {
    const env = encrypt(key, 'hello', 'session_state:acct_main')
    expect(() => decryptString(key, env, 'session_state:acct_other')).toThrow(CryptoError)
  })
  it('fails on tampering', () => {
    const env = encrypt(key, 'hello', 'x')
    const parts = env.split('.')
    parts[3] = Buffer.from('tampered!').toString('base64')
    expect(() => decryptString(key, parts.join('.'), 'x')).toThrow(CryptoError)
  })
  it('fails with a different key and names the key id', () => {
    const other = generateMasterKey(join(dir, 'other.key'))
    const env = encrypt(key, 'hello', 'x')
    expect(() => decryptString(other, env, 'x')).toThrow(new RegExp(key.id))
  })
})
