import express from 'express'
import { appendFileSync, chmodSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve, extname } from 'node:path'
import { EventEmitter } from 'node:events'
import { createApp, type RelayOptions } from './app.ts'
import { createArtifactService } from './artifacts.ts'

// Troika's existing Unicode font resolver fetches fonts from this fixed CDN.
const policy = "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: https://cdn.jsdelivr.net; img-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
export function createProductionApp(options: RelayOptions & { distPath: string }) {
  const dist = resolve(options.distPath)
  if (!statSync(resolve(dist, 'index.html')).isFile()) throw new Error('Production build unavailable')
  const service = options.artifactService ?? createArtifactService(options.artifactOptions)
  let stopping = false
  let disposal: Promise<void> | undefined
  const dispose = () => { stopping = true; return disposal ??= service.dispose() }
  const app = express(); app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'microphone=(self), xr-spatial-tracking=(self), camera=(), geolocation=()',
    }); next()
  })
  app.get('/api/ready', (_req, res) => {
    res.set('Cache-Control', 'no-store').status(stopping ? 503 : 200).json({
      appRunning: !stopping, chatConfigured: Boolean(options.apiKey), audioConfigured: Boolean(options.audioSessionToken), upstreamConnectivity: 'not-probed',
    })
  })
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  app.use(createApp({ ...options, artifactService: service }))
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found' }) })
  app.use(express.static(dist, {
    dotfiles: 'deny', index: false, redirect: false,
    setHeaders(res, path) { res.setHeader('Cache-Control', path.startsWith(resolve(dist, 'assets') + '/') ? 'public, max-age=31536000, immutable' : 'no-cache') },
  }))
  app.get('/{*path}', (req, res) => {
    if (extname(req.path) || req.path.split('/').some(part => part.startsWith('.')) || /^\/(assets|models)(\/|$)/.test(req.path)) {
      res.status(404).json({ error: 'Resource not found' }); return
    }
    res.set('Cache-Control', 'no-cache').sendFile(resolve(dist, 'index.html'))
  })
  app.use((_req, res) => { res.status(404).json({ error: 'Resource not found' }) })
  return { app, dispose }
}

type ManagedServer = EventEmitter & { close: () => unknown; closeAllConnections: () => unknown }
export function attachProductionLifecycle(server: ManagedServer, dispose: () => Promise<void>, runtime: EventEmitter = process) {
  let stopping = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function removeListeners() {
    clearTimeout(timer)
    runtime.off('SIGINT', stop); runtime.off('SIGTERM', stop)
  }
  function stop() {
    if (stopping) return
    stopping = true
    void dispose().catch(() => { process.exitCode = 1 })
    timer = setTimeout(() => server.closeAllConnections(), 3000)
    server.close()
  }
  server.once('close', () => { stopping = true; removeListeners(); void dispose().catch(() => { process.exitCode = 1 }) })
  runtime.on('SIGINT', stop); runtime.on('SIGTERM', stop)
  return stop
}

// The launcher discards raw child output (it can hold secrets), so the relay's own sanitized diagnostics go to a
// private JSON-lines file instead. Logging never throws into a turn.
export function createFileLog(file: string) {
  return (line: string) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, `${line}\n`, { mode: 0o600 }); chmodSync(file, 0o600)
    } catch { /* A broken log location must not fail the request. */ }
  }
}
