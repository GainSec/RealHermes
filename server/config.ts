import { homedir } from 'node:os'
import type { RelayOptions } from './app.ts'
import { parseLocalArtifactRoots } from './local-artifacts.ts'
import { findPoppler } from './poppler.ts'
import type { PopplerTools } from './poppler.ts'

// Machine facts behind the defaults; tests pass fixed values.
export type ConfigDiscovery = { home?: string; findPoppler?: (env: NodeJS.ProcessEnv) => PopplerTools | undefined }

// A relay launched from the gateway's environment already takes its key from
// API_SERVER_KEY; dial the address that gateway binds (Hermes defaults
// 127.0.0.1:8642), not a loopback guess it may not be listening on.
function gatewayBaseUrl(env: NodeJS.ProcessEnv) {
  const host = env.API_SERVER_HOST?.trim(); const port = env.API_SERVER_PORT?.trim()
  if (!host && !port) return undefined
  const address = !host || host === '0.0.0.0' ? '127.0.0.1' : host === '::' || host === '[::]' ? '[::1]' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const number = Number(port)
  return `http://${address}:${port && /^\d+$/.test(port) && number >= 1 && number <= 65535 ? number : 8642}`
}

export function relayOptionsFromEnv(env: NodeJS.ProcessEnv, discovery: ConfigDiscovery = {}): RelayOptions {
  const home = discovery.home ?? homedir()
  // Local file display stays off unless approved folders are deliberately listed; an unsafe list fails startup.
  const localRoots = parseLocalArtifactRoots(env.REALHERMES_LOCAL_ARTIFACT_ROOTS, home)
  // PDF pages need Poppler: REALHERMES_POPPLER_DIR, else the first PATH directory holding both tools.
  const poppler = (discovery.findPoppler ?? findPoppler)(env)
  return {
    artifactOptions: localRoots || poppler ? { ...(localRoots && { localRoots }), ...(poppler && { poppler }) } : undefined,
    chatBaseUrl: env.HERMES_CHAT_BASE_URL || gatewayBaseUrl(env),
    apiKey: env.HERMES_API_KEY || env.API_SERVER_KEY,
    audioBaseUrl: env.HERMES_AUDIO_BASE_URL,
    audioSessionToken: env.HERMES_AUDIO_SESSION_TOKEN,
  }
}
