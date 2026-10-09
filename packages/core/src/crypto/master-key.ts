import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const MASTER_KEY_BYTES = 32

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MasterKeyError'
  }
}

export interface MasterKey {
  /** First 8 hex chars of SHA-256 of the key; recorded on backups and ciphertexts. */
  id: string
  bytes: Buffer
  path: string
}

function keyId(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8)
}

export function generateMasterKey(path: string): MasterKey {
  const abs = resolve(path)
  if (existsSync(abs)) throw new MasterKeyError(`master key already exists at ${abs}; refusing to overwrite`)
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
  const bytes = randomBytes(MASTER_KEY_BYTES)
  writeFileSync(abs, bytes.toString('base64'), { mode: 0o600, flag: 'wx' })
  chmodSync(abs, 0o600)
  return { id: keyId(bytes), bytes, path: abs }
}

export interface LoadOptions {
  /** Directory that must not contain the key file (the data dir). */
  forbidUnder?: string
}

export function loadMasterKey(path: string, opts: LoadOptions = {}): MasterKey {
  const abs = resolve(path)
  if (!existsSync(abs)) throw new MasterKeyError(`master key file not found at ${abs}; run "wamcp init"`)
  const st = statSync(abs)
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new MasterKeyError(
      `master key file ${abs} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`,
    )
  }
  if (opts.forbidUnder) {
    const data = resolve(opts.forbidUnder)
    if (abs === data || abs.startsWith(`${data}/`)) {
      throw new MasterKeyError(`master key file must not live inside the data directory (${data})`)
    }
  }
  const bytes = Buffer.from(readFileSync(abs, 'utf8').trim(), 'base64')
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(
      `master key file ${abs} must decode to ${MASTER_KEY_BYTES} bytes, got ${bytes.length}`,
    )
  }
  return { id: keyId(bytes), bytes, path: abs }
}
