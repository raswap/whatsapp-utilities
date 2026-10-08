import pino, { type Logger } from 'pino'

/** Paths that must never reach a log line at any level above debug. */
export const REDACT_PATHS = [
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'api_key',
  '*.api_key',
  'phone',
  '*.phone',
  'body',
  '*.body',
  'payload.body',
  'message.body',
  'creds',
  '*.creds',
  'keys',
  '*.keys',
]

export interface LogOptions {
  level?: string
  pretty?: boolean
  name?: string
}

export function createLogger(opts: LogOptions = {}): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info'
  const base = { name: opts.name ?? 'wamcp' }
  const redact = { paths: REDACT_PATHS, censor: '[redacted]' }
  if (opts.pretty) {
    return pino({ level, base, redact, transport: { target: 'pino-pretty', options: { colorize: true } } })
  }
  return pino({ level, base, redact })
}

export type { Logger }
