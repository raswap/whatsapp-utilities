import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccountConfigSchema } from '../config/schema.js'
import { provisionAccount } from '../db/provision.js'
import { tablesFor } from '../db/schema/account.js'
import { operatorRules, operatorRuleVersions } from '../db/schema/operator.js'
import { createTestDatabase, type TestDatabase } from '../testing/index.js'
import {
  allStores,
  findRule,
  type ImportResult,
  importRules,
  listRuleFiles,
  type RuleStores,
  watchRules,
} from './import.js'
import { RuleStore } from './store.js'

const STARTER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'rules', 'starter')

let tdb: TestDatabase
let dir: string
let stores: RuleStores
const actor = 'cli:test'
const run = () => importRules(dir, { stores, actor })
const write = (name: string, text: string) => writeFileSync(resolve(dir, name), text)
const drop = (name: string) => rmSync(resolve(dir, name), { force: true })

const ACCOUNT_RULE = `# main only\nid: main-tag\nenabled: true\nscope:\n  account: main\nwhen:\n  event: message.received\nactions:\n  - set_label: seen\n`

beforeAll(async () => {
  tdb = await createTestDatabase()
  await provisionAccount(
    tdb.handle,
    AccountConfigSchema.parse({ id: 'main', type: 'web', display_name: 'Main', timezone: 'UTC' }),
  )
  stores = {
    global: new RuleStore(
      tdb.handle.db,
      { rules: operatorRules, ruleVersions: operatorRuleVersions },
      { accountId: null },
    ),
    accounts: new Map([
      [
        'main',
        new RuleStore(tdb.handle.db, tablesFor('acct_main'), { accountId: 'main', accountType: 'web' }),
      ],
    ]),
  }
  dir = mkdtempSync(resolve(tmpdir(), 'wamcp-rules-'))
  cpSync(STARTER, dir, { recursive: true })
})
afterAll(async () => {
  await tdb.drop()
  rmSync(dir, { recursive: true, force: true })
})

