import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import type { Clock } from '../clock.js'
import type { Db } from '../db/client.js'
import { tokens } from '../db/schema/operator.js'
import { newId } from '../ids.js'

export const SCOPES = [
  'read:messages',
  'read:contacts',
  'read:media',
  'read:audit',
  'read:rules',
  'raw',
  'send',
  'llm',
  'rules',
  'approver',
  'admin',
] as const
export type Scope = (typeof SCOPES)[number]

export interface Principal {
  /** 'token:<id>' or 'local:<name>' */
  id: string
  kind: 'token' | 'local'
  scopes: ReadonlySet<Scope>
  /** '*' or explicit account ids */
  accountIds: readonly string[]
  chatAllowlist: readonly string[] | null
}

export function hasScope(p: Principal, scope: Scope): boolean {
  if (p.scopes.has('admin')) return true
  if (p.scopes.has(scope)) return true
  return false
}

export function canAccessAccount(p: Principal, accountId: string): boolean {
  return p.accountIds.includes('*') || p.accountIds.includes(accountId)
}

export function canAccessChat(p: Principal, chatId: string): boolean {
  return p.chatAllowlist === null || p.chatAllowlist.includes(chatId)
}

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex')
}

export const DEFAULT_TOKEN_TTL_DAYS = 90

export interface CreatedToken {
  id: string
  name: string
  /** Shown once; only the hash is stored. */
  plaintext: string
  expiresAt: Date | null
}

/** Bearer tokens for the HTTP transport and the stdio proxy (PRD §7.7, §10.3). */
export class TokenStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async create(opts: {
    name: string
    scopes: Scope[]
    accountIds: string[]
    chatAllowlist?: string[] | null
    ttlDays?: number | null
  }): Promise<CreatedToken> {
    for (const s of opts.scopes) if (!SCOPES.includes(s)) throw new Error(`unknown scope: ${s}`)
    const plaintext = `wamcp_${randomBytes(32).toString('base64url')}`
    const id = newId()
    const ttl = opts.ttlDays === undefined ? DEFAULT_TOKEN_TTL_DAYS : opts.ttlDays
    const expiresAt = ttl === null ? null : new Date(this.clock.now().getTime() + ttl * 86_400_000)
    await this.db.insert(tokens).values({
      id,
      name: opts.name,
      hash: hashToken(plaintext),
      scopes: opts.scopes,
      accountIds: opts.accountIds,
      chatAllowlist: opts.chatAllowlist ?? null,
      expiresAt,
      createdAt: this.clock.now(),
    })
    return { id, name: opts.name, plaintext, expiresAt }
  }

  /** Returns the principal for a bearer token, or null when unknown, revoked, or expired. */
  async verify(plaintext: string): Promise<Principal | null> {
    if (!plaintext.startsWith('wamcp_')) return null
    const [row] = await this.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.hash, hashToken(plaintext)), isNull(tokens.revokedAt)))
    if (!row) return null
    if (row.expiresAt && row.expiresAt < this.clock.now()) return null
    await this.db.update(tokens).set({ lastUsedAt: this.clock.now() }).where(eq(tokens.id, row.id))
    return {
      id: `token:${row.id}`,
      kind: 'token',
      scopes: new Set(row.scopes as Scope[]),
      accountIds: row.accountIds,
      chatAllowlist: row.chatAllowlist ?? null,
    }
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.db
      .update(tokens)
      .set({ revokedAt: this.clock.now() })
      .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
      .returning({ id: tokens.id })
    return rows.length > 0
  }

  async list() {
    return this.db
      .select({
        id: tokens.id,
        name: tokens.name,
        scopes: tokens.scopes,
        accountIds: tokens.accountIds,
        expiresAt: tokens.expiresAt,
        lastUsedAt: tokens.lastUsedAt,
        revokedAt: tokens.revokedAt,
        createdAt: tokens.createdAt,
      })
      .from(tokens)
  }
}

/** The principal used by in-process callers such as the CLI. */
export function localPrincipal(name: string, scopes: Scope[] = ['admin']): Principal {
  return {
    id: `local:${name}`,
    kind: 'local',
    scopes: new Set(scopes),
    accountIds: ['*'],
    chatAllowlist: null,
  }
}
