import { spawn as spawnChild } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'

export async function ensurePortFree() {
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error('Cannot bind 127.0.0.1:9119; free the dashboard port before running dev:full.')))
    server.listen({ host: '127.0.0.1', port: 9119, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()))
  })
}

export async function startDevelopment({ runtime = process, spawn = spawnChild, kill = process.kill.bind(process), ensurePortFree: checkPort = ensurePortFree } = {}) {
  await checkPort()
  const token = randomBytes(32).toString('hex')
  const env = {
    ...runtime.env,
    HERMES_DASHBOARD_SESSION_TOKEN: token,
    HERMES_AUDIO_SESSION_TOKEN: token,
    HERMES_AUDIO_BASE_URL: 'http://127.0.0.1:9119',
    HERMES_API_KEY: runtime.env.HERMES_API_KEY || runtime.env.API_SERVER_KEY,
  }
  // Retain ownership after wrapper exit: its descendants may still be alive.
  const children = new Set()
  const detached = runtime.platform !== 'win32'
  let stopping = false
  let escalation
  function signalChildren(signal) {
    for (const child of children) {
      if (!child.pid) continue
      try {
        // Each detached child owns a new group, including npm/watch descendants.
        if (detached) kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if (error.code !== 'ESRCH') runtime.exitCode = 1
      }
    }
  }
  function stop() {
    if (stopping) return
    stopping = true
    signalChildren('SIGTERM')
    if (children.size) escalation = setTimeout(() => { signalChildren('SIGKILL'); removeListeners() }, 3000)
    else removeListeners()
  }
  const onInterrupt = () => { runtime.exitCode = 130; stop() }
  const onTerminate = () => { runtime.exitCode = 143; stop() }
  const removeListeners = () => {
    runtime.removeListener('SIGINT', onInterrupt)
    runtime.removeListener('SIGTERM', onTerminate)
    runtime.removeListener('exit', stop)
    clearTimeout(escalation)
  }
  runtime.once('SIGINT', onInterrupt)
  runtime.once('SIGTERM', onTerminate)
  runtime.once('exit', stop)
  try {
    for (const [command, args] of [
      ['hermes', ['serve', '--skip-build', '--host', '127.0.0.1', '--port', '9119']],
      [runtime.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:client']],
      [runtime.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:server']],
    ]) {
      const child = spawn(command, args, { env, stdio: 'inherit', detached })
      children.add(child)
      child.once('error', () => { runtime.exitCode = 1; stop() })
      child.once('close', code => {
        if (!stopping) { runtime.exitCode = code ?? 1; stop() }
      })
    }
  } catch (error) {
    stop()
    if (!children.size) removeListeners()
    throw error
  }
  return stop
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config')
  try { await startDevelopment() }
  catch { console.error('Unable to launch dev:full. Ensure port 9119 is free and Hermes is installed on PATH.'); process.exitCode = 1 }
}
