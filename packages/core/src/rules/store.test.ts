import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '../clock.js'
import { AccountConfigSchema } from '../config/schema.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { operatorRules, operatorRuleVersions } from '../db/schema/operator.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import { applyApprovalDefault, MAX_CONSECUTIVE_ERRORS, RuleStore, setYamlFields } from './store.js'
import { RuleValidationError } from './validate.js'

const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rules', 'starter')
const awayAck = readFileSync(resolve(STARTER, 'away-ack.yaml'), 'utf8')

const OBSERVE = `# label it\nid: tag\nscope:\n  account: main\nwhen:\n  event: message.received\nactions:\n  - set_label: seen\n`
const SEND = `id: ack\nscope: { account: main }\nwhen:\n  event: message.received\nactions:\n  - send_message:\n      text: "hi {{contact.display_name}}"\n`

let tdb: TestDatabase
let main: RuleStore
let global: RuleStore
let cloud: RuleStore
const clock = new ManualClock(new Date('2026-06-01T10:00:00Z'))

beforeAll(async () => {
  tdb = await createTestDatabase()
  for (const [id, type] of [
    ['main', 'web'],
    ['cloudy', 'cloud'],
  ] as const)
    await provisionAccount(
      tdb.handle,
      AccountConfigSchema.parse({ id, type, display_name: id, timezone: 'UTC' }),
    )
  main = new RuleStore(tdb.handle.db, tablesFor('acct_main'), {
    accountId: 'main',
    accountType: 'web',
    clock,
  })
  cloud = new RuleStore(tdb.handle.db, tablesFor('acct_cloudy'), {
    accountId: 'cloudy',
    accountType: 'cloud',
    clock,
  })
  global = new RuleStore(
    tdb.handle.db,
    { rules: operatorRules, ruleVersions: operatorRuleVersions },
    { accountId: null, clock },
  )
})
afterAll(() => tdb.drop())

describe('YAML field rewriting', () => {
  it('changes only the requested fields and keeps comments and formatting', () => {
    expect(setYamlFields(awayAck, { enabled: false, approval: 'approve' })).toBe(awayAck)
    const on = setYamlFields(awayAck, { enabled: true })
    expect(on).not.toBe(awayAck)
    expect(on.split('\n').filter((l) => !awayAck.includes(l))).toEqual(['enabled: true'])
    expect(on).toContain('# Starter rule (installed disabled)')
    expect(on).toContain('rate_limit: { per_chat: "1/1d" }')
    const withPolicy = setYamlFields(OBSERVE, { approval: 'approve' })
    expect(withPolicy).toContain('# label it')
    expect(withPolicy).toMatch(/policy:\n {2}approval: approve\n$/)
  })

  it('FR-R8: a sending rule without policy.approval gets approve; others are untouched', () => {
    expect(applyApprovalDefault(SEND)).toMatch(/policy:\n {2}approval: approve\n$/)
    expect(applyApprovalDefault(OBSERVE)).toBe(OBSERVE)
    const explicit = `${SEND}policy:\n  approval: auto\n`
    expect(applyApprovalDefault(explicit)).toBe(explicit)
    expect(applyApprovalDefault('a: b: c')).toBe('a: b: c')
    expect(applyApprovalDefault('id: 1')).toBe('id: 1')
  })
})

