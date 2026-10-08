import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { expandHome, loadConfigFile, loadSecrets, openDatabase } from '@wamcp/core'
import type { Command } from 'commander'
import dotenv from 'dotenv'
import { type GlobalOptions, loadContext, resolveConfigPath } from '../context.js'
import { runDoctorChecks } from '../doctor-checks.js'

export function registerDoctor(program: Command) {
  program
    .command('doctor')
    .option('--probe', 'also send a test message on every operator channel')
    .description('check config, keys, database, disk, backups, channels, and library pin')
    .action(async (o: { probe?: boolean }) => {
      const opts = program.opts<GlobalOptions>()
      const configPath = resolveConfigPath(opts.config)
      const envPath = resolve(configPath, '..', '.env')
      if (existsSync(envPath)) dotenv.config({ path: envPath, quiet: true })
      const config = loadConfigFile(configPath)
      const secrets = loadSecrets()
      let handle = null
      let dbError: string | undefined
      try {
        handle = openDatabase(secrets.DATABASE_URL, { max: 2, applicationName: 'wamcp-doctor' })
        await handle.pool.query('select 1')
      } catch (e) {
        dbError = (e as Error).message
        await handle?.close().catch(() => undefined)
        handle = null
      }
      const require = createRequire(import.meta.url)
      let baileysVersion = 'unknown'
      try {
        baileysVersion = (require('@whiskeysockets/baileys/package.json') as { version: string }).version
      } catch {
        /* keep unknown */
      }
      const probe = o.probe
        ? async () => {
            const ctx = await loadContext(opts, { needKey: false })
            try {
              return await ctx.operator.test()
            } finally {
              await ctx.close()
            }
          }
        : undefined
      const results = await runDoctorChecks({
        configPath,
        config,
        masterKeyPath: expandHome(secrets.WAMCP_MASTER_KEY_FILE),
        handle,
        ...(dbError ? { dbError } : {}),
        baileysVersion,
        now: new Date(),
        ...(probe ? { probe } : {}),
      })
      await handle?.close()
      const worst = results.some((r) => r.status === 'fail')
        ? 'fail'
        : results.some((r) => r.status === 'warn')
          ? 'warn'
          : 'pass'
      if (opts.json) process.stdout.write(`${JSON.stringify({ status: worst, checks: results }, null, 2)}\n`)
      else {
        for (const r of results)
          process.stdout.write(`${r.status.toUpperCase().padEnd(4)} ${r.name.padEnd(22)} ${r.detail}\n`)
        process.stdout.write(`\noverall: ${worst.toUpperCase()}\n`)
      }
      if (worst === 'fail') process.exitCode = 1
    })
}
