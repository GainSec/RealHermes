import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startProduction, productionConfig, probeLocalReadiness } from './production.mjs'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
function harness(env = {}) {
  const runtime = Object.assign(new EventEmitter(), { env: { PATH: '/usr/bin', HOME: '/home/operator', API_SERVER_KEY: 'chat-secret', HERMES_AUDIO_SESSION_TOKEN: 'stale-secret', VITE_BAD: 'browser-secret', ...env }, platform: 'darwin', execPath: '/node', exitCode: 0 })
  const children: (EventEmitter & { pid: number })[] = []
  const spawn = vi.fn((_command: string, _args: string[], _options: any) => {
    const child = Object.assign(new EventEmitter(), { pid: 100 + children.length }); children.push(child); return child
  })
  return { runtime, children, spawn, kill: vi.fn(), checkPort: vi.fn(async (_port: number) => {}), probe: vi.fn(async (_config: any, _token: string, _signal: AbortSignal) => true), log: vi.fn() }
}
it('validates loopback ports and SSH aliases before spawning', () => {
  expect(productionConfig({})).toMatchObject({ port: 5173, audioPort: 9119, tunnel: false, alias: 'frame', remotePort: 5173 })
  for (const env of [{ REALHERMES_PORT: '0' }, { REALHERMES_PORT: '9119' }, { REALHERMES_TUNNEL: 'maybe' }, { REALHERMES_SSH_ALIAS: '-evil' }, { REALHERMES_SSH_ALIAS: 'frame;sh' }]) expect(() => productionConfig(env)).toThrow()
})
it('checks both required ports before launch and refuses occupancy without kills', async () => {
  const h = harness(); h.checkPort.mockRejectedValueOnce(new Error('occupied'))
  await expect(startProduction(h)).rejects.toThrow()
  expect(h.spawn).not.toHaveBeenCalled(); expect(h.kill).not.toHaveBeenCalled()
  expect(h.runtime.listenerCount('SIGINT')).toBe(0)
  const next = harness(); next.checkPort.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('occupied app'))
  await expect(startProduction(next)).rejects.toThrow()
  expect(next.checkPort.mock.calls).toEqual([[5173], [9119]])
  expect(next.spawn).not.toHaveBeenCalled()
})
it('starts only two local services with isolated ephemeral credentials, no browser env, no raw child logs', async () => {
  const h = harness(); const control = await startProduction(h)
  expect(h.spawn.mock.calls.map(call => call[0])).toEqual(['python3', '/node'])
  const [audio, app] = h.spawn.mock.calls.map(call => call[2])
  const token = audio.env.HERMES_DASHBOARD_SESSION_TOKEN
  expect(token).toMatch(/^[a-f0-9]{64}$/); expect(token).not.toBe('stale-secret')
  expect(app.env.HERMES_AUDIO_SESSION_TOKEN).toBe(token)
  expect(app.env.HERMES_API_KEY).toBe('chat-secret')
  expect(audio.env.HERMES_API_KEY).toBeUndefined(); expect(audio.env.API_SERVER_KEY).toBeUndefined()
  expect(app.env.HERMES_DASHBOARD_SESSION_TOKEN).toBeUndefined()
  for (const options of [audio, app]) { expect(options.env.VITE_BAD).toBeUndefined(); expect(options.stdio).toBe('ignore'); expect(options.detached).toBe(true) }
  expect(h.runtime.env.HERMES_AUDIO_SESSION_TOKEN).toBe('stale-secret')
  expect(JSON.stringify(h.log.mock.calls)).not.toMatch(/secret|[a-f0-9]{64}|\/home/)
  control.stop(); await vi.advanceTimersByTimeAsync(3000)
  const second = harness(); const other = await startProduction(second)
  expect(second.spawn.mock.calls[0][2].env.HERMES_DASHBOARD_SESSION_TOKEN).not.toBe(token); other.stop()
})
it('does not announce ready or start SSH until actual local readiness succeeds', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); h.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const control = await startProduction(h)
  expect(control.status()).toMatchObject({ ready: false, tunnel: 'waiting' })
  expect(h.children).toHaveLength(2); expect(JSON.stringify(h.log.mock.calls)).not.toContain('Local services ready')
  await vi.advanceTimersByTimeAsync(500)
  expect(control.status().ready).toBe(true); expect(h.children).toHaveLength(3)
  expect(JSON.stringify(h.log.mock.calls)).toContain('Local services ready')
  control.stop()
})
it('times out failed readiness, stops owned local groups and returns failure', async () => {
  const h = harness(); h.probe.mockResolvedValue(false)
  const control = await startProduction(h)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(h.runtime.exitCode).toBe(1); expect(control.status().ready).toBe(false)
  expect(h.kill.mock.calls).toContainEqual([-100, 'SIGTERM']); expect(h.kill.mock.calls).toContainEqual([-101, 'SIGTERM'])
})
it('probes both actual app readiness and authenticated local audio health without claiming provider/chat connectivity', async () => {
  const calls: any[] = []
  const fetcher = vi.fn(async (url, options) => { calls.push([url, options]); return Response.json(String(url).endsWith('/api/ready') ? { appRunning: true, audioConfigured: true, chatConfigured: false } : { ok: true, protocolVersion: 1, pid: 123 }) })
  expect(await probeLocalReadiness(productionConfig({}), 'ephemeral', new AbortController().signal, fetcher)).toBe(true)
  expect(calls.map(call => call[0])).toEqual(['http://127.0.0.1:5173/api/ready', 'http://127.0.0.1:9119/api/host/identity'])
  expect(calls[0][1].headers).toBeUndefined(); expect(calls[1][1].headers).toEqual({ 'X-Hermes-Session-Token': 'ephemeral' })
  fetcher.mockResolvedValue(Response.json({ appRunning: false }))
  expect(await probeLocalReadiness(productionConfig({}), 'ephemeral', new AbortController().signal, fetcher)).toBe(false)
})
it('uses one independent SSH process, local-only forwarding, no connection sharing or secrets', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1', REALHERMES_SSH_ALIAS: 'custom-frame', REALHERMES_PORT: '15173', REALHERMES_FRAME_PORT: '25173' })
  const control = await startProduction(h)
  const [command, args, options] = h.spawn.mock.calls[2]
  expect(command).toBe('ssh'); expect(args).toContain('127.0.0.1:25173:127.0.0.1:15173'); expect(args.at(-1)).toBe('custom-frame')
  for (const option of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ControlPath=none', 'ControlMaster=no', 'ControlPersist=no', 'ServerAliveInterval=10', 'ServerAliveCountMax=3']) expect(args).toContain(option)
  expect(JSON.stringify(options.env)).not.toMatch(/secret|HERMES|API_SERVER_KEY|VITE_/)
  control.stop()
})
it('retries tunnel closes with bounded exponential backoff and no overlapping children', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); const control = await startProduction(h)
  const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000].map(backoff => backoff + 3000)
  for (const delay of delays) {
    const tunnel = h.children.at(-1)!; const count = h.children.length
    tunnel.emit('close', 255); tunnel.emit('close', 255)
    expect(control.status().tunnel).toBe('retrying'); expect(control.status().ready).toBe(true)
    expect(h.kill.mock.calls.every(call => call[0] !== -100 && call[0] !== -101)).toBe(true)
    await vi.advanceTimersByTimeAsync(delay - 1); expect(h.children).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1); expect(h.children).toHaveLength(count + 1)
  }
  control.stop(); await vi.advanceTimersByTimeAsync(3000)
  expect(vi.getTimerCount()).toBe(0)
})
it('does not retry tunnel error until close confirms process exit and resets backoff only after a stable lifetime', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); const control = await startProduction(h)
  h.children[2].emit('error', new Error('secret failure'))
  await vi.advanceTimersByTimeAsync(10_000); expect(h.children).toHaveLength(3)
  h.children[2].emit('close', 255)
  await vi.advanceTimersByTimeAsync(4000); expect(h.children).toHaveLength(4)
  h.children[3].emit('close', 255)
  await vi.advanceTimersByTimeAsync(5000); expect(h.children).toHaveLength(5)
  await vi.advanceTimersByTimeAsync(60_000)
  h.children[4].emit('close', 255)
  await vi.advanceTimersByTimeAsync(4000); expect(h.children).toHaveLength(6)
  expect(JSON.stringify(h.log.mock.calls)).not.toContain('secret')
  control.stop()
})
it.each(['SIGINT', 'SIGTERM'])('cancels tunnel retries promptly on %s and cleans listeners/timers idempotently', async event => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); const control = await startProduction(h)
  h.children[2].emit('close', 255); h.runtime.emit(event); control.stop(); control.stop()
  expect(h.runtime.exitCode).toBe(event === 'SIGINT' ? 130 : 143)
  await vi.advanceTimersByTimeAsync(90_000)
  expect(h.children).toHaveLength(3); expect(vi.getTimerCount()).toBe(0)
  expect(h.runtime.listenerCount('SIGINT')).toBe(0); expect(h.runtime.listenerCount('SIGTERM')).toBe(0); expect(h.runtime.listenerCount('exit')).toBe(0)
})
it.each([[0, 'audio'], [1, 'app']] as const)('treats required child %s exit including code zero as fatal, kills only owned groups and escalates after wrapper close', async (index, label) => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); const control = await startProduction(h)
  h.children[index].emit('close', 0)
  expect(h.runtime.exitCode).toBe(1); expect(control.status().ready).toBe(false)
  expect(JSON.stringify(h.log.mock.calls)).toContain(`Required ${label} service exited.`)
  expect(h.kill.mock.calls).toEqual([[-100, 'SIGTERM'], [-101, 'SIGTERM'], [-102, 'SIGTERM']])
  control.stop(); h.children.forEach(child => child.emit('close', 0))
  await vi.advanceTimersByTimeAsync(2999); expect(h.kill).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(h.kill.mock.calls.slice(3)).toEqual([[-100, 'SIGKILL'], [-101, 'SIGKILL'], [-102, 'SIGKILL']])
  expect(vi.getTimerCount()).toBe(0)
  for (const child of h.children) { expect(child.listenerCount('error')).toBe(0); expect(child.listenerCount('close')).toBe(0) }
})
it('aborts pending readiness on stop and never announces ready from its late result', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); let finish!: (value: boolean) => void
  h.probe.mockImplementation((_config, _token, signal) => new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => resolve(false), { once: true }) }))
  const pending = startProduction(h)
  await vi.waitFor(() => expect(h.children).toHaveLength(2))
  h.runtime.emit('SIGTERM'); finish(true)
  const control = await pending
  expect(control.status().ready).toBe(false); expect(h.children).toHaveLength(2)
  expect(JSON.stringify(h.log.mock.calls)).not.toContain('Local services ready')
  await vi.advanceTimersByTimeAsync(3000)
})
it('handles async local spawn error and synchronous partial spawn failure without raw errors or leaks', async () => {
  const h = harness(); const control = await startProduction(h)
  h.children[0].emit('error', new Error('chat-secret'))
  expect(h.runtime.exitCode).toBe(1); expect(control.status().stopping).toBe(true)
  await vi.advanceTimersByTimeAsync(3000)
  const other = harness(); other.spawn.mockImplementationOnce(() => { const child = Object.assign(new EventEmitter(), { pid: 100 }); other.children.push(child); return child }).mockImplementationOnce(() => { throw new Error('chat-secret') })
  await expect(startProduction(other)).rejects.toThrow('Production startup failed')
  expect(other.kill.mock.calls).toEqual([[-100, 'SIGTERM']]); await vi.advanceTimersByTimeAsync(3000)
  expect(other.runtime.listenerCount('SIGTERM')).toBe(0)
  expect(JSON.stringify([...h.log.mock.calls, ...other.log.mock.calls])).not.toContain('secret')
})
it('keeps local services healthy when SSH cannot spawn and retries at the same bounded schedule', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1' })
  const normal = h.spawn.getMockImplementation()!
  h.spawn.mockImplementation((command, args, options) => { if (command === 'ssh') throw new Error('private spawn detail'); return normal(command, args, options) })
  const control = await startProduction(h)
  expect(control.status()).toMatchObject({ ready: true, tunnel: 'retrying', stopping: false })
  await vi.advanceTimersByTimeAsync(1000); expect(h.spawn).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1999); expect(h.spawn).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1); expect(h.spawn).toHaveBeenCalledTimes(5)
  expect(h.kill).not.toHaveBeenCalled(); expect(h.runtime.exitCode).toBe(0)
  expect(JSON.stringify(h.log.mock.calls)).not.toContain('private'); control.stop()
})
it('returns useful occupied-port status without leaking raw exception details through the CLI', async () => {
  const h = harness(); h.checkPort.mockRejectedValueOnce(new Error('secret'))
  await expect(startProduction(h)).rejects.toThrow('Required loopback port 5173 unavailable')
})
it('refuses to launch required children after interruption during asynchronous preflight', async () => {
  const h = harness(); let release!: () => void
  h.checkPort.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  const pending = startProduction(h)
  await Promise.resolve(); h.runtime.emit('SIGTERM'); release()
  const control = await pending
  expect(control.status().stopping).toBe(true); expect(h.spawn).not.toHaveBeenCalled(); expect(h.runtime.exitCode).toBe(143)
  await vi.advanceTimersByTimeAsync(3000); expect(h.runtime.listenerCount('SIGTERM')).toBe(0)
})
it('provides one production command that builds once then launches without Vite dev or preview', async () => {
  const { readFile } = await import('node:fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.scripts.prod).toBe('npm run build && node scripts/production.mjs')
})
it('keeps signal handlers through the grace period so repeated signals remain idempotent', async () => {
  const h = harness(); await startProduction(h)
  h.runtime.emit('SIGTERM')
  expect(h.runtime.listenerCount('SIGTERM')).toBe(1); expect(h.runtime.listenerCount('SIGINT')).toBe(1)
  h.runtime.emit('SIGTERM'); h.runtime.emit('SIGINT')
  expect(h.kill.mock.calls).toEqual([[-100, 'SIGTERM'], [-101, 'SIGTERM']])
  await vi.advanceTimersByTimeAsync(3000)
  expect(h.runtime.listenerCount('SIGTERM')).toBe(0)
})

it('waits for retired SSH group cleanup before starting the replacement backoff', async () => {
  const h = harness({ REALHERMES_TUNNEL: '1' }); const control = await startProduction(h)
  h.children[2].emit('close', 255)
  await vi.advanceTimersByTimeAsync(1000); expect(h.children).toHaveLength(3)
  await vi.advanceTimersByTimeAsync(2000); expect(h.children).toHaveLength(3)
  expect(h.kill.mock.calls).toContainEqual([-102, 'SIGKILL'])
  await vi.advanceTimersByTimeAsync(999); expect(h.children).toHaveLength(3)
  await vi.advanceTimersByTimeAsync(1); expect(h.children).toHaveLength(4)
  control.stop()
})
it('gives approved local artifact folders only to the app, never to the Hermes audio child', async () => {
  const h = harness({ REALHERMES_LOCAL_ARTIFACT_ROOTS: '/Volumes/Shared/Art' }); const control = await startProduction(h)
  const [audio, app] = h.spawn.mock.calls.map(call => call[2])
  expect(app.env.REALHERMES_LOCAL_ARTIFACT_ROOTS).toBe('/Volumes/Shared/Art'); expect(audio.env.REALHERMES_LOCAL_ARTIFACT_ROOTS).toBeUndefined()
  control.stop()
})
