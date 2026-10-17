import { spawn as spawnChild } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'

function port(value, fallback) {
  const result = Number(value ?? fallback)
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error('Invalid production port')
  return result
}
export function productionConfig(env) {
  const config = {
    port: port(env.REALHERMES_PORT, 5173), audioPort: port(env.REALHERMES_AUDIO_PORT, 9119),
    remotePort: port(env.REALHERMES_FRAME_PORT, 5173),
    tunnel: env.REALHERMES_TUNNEL === '1', alias: env.REALHERMES_SSH_ALIAS ?? 'frame',
    python: env.HERMES_PYTHON || 'python3',
  }
  if (config.port === config.audioPort) throw new Error('Required local ports must differ')
  if (env.REALHERMES_TUNNEL !== undefined && !['0', '1'].includes(env.REALHERMES_TUNNEL)) throw new Error('REALHERMES_TUNNEL must be 0 or 1')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.alias)) throw new Error('Invalid SSH alias')
  return config
}
export async function ensurePortFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`Required loopback port ${port} unavailable; stop its owner yourself or configure another port.`)))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()))
  })
}
export async function probeLocalReadiness(config, token, signal, fetcher = fetch) {
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(1500)])
    const app = await fetcher(`http://127.0.0.1:${config.port}/api/ready`, { signal: bounded, redirect: 'error' })
    if (!app.ok) return false
    const ready = await app.json()
    if (ready.appRunning !== true || ready.audioConfigured !== true) return false
    const audio = await fetcher(`http://127.0.0.1:${config.audioPort}/api/host/identity`, {
      signal: bounded, redirect: 'error', headers: { 'X-Hermes-Session-Token': token },
    })
    if (!audio.ok) return false
    const identity = await audio.json()
    return identity.ok === true && identity.protocolVersion === 1 && Number.isInteger(identity.pid)
  } catch { return false }
}
function without(env, predicate) { return Object.fromEntries(Object.entries(env).filter(([key]) => !predicate(key))) }
export async function startProduction({ runtime = process, spawn = spawnChild, kill = process.kill.bind(process), checkPort = ensurePortFree, probe = probeLocalReadiness, log = console.log } = {}) {
  const config = productionConfig(runtime.env)
  const token = randomBytes(32).toString('hex')
  const base = without(runtime.env, key => key.startsWith('VITE_') || ['HERMES_AUDIO_SESSION_TOKEN', 'HERMES_DASHBOARD_SESSION_TOKEN'].includes(key))
  const audioEnv = without(base, key => ['HERMES_API_KEY', 'API_SERVER_KEY', 'HERMES_CHAT_BASE_URL', 'REALHERMES_LOCAL_ARTIFACT_ROOTS'].includes(key))
  Object.assign(audioEnv, { HERMES_DASHBOARD_SESSION_TOKEN: token, REALHERMES_AUDIO_PORT: String(config.audioPort) })
  const appEnv = { ...base, NODE_ENV: 'production', REALHERMES_PORT: String(config.port), HERMES_API_KEY: base.HERMES_API_KEY || base.API_SERVER_KEY,
    HERMES_AUDIO_SESSION_TOKEN: token, HERMES_AUDIO_BASE_URL: `http://127.0.0.1:${config.audioPort}` }
  const detached = runtime.platform !== 'win32'
  const children = new Set()
  const listeners = new Map()
  const retiredTimers = new Set()
  const state = { ready: false, tunnel: config.tunnel ? 'waiting' : 'disabled', stopping: false }
  const controller = new AbortController()
  let readinessTimer; let escalation; let retryTimer; let tunnelChild; let retryAttempt = 0
  function signal(signal, targets = children) {
    for (const child of targets) {
      if (!child.pid) continue
      try { if (detached) kill(-child.pid, signal); else child.kill(signal) }
      catch (error) { if (error.code !== 'ESRCH') runtime.exitCode = 1 }
    }
  }
  function removeListeners() { runtime.off('SIGINT', interrupt); runtime.off('SIGTERM', terminate); runtime.off('exit', stop) }
  function stop() {
    if (state.stopping) return
    state.stopping = true; state.ready = false; state.tunnel = config.tunnel ? 'stopped' : 'disabled'; controller.abort(); clearTimeout(readinessTimer); clearTimeout(retryTimer)
    log('Stopping owned production services.'); signal('SIGTERM')
    if (!children.size) { removeListeners(); return }
    escalation = setTimeout(() => {
      signal('SIGKILL'); removeListeners()
      for (const timer of retiredTimers) clearTimeout(timer)
      retiredTimers.clear()
      for (const [child, handlers] of listeners) { child.off('error', handlers.error); child.off('close', handlers.close) }
      listeners.clear(); children.clear(); clearTimeout(escalation)
    }, 3000)
  }
  function interrupt() { runtime.exitCode = 130; stop() }
  function terminate() { runtime.exitCode = 143; stop() }
  runtime.on('SIGINT', interrupt); runtime.on('SIGTERM', terminate); runtime.once('exit', stop)
  function launch(command, args, env, required = true, label = 'local') {
    const child = spawn(command, args, { env, stdio: 'ignore', detached }); children.add(child)
    const error = () => {
      if (state.stopping) return
      if (required) { runtime.exitCode = 1; log(`Required ${label} service failed.`); stop() }
      else log('Tunnel attempt failed; waiting for process close before retry.')
    }
    const close = () => {
      if (state.stopping) return
      if (required) { runtime.exitCode = 1; log(`Required ${label} service exited.`); stop() }
      else {
        if (tunnelChild !== child) return
        tunnelChild = undefined
        state.tunnel = 'retrying'
        log('Tunnel closed; retiring owned group before retry.')
        // Retire this owned SSH group promptly, including ProxyCommand descendants.
        signal('SIGTERM', [child])
        const timer = setTimeout(() => {
          signal('SIGKILL', [child]); children.delete(child)
          child.off('error', error); child.off('close', close); listeners.delete(child); retiredTimers.delete(timer)
          scheduleTunnel()
        }, 3000)
        retiredTimers.add(timer)
        if (Date.now() - startedAt >= 60_000) retryAttempt = 0
      }
    }
    const startedAt = Date.now()
    listeners.set(child, { error, close }); child.on('error', error); child.once('close', close)
    return child
  }
  function scheduleTunnel() {
    if (state.stopping) return
    state.tunnel = 'retrying'
    const delay = Math.min(1000 * 2 ** Math.min(retryAttempt++, 5), 30_000)
    log(`Tunnel unavailable; retry in ${delay / 1000}s. Local services remain running.`)
    retryTimer = setTimeout(startTunnel, delay)
  }
  function startTunnel() {
    if (state.stopping || tunnelChild) return
    state.tunnel = 'connecting'
    try { tunnelChild = launch('ssh', ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ForkAfterAuthentication=no', '-o', 'PermitLocalCommand=no', '-R', `127.0.0.1:${config.remotePort}:127.0.0.1:${config.port}`, config.alias], Object.fromEntries(Object.entries(base).filter(([key]) => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'].includes(key))), false) }
    catch { scheduleTunnel(); return }
    log('Tunnel connecting; remote availability not probed.')
  }
  const deadline = Date.now() + 30_000
  async function readiness() {
    const ready = await probe(config, token, controller.signal)
    if (state.stopping) return
    if (ready) {
      state.ready = true
      log(`Local services ready: http://127.0.0.1:${config.port}; chat ${appEnv.HERMES_API_KEY ? 'configured' : 'not configured'}; audio configured; upstream connectivity not probed.`)
      if (config.tunnel) startTunnel()
    } else if (Date.now() >= deadline) { runtime.exitCode = 1; log('Local readiness timed out.'); stop() }
    else readinessTimer = setTimeout(() => { void readiness() }, 500)
  }
  const control = { stop, status: () => ({ ...state }) }
  for (const requiredPort of [config.port, config.audioPort]) {
    if (state.stopping) return control
    try { await checkPort(requiredPort) }
    catch { removeListeners(); throw new Error(`Required loopback port ${requiredPort} unavailable; stop its owner yourself or configure another port.`) }
  }
  if (state.stopping) return control
  try {
    launch(config.python, [fileURLToPath(new URL('./hermes-production.py', import.meta.url))], audioEnv, true, 'audio')
    launch(runtime.execPath, ['--import', 'tsx', fileURLToPath(new URL('../server/production-index.ts', import.meta.url))], appEnv, true, 'app')
    log('Starting local audio and built production app; checking local readiness.')
    await readiness()
  } catch { runtime.exitCode = 1; stop(); throw new Error('Production startup failed') }
  return control
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config')
  try { await startProduction() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
