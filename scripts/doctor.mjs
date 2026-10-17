import { execFile } from 'node:child_process'
import { closeSync, constants, lstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { relayOptionsFromEnv } from '../server/config.ts'
import { parseLocalArtifactRoots } from '../server/local-artifacts.ts'
import { findPoppler, isExecutableFile } from '../server/poppler.ts'
import { ensurePortFree, productionConfig } from './production.mjs'

// Read-only preflight for a RealHermes checkout (npm run doctor). It never starts, stops or kills a process, never
// writes a file and never prints credential values or paths inside the home folder.

export const supportedNode = '^22.12.0 || ^24.0.0 || >=26.0.0'
export function nodeSupported(version) {
  const [major, minor] = version.split('.').map(Number)
  return (major === 22 && minor >= 12) || major === 24 || major >= 26
}
// Like `command -v`, but only absolute PATH directories: relative entries resolve against the working directory.
export function findExecutable(name, pathList, isExecutable) {
  if (name.includes('/')) return isAbsolute(name) && isExecutable(name) ? name : undefined
  for (const dir of pathList.split(delimiter)) if (isAbsolute(dir) && isExecutable(join(dir, name))) return join(dir, name)
}
// File facts without following a final symlink; reads at most the first four bytes of a regular file.
export function fileInfo(path) {
  let stat
  try { stat = lstatSync(path) } catch { return { kind: 'missing' } }
  if (stat.isSymbolicLink()) return { kind: 'symlink' }
  if (stat.isDirectory()) return { kind: 'directory' }
  if (!stat.isFile()) return { kind: 'other' }
  const head = Buffer.alloc(4); let length = 0
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try { length = readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
  } catch { /* Unreadable files report no head bytes. */ }
  return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, head: head.subarray(0, length) }
}
// The production bootstrap imports hermes_bootstrap first; locating it (not running it) identifies the Hermes Python.
const pythonProbe = "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('hermes_bootstrap') else 1)"
export function probePython(python, execute = execFile) {
  return new Promise(resolve => { execute(python, ['-c', pythonProbe], { shell: false, timeout: 10_000, windowsHide: true }, error => resolve(!error)) })
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
const origin = value => { try { return new URL(value).origin } catch { return undefined } }
export async function runDoctor(facts) {
  const { env, home, root } = facts
  const checks = []
  const add = (name, status, detail) => { checks.push({ name, status, detail }) }
  const which = name => findExecutable(name, env.PATH ?? '', facts.isExecutable)
  const tilde = path => path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path

  add('Node.js', nodeSupported(facts.nodeVersion) ? 'ok' : 'fail', `${facts.nodeVersion} (supported: ${supportedNode})`)
  const model = facts.fileInfo(join(root, 'public', 'models', 'realhermes-idle.glb'))
  const glb = model.kind === 'file' && model.head.toString('latin1') === 'glTF'
  add('2x4 model', glb ? 'ok' : 'fail', glb ? `public/models/realhermes-idle.glb (${(model.size / 1e6).toFixed(1)} MB glTF binary)` : 'public/models/realhermes-idle.glb is missing or not glTF binary; restore it from the repository')
  const build = facts.fileInfo(join(root, 'dist', 'index.html'))
  add('Production build', build.kind === 'file' ? 'ok' : 'warn', build.kind === 'file' ? 'dist/ is built' : 'dist/ is not built; npm run prod builds it (development does not need it)')

  // The relay's own mapping; the two settings that can fail startup are checked separately below.
  const { REALHERMES_LOCAL_ARTIFACT_ROOTS: _roots, ...relayEnv } = env
  const relay = relayOptionsFromEnv(relayEnv, { home, findPoppler: () => undefined })
  const chat = origin(relay.chatBaseUrl ?? 'http://127.0.0.1:8642')
  if (!chat) add('Chat gateway', 'fail', 'HERMES_CHAT_BASE_URL is not a valid URL')
  else add('Chat gateway', relay.apiKey ? 'ok' : 'warn', relay.apiKey ? `key set; gateway ${chat}` : `no HERMES_API_KEY or API_SERVER_KEY, so chat returns 503 (gateway ${chat})`)
  const audio = origin(relay.audioBaseUrl ?? 'http://127.0.0.1:9119')
  if (!audio) add('Audio backend', 'fail', 'HERMES_AUDIO_BASE_URL is not a valid URL')
  else add('Audio backend', relay.audioSessionToken ? 'ok' : 'warn', relay.audioSessionToken ? `session token set; backend ${audio}` : 'no HERMES_AUDIO_SESSION_TOKEN: npm run prod and npm run dev:full create their own; npm run dev needs it')


  try {
    const tools = findPoppler(env, facts.isExecutable)
    add('PDF rendering (Poppler)', tools ? 'ok' : 'warn', tools ? `pdfinfo and pdftoppm in ${tilde(dirname(tools.pdfinfo))}` : 'pdfinfo and pdftoppm not found together on PATH; PDF artifacts stay unavailable until Poppler is installed or REALHERMES_POPPLER_DIR is set')
  } catch { add('PDF rendering (Poppler)', 'fail', 'REALHERMES_POPPLER_DIR must be an absolute folder containing executable pdfinfo and pdftoppm') }
  try {
    const roots = parseLocalArtifactRoots(env.REALHERMES_LOCAL_ARTIFACT_ROOTS, home)
    const missing = (roots ?? []).filter(path => !['directory', 'symlink'].includes(facts.fileInfo(path).kind)).length
    if (!roots) add('Approved local folders', 'ok', 'off (REALHERMES_LOCAL_ARTIFACT_ROOTS is unset)')
    else add('Approved local folders', missing ? 'warn' : 'ok', missing ? `${missing} of ${plural(roots.length, 'approved folder')} missing` : plural(roots.length, 'approved folder'))
  } catch { add('Approved local folders', 'fail', 'REALHERMES_LOCAL_ARTIFACT_ROOTS is invalid: list at most 8 specific absolute folders, never /, your home folder, a parent of it or a hidden folder') }

  const pythonLabel = env.HERMES_PYTHON ? 'HERMES_PYTHON' : 'python3'
  const python = which(env.HERMES_PYTHON || 'python3')
  if (!python) add('Hermes Python', 'warn', `${pythonLabel} not found; npm run prod needs the Python interpreter of your Hermes installation`)
  else if (await facts.probePython(python)) add('Hermes Python', 'ok', `${pythonLabel} can import hermes_bootstrap`)
  else add('Hermes Python', 'warn', `${pythonLabel} cannot import hermes_bootstrap; set HERMES_PYTHON to the Python inside your Hermes installation (needed by npm run prod)`)
  add('Hermes CLI', which('hermes') ? 'ok' : 'warn', which('hermes') ? 'hermes on PATH (used by npm run dev:full)' : 'hermes not on PATH; only npm run dev:full needs it')
  add('ffmpeg', which('ffmpeg') ? 'ok' : 'warn', which('ffmpeg') ? 'ffmpeg on PATH' : 'ffmpeg not on PATH; Hermes voice uses it for audio conversion on the machine running Hermes')

  let config
  try {
    config = productionConfig(env)
    add('Production settings', 'ok', `app 127.0.0.1:${config.port}, owned audio 127.0.0.1:${config.audioPort}, tunnel ${config.tunnel ? `on (headset port ${config.remotePort})` : 'off'}`)
  } catch (error) { add('Production settings', 'fail', error.message) }
  if (env.REALHERMES_TUNNEL !== '1') add('SSH tunnel', 'ok', 'not needed (REALHERMES_TUNNEL is off)')
  else add('SSH tunnel', which('ssh') ? 'ok' : 'fail', which('ssh') ? 'ssh on PATH (host keys and key authentication are not checked)' : 'REALHERMES_TUNNEL=1 but ssh is not on PATH')

  const ports = new Map([[config?.port ?? 5173, 'production app / Vite dev'], [config?.audioPort ?? 9119, 'Hermes audio'], [Number(env.PORT ?? 3001), 'development relay']])
  const busy = []
  for (const [port, label] of ports) if (Number.isInteger(port) && port > 0 && port < 65536 && !await facts.portFree(port)) busy.push(`${port} (${label})`)
  add('Ports', busy.length ? 'warn' : 'ok', busy.length ? `in use on 127.0.0.1: ${busy.join(', ')}. Stop that process yourself or choose other ports; nothing was stopped.` : `free on 127.0.0.1: ${[...ports.keys()].join(', ')}`)
  const dotenv = facts.fileInfo(join(root, '.env'))
  if (dotenv.kind === 'missing') add('.env file', 'ok', 'not present; settings come from the shell environment (npm run setup:env creates one)')
  else if (dotenv.kind !== 'file') add('.env file', 'warn', '.env is not a regular file')
  else add('.env file', dotenv.mode & 0o077 ? 'warn' : 'ok', dotenv.mode & 0o077 ? 'readable by other local users; run chmod 600 .env' : 'present with owner-only permissions')

  return { checks, failures: checks.filter(check => check.status === 'fail').length, warnings: checks.filter(check => check.status === 'warn').length }
}
export function formatReport({ checks, failures, warnings }) {
  const width = Math.max(...checks.map(check => check.name.length))
  return ['RealHermes doctor: read-only checks. Nothing was started or stopped, and no secret values are shown.',
    ...checks.map(({ name, status, detail }) => `${status.padEnd(4)}  ${name.padEnd(width)}  ${detail}`),
    `${plural(failures, 'failure')}, ${plural(warnings, 'warning')}.`].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The same .env the relay reads; its values are used for the checks, never printed.
  const { config } = await import('dotenv')
  config({ quiet: true })
  const result = await runDoctor({
    env: process.env, nodeVersion: process.versions.node, home: homedir(), root: fileURLToPath(new URL('..', import.meta.url)), now: Date.now,
    fileInfo, isExecutable: isExecutableFile, probePython, portFree: port => ensurePortFree(port).then(() => true, () => false),
  })
  console.log(formatReport(result))
  if (result.failures) process.exitCode = 1
}
