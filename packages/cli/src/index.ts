#!/usr/bin/env node
import { Command } from 'commander'
import { registerAccounts } from './commands/accounts.js'
import { registerActions } from './commands/actions.js'
import { registerAlerts } from './commands/alerts.js'
import { registerApprovals } from './commands/approvals.js'
import { registerBackup } from './commands/backup.js'
import { registerDoctor } from './commands/doctor.js'
import { registerInit } from './commands/init.js'
import { registerMcp } from './commands/mcp.js'
import { registerServe } from './commands/serve.js'
import { registerStatus } from './commands/status.js'
import { registerTail } from './commands/tail.js'
import { registerTokens } from './commands/tokens.js'

const program = new Command()
program
  .name('wamcp')
  .description('WhatsApp MCP server: real-time monitoring, policy-gated actions, MCP tools')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to wamcp.yaml (default ./wamcp.yaml or $WAMCP_CONFIG)')
  .option('--json', 'machine-readable output')
  .option('-v, --verbose', 'debug logging')

registerInit(program)
registerServe(program)
registerStatus(program)
registerDoctor(program)
registerTail(program)
registerAccounts(program)
registerApprovals(program)
registerActions(program)
registerTokens(program)
registerBackup(program)
registerAlerts(program)
registerMcp(program)

program.parseAsync(process.argv).catch((e: Error) => {
  process.stderr.write(`error: ${e.message}\n`)
  process.exit(1)
})
