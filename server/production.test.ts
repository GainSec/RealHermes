import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import request from './test-request.ts'
import { createProductionApp, attachProductionLifecycle, createFileLog } from './production.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'realhermes-production-')); roots.push(root)
  await mkdir(join(root, 'assets')); await mkdir(join(root, 'models'))
  await writeFile(join(root, 'index.html'), '<html>production shell</html>')
  await writeFile(join(root, 'assets', 'app-Abc123.js'), 'production script')
  await writeFile(join(root, 'models', 'idle.glb'), Buffer.from([1, 2, 3]))
  const service = { acquire: vi.fn(), page: vi.fn(), cleanup: vi.fn(), dispose: vi.fn(async () => {}) }
  return { root, service, ...createProductionApp({ distPath: root, artifactService: service, apiKey: 'secret', audioSessionToken: 'audio-secret' }) }
}
it('serves built shell, SPA routes, static scripts and binary models from one origin', async () => {
  const { app } = await fixture()
  for (const path of ['/', '/operator/reconnect']) {
    const res = await request(app).get(path)
    expect(res.status).toBe(200); expect(res.body.toString()).toContain('production shell')
    expect(res.headers['cache-control']).toContain('no-cache')
  }
  const js = await request(app).get('/assets/app-Abc123.js')
  expect(js.body.toString()).toContain('production script'); expect(js.headers['cache-control']).toContain('immutable')
  expect((await request(app).get('/models/idle.glb')).body).toEqual(Buffer.from([1, 2, 3]))
})
it('never swallows API or missing asset routes with SPA HTML', async () => {
  const { app } = await fixture()
  for (const path of ['/api', '/api/missing', '/api/audio/missing', '/assets/missing.js', '/models/missing.glb', '/.env']) {
    const res = await request(app).get(path)
    expect(res.status).toBe(404); expect(res.body.toString()).not.toContain('production shell')
  }
  expect((await request(app).post('/operator/reconnect')).status).toBe(404)
})
it('sets security headers on shell, model, API and errors without breaking microphone, XR or blob playback', async () => {
  const { app } = await fixture()
  for (const path of ['/', '/models/idle.glb', '/api/health', '/api/missing']) {
    const res = await request(app).get(path)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['content-security-policy']).toContain("connect-src 'self' blob: https://cdn.jsdelivr.net")
    expect(res.headers['content-security-policy']).toContain("script-src 'self' blob: 'wasm-unsafe-eval'")
    expect(res.headers['permissions-policy']).toContain('microphone=(self)')
    expect(res.headers['permissions-policy']).toContain('xr-spatial-tracking=(self)')
    expect(res.headers['x-powered-by']).toBeUndefined()
  }
})
it('reports app readiness and configuration without claiming upstream connectivity or exposing paths/secrets', async () => {
  const { app, dispose } = await fixture()
  const res = await request(app).get('/api/ready')
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ appRunning: true, chatConfigured: true, audioConfigured: true, upstreamConnectivity: 'not-probed' })
  expect(JSON.stringify(res.body)).not.toMatch(/secret|Users|private/)
  await dispose()
  expect((await request(app).get('/api/ready')).status).toBe(503)
})
it('disposes ephemeral artifacts once on server close and signal shutdown, with forced connection cleanup', async () => {
  vi.useFakeTimers()
  try {
    const { dispose, service } = await fixture()
    const server = Object.assign(new EventEmitter(), { close: vi.fn(), closeAllConnections: vi.fn() })
    const runtime = new EventEmitter()
    const stop = attachProductionLifecycle(server, dispose, runtime)
    runtime.emit('SIGTERM'); stop()
    expect(server.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1)
    server.emit('close'); await Promise.resolve()
    expect(service.dispose).toHaveBeenCalledTimes(1)
    expect(runtime.listenerCount('SIGTERM')).toBe(0); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
it('allows existing Troika worker blob imports while retaining strict artifact sandbox headers', async () => {
  const { app, service } = await fixture()
  const shell = await request(app).get('/')
  expect(shell.headers['content-security-policy']).toContain("script-src 'self' blob:")
  service.page.mockResolvedValue({ mime: 'image/png', bytes: Buffer.from([1]) })
  const page = await request(app).get(`/api/artifacts/${'a'.repeat(32)}/pages/1`)
  expect(page.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
})
it('treats a natural server close as stopped so repeated stop cannot create timers or close twice', async () => {
  vi.useFakeTimers()
  try {
    const { dispose, service } = await fixture()
    const server = Object.assign(new EventEmitter(), { close: vi.fn(), closeAllConnections: vi.fn() })
    const runtime = new EventEmitter(); const stop = attachProductionLifecycle(server, dispose, runtime)
    server.emit('close'); await Promise.resolve(); stop(); stop()
    expect(server.close).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
    expect(service.dispose).toHaveBeenCalledTimes(1); expect(runtime.listenerCount('SIGINT')).toBe(0)
  } finally { vi.useRealTimers() }
})
it('reports missing chat/audio as configuration rather than connectivity or a broken app', async () => {
  const { root, service } = await fixture()
  const { app, dispose } = createProductionApp({ distPath: root, artifactService: service })
  expect((await request(app).get('/api/ready')).body).toEqual({ appRunning: true, chatConfigured: false, audioConfigured: false, upstreamConnectivity: 'not-probed' })
  await dispose(); await dispose(); expect(service.dispose).toHaveBeenCalledTimes(1)
})
it('retains server signal handling until close to make repeated shutdown signals harmless', async () => {
  vi.useFakeTimers()
  try {
    const { dispose } = await fixture()
    const server = Object.assign(new EventEmitter(), { close: vi.fn(), closeAllConnections: vi.fn() })
    const runtime = new EventEmitter(); attachProductionLifecycle(server, dispose, runtime)
    runtime.emit('SIGINT'); expect(runtime.listenerCount('SIGINT')).toBe(1)
    runtime.emit('SIGINT'); runtime.emit('SIGTERM'); expect(server.close).toHaveBeenCalledTimes(1)
    server.emit('close'); expect(runtime.listenerCount('SIGINT')).toBe(0); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('appends relay diagnostics to a private log file and never lets logging break a turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'realhermes-log-')); roots.push(root)
  const file = join(root, 'logs', 'realhermes-relay.log')
  const log = createFileLog(file)
  log('{"event":"artifact_candidate_failed"}'); log('{"event":"artifact_verified"}')
  expect(await readFile(file, 'utf8')).toBe('{"event":"artifact_candidate_failed"}\n{"event":"artifact_verified"}\n')
  expect((await stat(file)).mode & 0o777).toBe(0o600); expect((await stat(join(root, 'logs'))).mode & 0o777).toBe(0o700)
  expect(() => createFileLog(join(file, 'not-a-directory', 'x.log'))('line')).not.toThrow()
})
