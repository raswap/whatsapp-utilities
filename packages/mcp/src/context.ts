import {
  type AccountRuntime,
  canAccessAccount,
  canAccessChat,
  hasScope,
  type Principal,
  type Scope,
} from '@wamcp/core'
import { ToolError } from './errors.js'

/** What the MCP layer needs from the running server. `wamcp serve` fills it; tests build it by hand. */
export interface Registry {
  accounts: Map<string, AccountRuntime>
  /** Global kill switch state, for status. */
  globalKill(): Promise<boolean>
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!hasScope(p, scope))
    throw new ToolError('FORBIDDEN', `missing scope ${scope}`, { required_scope: scope })
}

export function requireAccount(reg: Registry, p: Principal, accountId: string): AccountRuntime {
  if (!canAccessAccount(p, accountId))
    throw new ToolError('FORBIDDEN', `token is not scoped to account ${accountId}`)
  const rt = reg.accounts.get(accountId)
  if (!rt) throw new ToolError('NOT_FOUND', `no account ${accountId}`)
  return rt
}

export function requireChat(p: Principal, chatId: string): void {
  if (!canAccessChat(p, chatId))
    throw new ToolError('FORBIDDEN', `token is not allowed to access chat ${chatId}`)
}
