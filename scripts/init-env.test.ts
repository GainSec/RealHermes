import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initEnv } from './init-env.mjs'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function project(example?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'rh-init-env-')); dirs.push(dir)
  if (example !== undefined) await writeFile(join(dir, '.env.example'), example)
  return dir
}

it('creates an owner-only .env from the example once and never overwrites it', async () => {
  const dir = await project('HERMES_API_KEY=\n')
  expect(await initEnv(dir)).toBe('created')
  expect(await readFile(join(dir, '.env'), 'utf8')).toBe('HERMES_API_KEY=\n')
  expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
  await writeFile(join(dir, '.env'), 'HERMES_API_KEY=already-set\n')
  expect(await initEnv(dir)).toBe('exists')
  expect(await readFile(join(dir, '.env'), 'utf8')).toBe('HERMES_API_KEY=already-set\n')
})
it('never writes through a .env symlink, even a dangling one', async () => {
  const dir = await project('HERMES_API_KEY=\n'); const elsewhere = await project()
  await symlink(join(elsewhere, 'credentials'), join(dir, '.env'))
  expect(await initEnv(dir)).toBe('exists')
  await expect(stat(join(elsewhere, 'credentials'))).rejects.toThrow()
})
it('fails without creating .env when the example is missing', async () => {
  const dir = await project()
  await expect(initEnv(dir)).rejects.toThrow('.env.example not found')
  await expect(stat(join(dir, '.env'))).rejects.toThrow()
})
