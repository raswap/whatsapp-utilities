import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import YAML from 'yaml'
import { type Secrets, SecretsSchema, type WamcpConfig, WamcpConfigSchema } from './schema.js'

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
}

export function parseConfig(yamlText: string, sourcePath = '<inline>'): WamcpConfig {
  let raw: unknown
  try {
    raw = YAML.parse(yamlText)
  } catch (e) {
    throw new ConfigError(`invalid YAML: ${(e as Error).message}`, sourcePath)
  }
  const result = WamcpConfigSchema.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    const where = first ? first.path.join('.') || '<root>' : '<root>'
    throw new ConfigError(`${where}: ${first?.message ?? 'invalid config'}`, sourcePath)
  }
  const ids = new Set<string>()
  for (const a of result.data.accounts) {
    if (ids.has(a.id)) throw new ConfigError(`accounts: duplicate account id "${a.id}"`, sourcePath)
    ids.add(a.id)
  }
  if (result.data.accounts.some((a) => a.type === 'web')) {
    const nonWhatsApp = result.data.operator.channels.filter(
      (c) => c.kind === 'webhook' || c.kind === 'email',
    )
    if (nonWhatsApp.length === 0) {
      throw new ConfigError(
        'operator.channels: at least one webhook or email channel is required when a web account exists (PRD D11)',
        sourcePath,
      )
    }
  }
  return result.data
}

export function loadConfigFile(path: string): WamcpConfig {
  const abs = expandHome(path)
  let text: string
  try {
    text = readFileSync(abs, 'utf8')
  } catch (e) {
    throw new ConfigError(`cannot read config: ${(e as Error).message}`, abs)
  }
  return parseConfig(text, abs)
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const result = SecretsSchema.safeParse(env)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new ConfigError(`${first?.path.join('.') ?? 'env'}: ${first?.message ?? 'invalid'}`, '<env>')
  }
  return { ...result.data, WAMCP_MASTER_KEY_FILE: expandHome(result.data.WAMCP_MASTER_KEY_FILE) }
}
