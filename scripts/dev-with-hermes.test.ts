import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

function harness() {
  const runtime = Object.assign(new EventEmitter(), { env: { API_SERVER_KEY: 'gateway-secret', HERMES_AUDIO_SESSION_TOKEN: 'stale' }, platform: 'darwin', exitCode: 0 })
  const children: (EventEmitter & { pid: number })[] = []
  const spawn = vi.fn(() => { const child = Object.assign(new EventEmitter(), { pid: 100 + children.length }); children.push(child); return child })
  const kill = vi.fn()
  const ensurePortFree = vi.fn(async () => {})
  return { runtime, children, spawn, kill, ensurePortFree }
}

it('launches only dashboard and existing dev processes with one ephemeral random token', async () => {
  const { startDevelopment } = await import('./dev-with-hermes.mjs')
  const h = harness()
  const stop = await startDevelopment(h)
  expect(h.ensurePortFree).toHaveBeenCalledBefore(h.spawn)
  expect(h.spawn.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['hermes', ['serve', '--skip-build', '--host', '127.0.0.1', '--port', '9119']],
    ['npm', ['run', 'dev:client']], ['npm', ['run', 'dev:server']],
  ])
  const envs = h.spawn.mock.calls.map(call => call[2].env)
  const token = envs[0].HERMES_DASHBOARD_SESSION_TOKEN
  expect(token).toMatch(/^[a-f0-9]{64}$/)
  expect(token).not.toBe('stale')
  for (const env of envs) {
    expect(env.HERMES_DASHBOARD_SESSION_TOKEN).toBe(token)
    expect(env.HERMES_AUDIO_SESSION_TOKEN).toBe(token)
    expect(env.HERMES_AUDIO_BASE_URL).toBe('http://127.0.0.1:9119')
    expect(env.HERMES_API_KEY).toBe('gateway-secret')
  }
  expect(h.runtime.env.HERMES_AUDIO_SESSION_TOKEN).toBe('stale')
  stop(); stop()
  expect(h.kill.mock.calls).toEqual([[-100, 'SIGTERM'], [-101, 'SIGTERM'], [-102, 'SIGTERM']])
  h.children.forEach(child => child.emit('close', 0))
  const other = harness(); const otherStop = await startDevelopment(other)
  expect(other.spawn.mock.calls[0][2].env.HERMES_DASHBOARD_SESSION_TOKEN).not.toBe(token)
  otherStop(); other.children.forEach(child => child.emit('close', 0))
})

it('refuses an occupied dashboard port without spawning or killing anything', async () => {
  const { startDevelopment } = await import('./dev-with-hermes.mjs')
  const h = harness(); h.ensurePortFree.mockRejectedValue(new Error('Port 9119 is in use'))
  await expect(startDevelopment(h)).rejects.toThrow('9119')
  expect(h.spawn).not.toHaveBeenCalled(); expect(h.kill).not.toHaveBeenCalled()
})

it.each(['SIGINT', 'SIGTERM', 'exit', 'error', 'close'])('cleans up only owned children on %s', async event => {
  const { startDevelopment } = await import('./dev-with-hermes.mjs')
  const h = harness(); await startDevelopment(h)
  if (event === 'error') h.children[0].emit('error', new Error('spawn failed'))
  else if (event === 'close') h.children[0].emit('close', 1)
  else h.runtime.emit(event)
  expect(h.kill.mock.calls.map(call => call[0])).toEqual([-100, -101, -102])
  h.children.forEach(child => child.emit('close', 0))
})

it('cleans up already launched children if a later spawn throws', async () => {
  const { startDevelopment } = await import('./dev-with-hermes.mjs')
  const h = harness(); h.spawn.mockImplementationOnce(() => { const child = Object.assign(new EventEmitter(), { pid: 100 }); h.children.push(child); return child }).mockImplementationOnce(() => { throw new Error('launch failed') })
  await expect(startDevelopment(h)).rejects.toThrow('launch failed')
  expect(h.kill.mock.calls).toEqual([[-100, 'SIGTERM']])
  h.children.forEach(child => child.emit('close', 0))
})

it('forces cleanup of owned groups even after all process wrappers have closed', async () => {
  const { startDevelopment } = await import('./dev-with-hermes.mjs')
  const h = harness(); const stop = await startDevelopment(h)
  stop()
  h.children.forEach(child => child.emit('close', 0))
  vi.advanceTimersByTime(3000)
  expect(h.kill.mock.calls).toEqual([
    [-100, 'SIGTERM'], [-101, 'SIGTERM'], [-102, 'SIGTERM'],
    [-100, 'SIGKILL'], [-101, 'SIGKILL'], [-102, 'SIGKILL'],
  ])
  expect(h.runtime.listenerCount('SIGINT')).toBe(0)
  expect(h.runtime.listenerCount('SIGTERM')).toBe(0)
  expect(h.runtime.listenerCount('exit')).toBe(0)
})
