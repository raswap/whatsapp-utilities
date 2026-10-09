import type { Capability } from '../connectors/types.js'
import type { Origin } from '../events/types.js'

export type ActionClass = 'observe' | 'counterparty_send' | 'side_effecting'

export type ActionKind =
  | 'send_message'
  | 'react_to_message'
  | 'mark_read'
  | 'set_label'
  | 'remove_label'
  | 'escalate'
  | 'notify_operator'
  | 'set_chat_automation'

export const ACTION_CLASS: Record<ActionKind, ActionClass> = {
  send_message: 'counterparty_send',
  react_to_message: 'counterparty_send',
  mark_read: 'observe',
  set_label: 'observe',
  remove_label: 'observe',
  escalate: 'observe',
  notify_operator: 'observe',
  set_chat_automation: 'observe',
}

export const ACTION_CAPABILITY: Partial<Record<ActionKind, Capability>> = {
  react_to_message: 'reactions',
}

export type ApprovalMode = 'auto' | 'approve' | 'dry_run'

export interface PlannedAction {
  kind: ActionKind
  /** 'token:<id>' | 'rule:<id>' | 'cli' | 'self_command' */
  source: string
  /** Principal for separation of duties; the same actor may not approve its own action. */
  actor: string
  idempotencyKey: string
  chatId?: string
  recipientContactId?: string
  payload: Record<string, unknown>
  ruleId?: string
  eventId?: string
  /** Origin of the inbound event that triggered this action, when rule-initiated. */
  inboundOrigin?: Origin | null
  /** Hash of the triggering message body, so an edit cancels a pending approval. */
  bodyHash?: string
  approval: ApprovalMode
  overrideQuietHours?: boolean
  /** True when the rule's scope is specific enough to permit the quiet-hours override. */
  allowQuietOverride?: boolean
  deniedKinds?: string[]
  /** Text that will be sent, for loop protection and the approval preview. */
  text?: string
}

export interface CheckResult {
  check: string
  passed: boolean
  reason?: string
  retryAfterMs?: number
}

export type GateOutcome = 'execute' | 'await_approval' | 'dry_run' | 'blocked'

export interface GateDecision {
  outcome: GateOutcome
  check?: string
  reason?: string
  trace: CheckResult[]
}
