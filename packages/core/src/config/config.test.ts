import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfigFile, loadSecrets, parseConfig } from './load.js'

const good = `
version: 1
operator:
  channels:
    - kind: webhook
      name: ntfy
      url: https://ntfy.sh/wamcp-test
accounts:
  - id: main
    type: web
    display_name: Main
    timezone: Asia/Kolkata
`

describe('config', () => {
  it('parses a minimal config with defaults applied', () => {
    const c = parseConfig(good)
    expect(c.accounts[0]?.business_hours.start).toBe('09:00')
    expect(c.accounts[0]?.limits.sends_per_day).toBe(150)
    expect(c.server.http.bind).toBe('127.0.0.1')
    expect(c.operator.channels[0]?.kind).toBe('webhook')
  })
  it('requires a non-WhatsApp operator channel when a web account exists (D11)', () => {
    const noChannel = good.replace(/operator:[\s\S]*?accounts:/, 'accounts:')
    expect(() => parseConfig(noChannel)).toThrow(/at least one webhook or email channel/)
  })
  it('rejects invalid time zones and duplicate account ids with a path', () => {
    expect(() => parseConfig(good.replace('Asia/Kolkata', 'Mars/Olympus'))).toThrow(/accounts.0.timezone/)
    const dup = `${good}  - id: main\n    type: web\n    display_name: Dup\n    timezone: UTC\n`
    expect(() => parseConfig(dup)).toThrow(/duplicate account id/)
  })
  it('rejects bad YAML with ConfigError', () => {
    expect(() => parseConfig('version: [1')).toThrow(ConfigError)
  })
  it('loads secrets from env and expands ~', () => {
    const s = loadSecrets({
      DATABASE_URL: 'postgres://u@h/db',
      WAMCP_MASTER_KEY_FILE: '~/.config/wamcp/master.key',
    })
    expect(s.WAMCP_MASTER_KEY_FILE.startsWith('/')).toBe(true)
    expect(s.LOG_LEVEL).toBe('info')
    expect(() => loadSecrets({})).toThrow(/DATABASE_URL/)
  })
  it('loadConfigFile reports unreadable files as ConfigError', () => {
    expect(() => loadConfigFile('/nonexistent/wamcp.yaml')).toThrow(/cannot read config/)
  })
})
