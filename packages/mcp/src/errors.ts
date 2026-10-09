import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export type ErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CAPABILITY_UNSUPPORTED'
  | 'RATE_LIMITED'
  | 'POLICY_BLOCKED'
  | 'APPROVAL_PENDING'
  | 'CONFIRMATION_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'CONNECTOR_UNAVAILABLE'
  | 'UNDERSTAND_FAILED'
  | 'LLM_DISABLED'
  | 'LLM_BUDGET_EXHAUSTED'

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

export function errorResult(e: unknown): CallToolResult {
  const err =
    e instanceof ToolError ? e : new ToolError('VALIDATION_ERROR', (e as Error).message ?? String(e))
  const body = { error: err.code, message: err.message, ...err.data }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }
}

export function okResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}
