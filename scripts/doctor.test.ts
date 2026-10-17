import { mkdtemp, rm, symlink, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fileInfo, findExecutable, formatReport, nodeSupported, probePython, runDoctor } from './doctor.mjs'

const home = '/home/example'
const root = '/srv/realhermes'
const now = 1_800_000_000_000
const glb = { kind: 'file', size: 38_245_080, mtimeMs: now, mode: 0o100644, head: Buffer.from('glTF') }
// A machine with everything installed and configured; each test changes only what it is about.
function facts(overrides: Record<string, unknown> = {}, files: Record<string, unknown> = {}) {
  const tree: Record<string, unknown> = {
    [`${root}/public/models/realhermes-idle.glb`]: glb, [`${root}/dist/index.html`]: { kind: 'file', size: 400, mtimeMs: now, mode: 0o100644, head: Buffer.from('<!do') },
    [`${root}/.env`]: { kind: 'file', size: 200, mtimeMs: now, mode: 0o100600, head: Buffer.from('# Se') }, '/srv/art': { kind: 'directory' }, ...files,
  }
  const executables = new Set(['/usr/bin/pdfinfo', '/usr/bin/pdftoppm', '/usr/bin/python3', '/usr/local/bin/hermes', '/usr/bin/ffmpeg', '/usr/bin/ssh'])
  return {
    env: { PATH: '/usr/local/bin:/usr/bin', HERMES_API_KEY: 'chat-secret-value', HERMES_AUDIO_SESSION_TOKEN: 'audio-secret-value', REALHERMES_LOCAL_ARTIFACT_ROOTS: '/srv/art' },
    nodeVersion: '24.11.0', home, root, now: () => now,
    fileInfo: (path: string) => tree[path] ?? { kind: 'missing' },
    isExecutable: (path: string) => executables.has(path),
    probePython: vi.fn(async () => true), portFree: vi.fn(async () => true),
    ...overrides,
  }
}
const status = (result: Awaited<ReturnType<typeof runDoctor>>, name: string) => result.checks.find(check => check.name === name)?.status

it('passes a fully prepared machine and reports nothing secret or machine-specific', async () => {
  const result = await runDoctor(facts())
  expect(result.checks.filter(check => check.status !== 'ok')).toEqual([])
  expect(result.failures).toBe(0)
  const report = formatReport(result)
  for (const leaked of ['chat-secret-value', 'audio-secret-value', home, root, '/srv/art']) expect(report).not.toContain(leaked)
  expect(report).toContain('0 failures, 0 warnings')
})
it.each([['20.19.0', false], ['22.11.0', false], ['22.12.0', true], ['23.6.0', false], ['24.0.0', true], ['25.2.1', false], ['26.0.0', true], ['27.1.0', true]])('supports Node %s: %s', (version, supported) => {
  expect(nodeSupported(version)).toBe(supported)
})
it('fails an unsupported Node, a missing 2x4 model and invalid explicit settings', async () => {
  const result = await runDoctor(facts({
    nodeVersion: '23.6.0',
    env: { PATH: '/usr/bin', REALHERMES_POPPLER_DIR: 'relative/bin', REALHERMES_LOCAL_ARTIFACT_ROOTS: '/', REALHERMES_TUNNEL: '1', REALHERMES_SSH_ALIAS: '-oProxyCommand=sh' },
  }, { [`${root}/public/models/realhermes-idle.glb`]: { kind: 'missing' } }))
  for (const name of ['Node.js', '2x4 model', 'PDF rendering (Poppler)', 'Approved local folders', 'Production settings']) expect(status(result, name)).toBe('fail')
  expect(result.failures).toBe(5)
})
it('rejects a model file that is not glTF binary', async () => {
  const result = await runDoctor(facts({}, { [`${root}/public/models/realhermes-idle.glb`]: { ...glb, head: Buffer.from('<htm') } }))
  expect(status(result, '2x4 model')).toBe('fail')
})
it('treats missing optional pieces as warnings that keep the exit status successful', async () => {
  const result = await runDoctor(facts({
    env: { PATH: '/opt/empty' }, probePython: async () => false, portFree: async (port: number) => port !== 9119,
  }, { [`${root}/dist/index.html`]: { kind: 'missing' }, [`${root}/.env`]: { kind: 'file', size: 10, mtimeMs: now, mode: 0o100644, head: Buffer.from('A=1\n') } }))
  for (const name of ['Production build', 'Chat gateway', 'Audio backend', 'PDF rendering (Poppler)', 'Hermes Python', 'Hermes CLI', 'ffmpeg', 'Ports', '.env file']) expect(status(result, name)).toBe('warn')
  expect(result.failures).toBe(0)
  expect(result.checks.find(check => check.name === 'Ports')?.detail).toContain('9119')
})
it('requires ssh only when the reverse tunnel is enabled', async () => {
  const withoutSsh = (env: Record<string, string>) => runDoctor(facts({ env: { ...facts().env, ...env }, isExecutable: (path: string) => path !== '/usr/bin/ssh' && facts().isExecutable(path) }))
  expect(status(await withoutSsh({}), 'SSH tunnel')).toBe('ok')
  expect(status(await withoutSsh({ REALHERMES_TUNNEL: '1' }), 'SSH tunnel')).toBe('fail')
})
it('finds executables only in absolute PATH directories, or at an explicit absolute path', () => {
  const present = (path: string) => ['hermes', 'bin/hermes', '/opt/hermes/bin/hermes', '/usr/bin/python3'].includes(path)
  expect(findExecutable('hermes', ':.:bin:/opt/hermes/bin', present)).toBe('/opt/hermes/bin/hermes')
  expect(findExecutable('hermes', '.:bin', present)).toBeUndefined()
  expect(findExecutable('/usr/bin/python3', '', present)).toBe('/usr/bin/python3')
  expect(findExecutable('venv/bin/python', '/usr/bin', present)).toBeUndefined()
})
it('reads file facts without following a symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rh-doctor-'))
  try {
    await writeFile(join(dir, 'frame.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])); await chmod(join(dir, 'frame.jpg'), 0o600)
    await symlink(join(dir, 'frame.jpg'), join(dir, 'link.jpg')); await mkdir(join(dir, 'folder'))
    expect(fileInfo(join(dir, 'frame.jpg'))).toMatchObject({ kind: 'file', size: 5, head: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) })
    expect(fileInfo(join(dir, 'frame.jpg')).mode & 0o777).toBe(0o600)
    expect(fileInfo(join(dir, 'link.jpg'))).toEqual({ kind: 'symlink' })
    expect(fileInfo(join(dir, 'folder'))).toEqual({ kind: 'directory' })
    expect(fileInfo(join(dir, 'absent'))).toEqual({ kind: 'missing' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
it('probes the Hermes Python with fixed arguments and no shell', async () => {
  const execute = vi.fn((_file: string, _args: string[], _options: object, done: (error: Error | null) => void) => done(null))
  expect(await probePython('/opt/hermes/venv/bin/python', execute)).toBe(true)
  const [file, args, options] = execute.mock.calls[0]
  expect(file).toBe('/opt/hermes/venv/bin/python'); expect(args[0]).toBe('-c'); expect(args).toHaveLength(2)
  expect(options).toMatchObject({ shell: false, timeout: 10_000 })
  expect(await probePython('/opt/hermes/venv/bin/python', (_file: string, _args: string[], _options: object, done: (error: Error | null) => void) => done(new Error('exit 1')))).toBe(false)
})