describe('RuleStore', () => {
  it('saves versions, skips identical text, follows enabled from the YAML', async () => {
    const v1 = await main.save('tag', OBSERVE, 'cli:me')
    expect(v1.changed).toBe(true)
    expect(v1.rule).toMatchObject({
      id: 'tag',
      version: 1,
      enabled: false,
      account: 'main',
      yaml: OBSERVE,
      errorCount: 0,
      updatedAt: clock.now(),
      definition: { id: 'tag', actions: [{ set_label: 'seen' }] },
    })
    expect(await main.save('tag', OBSERVE, 'cli:me')).toMatchObject({ changed: false, rule: { version: 1 } })
    const edited = OBSERVE.replace('seen', 'read').replace('id: tag', 'id: tag\nenabled: true')
    const v2 = await main.save('tag', edited, 'mcp:tok')
    expect(v2.rule).toMatchObject({
      version: 2,
      enabled: true,
      definition: { actions: [{ set_label: 'read' }] },
    })
    expect(await main.versions('tag')).toMatchObject([
      { version: 1, actor: 'cli:me', yaml: OBSERVE, createdAt: clock.now() },
      { version: 2, actor: 'mcp:tok', yaml: edited },
    ])
    expect((await main.list()).map((r) => r.id)).toEqual(['tag'])
    expect(await main.get('ghost')).toBeNull()
    expect(await main.versions('ghost')).toEqual([])
  })

  it('FR-R8 on save: the stored YAML carries approval: approve', async () => {
    const { rule } = await main.save('ack', SEND, 'cli:me')
    expect(rule.yaml).toMatch(/policy:\n {2}approval: approve\n$/)
    expect(rule.definition.policy.approval).toBe('approve')
    // Saving the original text again is a no-op: it normalises to the stored text.
    expect((await main.save('ack', SEND, 'cli:me')).changed).toBe(false)
  })

  it('rolls back to byte-identical YAML as a new version', async () => {
    const [v1] = await main.versions('tag')
    const r = await main.rollback('tag', 1, 'cli:me')
    expect(r.changed).toBe(true)
    expect(r.rule).toMatchObject({ version: 3, enabled: false })
    expect(r.rule.yaml).toBe(v1?.yaml)
    expect(Buffer.from(r.rule.yaml).equals(Buffer.from(OBSERVE))).toBe(true)
    expect((await main.rollback('tag', 3, 'cli:me')).changed).toBe(false)
    await expect(main.rollback('tag', 99, 'cli:me')).rejects.toThrow(/no version 99 of rule tag/)
    await expect(main.rollback('ghost', 1, 'cli:me')).rejects.toThrow(/no version 1 of rule ghost/)
  })

  it('rejects invalid rules, id mismatches and rules of the wrong scope', async () => {
    await expect(main.save('tag', 'id: tag\n', 'x')).rejects.toBeInstanceOf(RuleValidationError)
    await expect(main.save('other', OBSERVE, 'x')).rejects.toThrow(/rule id "tag" does not match "other"/)
    const global1 = OBSERVE.replace('scope:\n  account: main\n', '')
    await expect(main.save('tag', global1, 'x')).rejects.toThrow(
      /this store holds rules with scope.account: main/,
    )
    await expect(global.save('tag', OBSERVE, 'x')).rejects.toThrow(
      /this store holds rules with no scope.account/,
    )
    expect((await global.save('tag', global1, 'x')).rule.account).toBeNull()
    expect(global.label).toBe('global')
    expect(main.label).toBe('main')
    const grouped = OBSERVE.replace('account: main', 'account: cloudy\n  group: g@g.us')
    await expect(cloud.save('tag', grouped, 'x')).rejects.toThrow(
      /scope.group: not available on cloud accounts/,
    )
    expect(main.validate(OBSERVE).issues).toEqual([])
    expect(await main.versions('other')).toEqual([])
  })

  it('suspends after five consecutive errors; enable clears the suspension', async () => {
    for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i++) {
      const r = await main.markError('tag')
      expect(r).toMatchObject({ errorCount: i, suspendedReason: null, suspendedAt: null })
    }
    clock.set(new Date('2026-06-01T11:00:00Z'))
    const fifth = await main.markError('tag', 'threw TypeError')
    expect(fifth).toMatchObject({
      errorCount: 5,
      suspendedReason: 'threw TypeError',
      suspendedAt: new Date('2026-06-01T11:00:00Z'),
    })
    clock.set(new Date('2026-06-01T12:00:00Z'))
    const sixth = await main.markError('tag', 'again')
    expect(sixth).toMatchObject({
      errorCount: 6,
      suspendedReason: 'threw TypeError',
      suspendedAt: new Date('2026-06-01T11:00:00Z'),
    })
    expect(await main.enable('tag')).toMatchObject({
      enabled: true,
      suspendedReason: null,
      suspendedAt: null,
      errorCount: 0,
      updatedAt: clock.now(),
    })
    expect(await main.disable('tag')).toMatchObject({ enabled: false })
    await main.markError('tag')
    expect((await main.clearErrors('tag')).errorCount).toBe(0)
    await expect(main.markError('ghost')).rejects.toThrow(/no rule ghost/)
    await expect(main.enable('ghost')).rejects.toThrow(/no rule ghost/)
  })

  it('removes a rule with its versions', async () => {
    expect(await main.remove('ack')).toBe(true)
    expect(await main.get('ack')).toBeNull()
    expect(await main.versions('ack')).toEqual([])
    expect(await main.remove('ack')).toBe(false)
    expect((await main.save('ack', SEND, 'cli:me')).rule.version).toBe(1)
  })
})
