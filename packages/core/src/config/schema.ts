import { z } from 'zod'

const IanaZone = z
  .string()
  .min(1)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
        return true
      } catch {
        return false
      }
    },
    { message: 'must be a valid IANA time zone' },
  )

export const BusinessHoursSchema = z.object({
  /** ISO weekday numbers, 1 = Monday ... 7 = Sunday */
  days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  start: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('09:00'),
  end: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('18:00'),
})

export const OperatorChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('webhook'),
    name: z.string().min(1),
    url: z.string().url(),
    /** Name of an env var holding a bearer token; never the token itself. */
    auth_env: z.string().optional(),
    timeout_ms: z.number().int().min(500).max(30_000).default(5000),
  }),
  z.object({
    kind: z.literal('email'),
    name: z.string().min(1),
    to: z.array(z.string().email()).min(1),
    from: z.string().email(),
    /** Env var holding an SMTP URL such as smtps://user:pass@host:465 */
    smtp_url_env: z.string().default('SMTP_URL'),
  }),
])

export const OperatorSchema = z.object({
  /** Phone numbers in E.164 that may command the system from a phone (P0b). */
  numbers: z.array(z.string().regex(/^\+[1-9]\d{6,14}$/)).default([]),
  channels: z.array(OperatorChannelSchema).default([]),
  rate_limit_per_minute: z.number().int().min(1).max(600).default(20),
  digest_after: z.number().int().min(1).default(10),
  digest_window_minutes: z.number().int().min(1).default(10),
})

export const AccountConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'account id: lowercase letters, digits, underscore'),
  type: z.enum(['web', 'cloud']),
  display_name: z.string().min(1),
  timezone: IanaZone,
  business_hours: BusinessHoursSchema.default({}),
  persona: z.string().max(4000).default(''),
  llm_enabled: z.boolean().default(true),
  history_days: z.number().int().min(0).max(365).default(30),
  /** Approval mode for sends initiated by MCP clients or the CLI (rules carry their own). */
  tool_send_approval: z.enum(['auto', 'approve', 'dry_run']).default('approve'),
  limits: z
    .object({
      sends_per_chat_interval_seconds: z.number().int().min(1).default(30),
      sends_per_hour: z.number().int().min(1).default(20),
      sends_per_day: z.number().int().min(1).default(150),
      sends_per_contact_per_day: z.number().int().min(1).default(10),
      max_consecutive_automated: z.number().int().min(1).default(3),
    })
    .default({}),
})

export const ServerConfigSchema = z.object({
  http: z
    .object({
      bind: z.string().default('127.0.0.1'),
      /** 0 binds an ephemeral port (tests). */
      port: z.number().int().min(0).max(65535).default(8787),
      /** Allowed Origin header values for browser clients; loopback origins are always allowed. */
      allowed_origins: z.array(z.string()).default([]),
    })
    .default({}),
  metrics: z
    .object({ bind: z.string().default('127.0.0.1'), port: z.number().int().default(9797) })
    .default({}),
  data_dir: z.string().default('./data'),
  backup_dir: z.string().default('./backups'),
  backfill_age_threshold_seconds: z.number().int().min(0).default(300),
  approval_ttl_hours: z.number().int().min(1).max(168).default(4),
  unknown_resolve_window_minutes: z.number().int().min(1).default(15),
})

export const WamcpConfigSchema = z.object({
  version: z.literal(1),
  server: ServerConfigSchema.default({}),
  operator: OperatorSchema.default({}),
  accounts: z.array(AccountConfigSchema).default([]),
})

export type WamcpConfig = z.infer<typeof WamcpConfigSchema>
export type AccountConfig = z.infer<typeof AccountConfigSchema>
export type OperatorChannelConfig = z.infer<typeof OperatorChannelSchema>
export type OperatorConfig = z.infer<typeof OperatorSchema>

/** Secrets are never in the YAML; they come from the environment or a .env file. */
export const SecretsSchema = z.object({
  DATABASE_URL: z.string().url(),
  WAMCP_MASTER_KEY_FILE: z.string().default('~/.config/wamcp/master.key'),
  SMTP_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
})
export type Secrets = z.infer<typeof SecretsSchema>
