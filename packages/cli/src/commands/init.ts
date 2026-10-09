import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expandHome,
  generateMasterKey,
  openDatabase,
  parseConfig,
  provisionOperator,
  WamcpConfigSchema,
} from '@wamcp/core'
import type { Command } from 'commander'
import YAML from 'yaml'
import { type GlobalOptions, resolveConfigPath } from '../context.js'

const STARTER_RULES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'rules',
  'starter',
)

export interface InitAnswers {
  accountId: string
  displayName: string
  timezone: string
  businessStart: string
  businessEnd: string
  operatorNumber: string
  webhookUrl: string
  emailTo: string
  emailFrom: string
  databaseUrl: string
  acceptTos: boolean
}

export function renderConfig(a: InitAnswers): string {
  const channels: unknown[] = []
  if (a.webhookUrl)
    channels.push({ kind: 'webhook', name: 'primary', url: a.webhookUrl, auth_env: 'OPERATOR_WEBHOOK_TOKEN' })
  if (a.emailTo)
    channels.push({ kind: 'email', name: 'mail', to: [a.emailTo], from: a.emailFrom || a.emailTo })
  const doc = {
    version: 1,
    server: { http: { bind: '127.0.0.1', port: 8787 }, data_dir: './data', backup_dir: './backups' },
    operator: { numbers: a.operatorNumber ? [a.operatorNumber] : [], channels },
    accounts: [
      {
        id: a.accountId,
        type: 'web',
        display_name: a.displayName,
        timezone: a.timezone,
        business_hours: { days: [1, 2, 3, 4, 5], start: a.businessStart, end: a.businessEnd },
        tool_send_approval: 'approve',
        persona: '',
      },
    ],
  }
  WamcpConfigSchema.parse(doc)
  return `# wamcp configuration. Secrets live in .env, never here.\n${YAML.stringify(doc)}`
}

/** Writes config, .env, master key, provisions the operator schema, installs starter rules. */
export async function runInit(
  a: InitAnswers,
  dir: string,
  keyFile: string,
): Promise<{ configPath: string; envPath: string; keyPath: string; rulesInstalled: string[] }> {
  if (!a.acceptTos) throw new Error('the Terms of Service acknowledgement is required for web accounts')
  mkdirSync(dir, { recursive: true })
  const configPath = resolve(dir, 'wamcp.yaml')
  if (existsSync(configPath)) throw new Error(`${configPath} already exists; refusing to overwrite`)
  const envPath = resolve(dir, '.env')
  const keyPath = expandHome(keyFile)
  const key = existsSync(keyPath) ? null : generateMasterKey(keyPath)
  writeFileSync(configPath, renderConfig(a), { mode: 0o600 })
  if (!existsSync(envPath)) {
    writeFileSync(
      envPath,
      `DATABASE_URL=${a.databaseUrl}\nWAMCP_MASTER_KEY_FILE=${keyPath}\nLOG_LEVEL=info\n# OPERATOR_WEBHOOK_TOKEN=\n# SMTP_URL=smtps://user:pass@smtp.example.com:465\n`,
      { mode: 0o600 },
    )
  }
  const rulesDir = resolve(dir, 'rules')
  mkdirSync(rulesDir, { recursive: true })
  const rulesInstalled: string[] = []
  if (existsSync(STARTER_RULES_DIR)) {
    for (const f of readdirSync(STARTER_RULES_DIR).filter((f) => f.endsWith('.yaml'))) {
      const target = resolve(rulesDir, f)
      if (!existsSync(target)) {
        writeFileSync(target, readFileSync(resolve(STARTER_RULES_DIR, f)))
        rulesInstalled.push(f)
      }
    }
  }
  mkdirSync(resolve(dir, 'data', '_operator'), { recursive: true, mode: 0o700 })
  mkdirSync(resolve(dir, 'backups'), { recursive: true, mode: 0o700 })
  const handle = openDatabase(a.databaseUrl, { applicationName: 'wamcp-init', max: 2 })
  try {
    await provisionOperator(handle)
  } finally {
    await handle.close()
  }
  void key
  return { configPath, envPath, keyPath, rulesInstalled }
}

