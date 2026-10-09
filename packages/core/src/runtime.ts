import type { Logger } from 'pino'
import { AuditLog } from './audit/log.js'
import type { Clock } from './clock.js'
import type { AccountConfig } from './config/schema.js'
import type { Connector } from './connectors/types.js'
import type { DbHandle } from './db/client.js'
import { tablesFor } from './db/schema/account.js'
import { Pipeline } from './events/pipeline.js'
import { Executor } from './executor/executor.js'
import { gateContextBuilder } from './gate/context.js'
import { Limiter } from './gate/limiter.js'
import { PolicyGate } from './gate/policy.js'
import { accountSchemaName } from './ids.js'
import type { OperatorChannel } from './operator/channel.js'
import { OperatorState } from './operator/state.js'
import type { Codec } from './store/codec.js'

export interface AccountRuntime {
  config: AccountConfig
  schemaName: string
  connector: Connector
  pipeline: Pipeline
  executor: Executor
  audit: AuditLog
  limiter: Limiter
  start(): Promise<void>
  stop(): Promise<void>
  /** Account kill switch (PRD FR-A6); audited. */
  setPaused(paused: boolean, actor: string): Promise<void>
}

export interface RuntimeDeps {
  handle: DbHandle
  config: AccountConfig
  connector: Connector
  codec: Codec
  clock: Clock
  log: Logger
  operator: OperatorChannel
  backfillAgeThresholdMs?: number
  approvalTtlMs?: number
  unknownResolveWindowMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Wires pipeline, gate, executor, and audit for one account. Used by `wamcp serve` and tests. */
export function createAccountRuntime(d: RuntimeDeps): AccountRuntime {
  const schemaName = accountSchemaName(d.config.id)
  const tables = tablesFor(schemaName)
  const db = d.handle.db
  const pipeline = new Pipeline({
    accountId: d.config.id,
    schemaName,
    db,
    tables,
    codec: d.codec,
    clock: d.clock,
    log: d.log,
    ...(d.backfillAgeThresholdMs !== undefined ? { backfillAgeThresholdMs: d.backfillAgeThresholdMs } : {}),
  })
  const limiter = new Limiter(db, tables, d.clock)
  const audit = new AuditLog(db, tables)
  let executor: Executor
  const contextFor = gateContextBuilder({
    db,
    tables,
    account: d.config,
    connector: d.connector,
    chats: pipeline.chats,
    messages: pipeline.messages,
    identities: pipeline.identities,
    get actions() {
      return executor.actions
    },
    clock: d.clock,
  } as Parameters<typeof gateContextBuilder>[0])
  executor = new Executor({
    accountId: d.config.id,
    db,
    tables,
    connector: d.connector,
    gate: new PolicyGate(limiter),
    limiter,
    audit,
    operator: d.operator,
    chats: pipeline.chats,
    messages: pipeline.messages,
    clock: d.clock,
    log: d.log,
    contextFor,
    ...(d.approvalTtlMs !== undefined ? { approvalTtlMs: d.approvalTtlMs } : {}),
    ...(d.unknownResolveWindowMs !== undefined ? { unknownResolveWindowMs: d.unknownResolveWindowMs } : {}),
    ...(d.sleep ? { sleep: d.sleep } : {}),
  })
  pipeline.onEvent(executor.pipelineHandler())
  pipeline.attach(d.connector)
  const operatorState = new OperatorState(db)
  return {
    config: d.config,
    schemaName,
    connector: d.connector,
    pipeline,
    executor,
    audit,
    limiter,
    async start() {
      await pipeline.start()
      await d.connector.start()
    },
    async stop() {
      await d.connector.stop()
      await pipeline.stop()
    },
    async setPaused(paused, actor) {
      await operatorState.setAccountPaused(d.config.id, paused)
      await audit.append({
        actor,
        kind: 'account',
        subjectId: d.config.id,
        decision: paused ? 'paused' : 'resumed',
      })
    },
  }
}