describe('importRules', () => {
  it('imports the starter rules disabled with approval: approve (FR-R7), keeping comments', async () => {
    expect(listRuleFiles(dir)).toEqual(['away-ack.yaml', 'group-daily-digest.yaml', 'urgent-notify.yaml'])
    const r = await run()
    expect(r).toEqual({
      ok: true,
      rules: [
        { file: 'away-ack.yaml', id: 'away-ack', account: null, version: 1, changed: true },
        {
          file: 'group-daily-digest.yaml',
          id: 'group-daily-digest',
          account: null,
          version: 1,
          changed: true,
        },
        { file: 'urgent-notify.yaml', id: 'urgent-notify', account: null, version: 1, changed: true },
      ],
    })
    const urgent = await stores.global.get('urgent-notify')
    expect(urgent).toMatchObject({
      enabled: false,
      definition: { enabled: false, policy: { approval: 'approve' } },
    })
    expect(urgent?.yaml).toContain(
      '# Starter rule (installed disabled). Enable with: wamcp rules enable urgent-notify',
    )
    expect(urgent?.yaml).toContain('keywords: ["urgent", "asap", "emergency", "immediately"]')
    expect(urgent?.yaml).not.toContain('approval: auto')
    // away-ack already had enabled: false and approval: approve, so it is stored byte for byte.
    expect((await stores.global.get('away-ack'))?.yaml).toBe(
      readFileSync(resolve(STARTER, 'away-ack.yaml'), 'utf8'),
    )
  })

  it('is a no-op for files identical to the stored YAML', async () => {
    const r = await run()
    expect(r.ok && r.rules.every((x) => x.version === 1 && !x.changed)).toBe(true)
    expect(await stores.global.versions('urgent-notify')).toHaveLength(1)
  })

  it('routes scope.account rules to that account and rejects unknown accounts', async () => {
    write('main-tag.yaml', ACCOUNT_RULE)
    const r = await run()
    expect(r.ok && r.rules.find((x) => x.id === 'main-tag')).toEqual({
      file: 'main-tag.yaml',
      id: 'main-tag',
      account: 'main',
      version: 1,
      changed: true,
    })
    const found = await findRule(stores, 'main-tag')
    expect(found?.store).toBe(stores.accounts.get('main'))
    expect(found?.rule).toMatchObject({ enabled: false, yaml: expect.stringContaining('# main only') })
    expect(await findRule(stores, 'nope')).toBeNull()
    expect(allStores(stores)).toHaveLength(2)

    write(
      'ghost.yaml',
      ACCOUNT_RULE.replace('account: main', 'account: ghost').replace('main-tag', 'ghost-tag'),
    )
    expect(await run()).toEqual({
      ok: false,
      errors: [{ file: 'ghost.yaml', path: 'scope.account', message: 'unknown account "ghost"' }],
    })
    drop('ghost.yaml')
  })

  it('imports nothing when any file is invalid (FR-R6)', async () => {
    write(
      'urgent-notify.yaml',
      readFileSync(resolve(STARTER, 'urgent-notify.yaml'), 'utf8').replace('asap', 'now'),
    )
    write('broken.yaml', 'id: broken\nwhen:\n  event: message.received\nactions:\n  - send_media: {}\n')
    write('unparsable.yaml', 'a: b: c\n')
    write('not-a-rule.yml', '- 1\n- 2\n')
    const r = await run()
    expect(r).toEqual({
      ok: false,
      errors: [
        { file: 'broken.yaml', path: 'actions.0', message: 'unknown action kind "send_media"' },
        { file: 'not-a-rule.yml', path: '', message: 'a rule is a YAML mapping' },
        { file: 'unparsable.yaml', path: '', message: expect.stringMatching(/^YAML does not parse/) },
      ],
    })
    expect(await stores.global.versions('urgent-notify')).toHaveLength(1)
    for (const f of ['broken.yaml', 'unparsable.yaml', 'not-a-rule.yml']) drop(f)
    const again = await run()
    expect(again.ok && again.rules.find((x) => x.id === 'urgent-notify')).toMatchObject({
      version: 2,
      changed: true,
    })
  })

  it('rejects duplicate ids within the directory and across stores', async () => {
    write('dup.yaml', readFileSync(resolve(dir, 'away-ack.yaml'), 'utf8'))
    expect(await run()).toEqual({
      ok: false,
      errors: [{ file: 'dup.yaml', path: 'id', message: 'rule "away-ack" is also defined in away-ack.yaml' }],
    })
    drop('dup.yaml')
    write('moved.yaml', ACCOUNT_RULE.replace('main-tag', 'urgent-notify'))
    expect(await run()).toEqual({
      ok: false,
      errors: [
        {
          file: 'moved.yaml',
          path: 'scope.account',
          message: 'rule "urgent-notify" already exists as a global rule',
        },
        {
          file: 'urgent-notify.yaml',
          path: 'id',
          message: 'rule "urgent-notify" is also defined in moved.yaml',
        },
      ],
    })
    drop('moved.yaml')
  })

  it('watch re-imports after changes settle', async () => {
    const results: ImportResult[] = []
    let resolveNext: ((r: ImportResult) => void) | undefined
    const next = () => new Promise<ImportResult>((res) => (resolveNext = res))
    const watcher = watchRules(dir, { stores, actor, debounceMs: 50 }, (r) => {
      results.push(r)
      resolveNext?.(r)
    })
    try {
      const pending = next()
      write('watched.yaml', ACCOUNT_RULE.replace('main-tag', 'watched'))
      write('watched.yaml', ACCOUNT_RULE.replace('main-tag', 'watched').replace('seen', 'late'))
      const r = await pending
      expect(r).toMatchObject({ ok: true })
      expect(r.ok && r.rules.find((x) => x.id === 'watched')).toMatchObject({ version: 1, changed: true })
      expect((await findRule(stores, 'watched'))?.rule.definition.actions).toEqual([{ set_label: 'late' }])
      expect(results).toHaveLength(1)
    } finally {
      watcher.close()
    }
  })
})