export function registerInit(program: Command) {
  program
    .command('init')
    .option('--non-interactive', 'take every answer from flags')
    .option('--dir <path>', 'where to write wamcp.yaml, .env, rules/ (default: current directory)', '.')
    .option('--account-id <id>', 'account id', 'main')
    .option('--display-name <name>', 'account display name', 'Main')
    .option('--timezone <iana>', 'IANA zone, e.g. Asia/Kolkata')
    .option('--business-hours <start-end>', 'e.g. 09:00-18:00', '09:00-18:00')
    .option('--operator-number <e164>', 'your own phone number for commands (P0b)')
    .option('--webhook-url <url>', 'operator webhook URL')
    .option('--email-to <addr>', 'operator email')
    .option('--email-from <addr>', 'sender address for operator email')
    .option('--database-url <url>', 'Postgres URL (default $DATABASE_URL)')
    .option('--master-key-file <path>', 'where to create the master key', '~/.config/wamcp/master.key')
    .option('--accept-tos', 'acknowledge the WhatsApp Terms of Service warning')
    .description('first-run setup: config, .env, master key, operator schema, starter rules')
    .action(async (o: Record<string, string | boolean | undefined>) => {
      const opts = program.opts<GlobalOptions>()
      void opts
      const dir = resolve(String(o.dir ?? '.'))
      let answers: InitAnswers
      const [bs, be] = String(o.businessHours ?? '09:00-18:00').split('-')
      if (o.nonInteractive) {
        answers = {
          accountId: String(o.accountId),
          displayName: String(o.displayName),
          timezone: String(o.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
          businessStart: bs ?? '09:00',
          businessEnd: be ?? '18:00',
          operatorNumber: String(o.operatorNumber ?? ''),
          webhookUrl: String(o.webhookUrl ?? ''),
          emailTo: String(o.emailTo ?? ''),
          emailFrom: String(o.emailFrom ?? ''),
          databaseUrl: String(o.databaseUrl ?? process.env.DATABASE_URL ?? ''),
          acceptTos: o.acceptTos === true,
        }
      } else {
        const { createInterface } = await import('node:readline/promises')
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const ask = async (q: string, def: string) =>
          (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def
        process.stdout.write('wamcp first-run setup. Press Enter to accept a default.\n\n')
        const accountId = await ask('Account id (lowercase, no spaces)', String(o.accountId))
        const displayName = await ask('Display name', String(o.displayName))
        const timezone = await ask(
          'Time zone (IANA)',
          String(o.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
        )
        const businessStart = await ask('Business hours start (HH:MM)', bs ?? '09:00')
        const businessEnd = await ask('Business hours end (HH:MM)', be ?? '18:00')
        const operatorNumber = await ask(
          'Your own phone number in E.164 (for commands, optional)',
          String(o.operatorNumber ?? ''),
        )
        process.stdout.write('\nAt least one non-WhatsApp alert channel is required (webhook or email).\n')
        const webhookUrl = await ask(
          'Operator webhook URL (ntfy, Telegram relay, Slack hook; optional)',
          String(o.webhookUrl ?? ''),
        )
        const emailTo = await ask('Operator email (optional)', String(o.emailTo ?? ''))
        const emailFrom = emailTo ? await ask('Sender address for email', String(o.emailFrom ?? emailTo)) : ''
        const databaseUrl = await ask(
          'Postgres DATABASE_URL',
          String(o.databaseUrl ?? process.env.DATABASE_URL ?? 'postgres://wamcp:wamcp@127.0.0.1:5432/wamcp'),
        )
        process.stdout.write(
          "\nPairing a personal or Business App number uses the WhatsApp Web protocol through an unofficial library.\nThis breaches WhatsApp's Terms of Service and can get the number banned. Use a dedicated number.\n",
        )
        const tos = await ask('Type "I understand" to continue', '')
        rl.close()
        answers = {
          accountId,
          displayName,
          timezone,
          businessStart,
          businessEnd,
          operatorNumber,
          webhookUrl,
          emailTo,
          emailFrom,
          databaseUrl,
          acceptTos: tos.toLowerCase() === 'i understand',
        }
      }
      if (!answers.databaseUrl) throw new Error('a Postgres DATABASE_URL is required')
      const r = await runInit(answers, dir, String(o.masterKeyFile))
      // Validate the written config end to end.
      parseConfig(readFileSync(r.configPath, 'utf8'), r.configPath)
      process.stdout.write(
        `\nwrote ${r.configPath}\nwrote ${r.envPath}\nmaster key at ${r.keyPath}\nstarter rules (disabled): ${r.rulesInstalled.join(', ') || 'none'}\n\nNext: wamcp doctor && wamcp accounts pair ${answers.accountId}\n`,
      )
      void resolveConfigPath
    })
}
