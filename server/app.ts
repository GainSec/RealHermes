// The 2x4 identity, then the standing capability to look at the wearer's current view. Hermes decides when a turn
// needs it (the profile's steam_frame_capture tool, then vision_analyze); nothing here classifies the user's words.
const realHermesInstructions = 'You are 2x4 (pronounced "two by four"), the RealHermes spatial companion. When asked your name, identify yourself as 2x4—not Hermes or RealHermes. Keep the existing Hermes Agent capabilities and behavior; this instruction changes only the name used on this surface. The user is wearing a Steam Frame headset. Whenever an answer depends on what they can currently see, call steam_frame_capture for a fresh still of their view and inspect it with vision_analyze; that still is the Steam Frame panel view and includes the real-world passthrough scene when active. Never put the capture\'s file path in a reply. To show the user an online PDF or image, find it with your research tools and put its direct public HTTPS file URL in your reply: a URL that returns the file itself (for GitHub, raw.githubusercontent.com, not a /blob/ page). Search results can list stale or mangled links, so check that the URL downloads the file before you reply, and prefer the publisher\'s current official copy over mirrors or archives. RealHermes loads that URL and shows it in the headset, so do not open a browser or desktop app.'
import express from 'express'
import { createArtifactService } from './artifacts.ts'
import type { ArtifactOptions, ArtifactService } from './artifacts.ts'
import { artifactRoutes } from './artifact-routes.ts'
import { localArtifactAnswer, parseLocalArtifactRequest } from './local-artifacts.ts'
import type { LocalArtifactRequest, LocalArtifactResult } from './local-artifacts.ts'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { readSSE, maxAnswerCharacters } from '../src/sse.ts'
import { extractArtifactUrls } from '../src/artifact.ts'
import type { LocalArtifact } from '../src/artifact.ts'
import type { ErrorRequestHandler } from 'express'
export type RelayOptions = { artifactService?: ArtifactService; artifactOptions?: ArtifactOptions; streamTimeoutMs?: number; artifactTimeoutMs?: number; log?: (line: string) => void; apiKey?: string; chatBaseUrl?: string; audioBaseUrl?: string; audioSessionToken?: string; fetch?: typeof fetch }
const maxAudioBytes = 10 * 1024 * 1024
// An answer that offers a supported file link is not complete until the relay has loaded that file and rendered its first
// page. A dead link gets a bounded retry: Hermes is told why it failed and asked for a different, checked source.
const artifactFailure = 'I errored out while loading the artifact. Check the logs.'
const maxArtifactCandidates = 3
const maxArtifactRecoveries = 2
const failureReason = (error: unknown) => {
  const reason = (error as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' && /^[a-z0-9_]{1,40}$/.test(reason) ? reason : 'unavailable'
}
const reasonPhrases: Record<string, string> = {
  unsupported_type: 'it is not a PDF, PNG, JPEG or WebP file (for example an HTML page)', not_file: 'its content is not a valid PDF or image',
  too_large: 'the file is larger than the download limit', timeout: 'the download timed out', dns: 'its host name does not resolve',
  network: 'the connection failed', redirect: 'it redirects somewhere RealHermes will not follow', invalid_url: 'it is not a public HTTPS file address',
  blocked_address: 'it is not a public HTTPS file address', page_count: 'the PDF has no pages or more than 500', pdf_unreadable: 'the PDF could not be read',
  image_bounds: 'the image dimensions are out of bounds', pdf_unsupported: 'PDF display is not available on this RealHermes install (Poppler is missing)',
}
const reasonPhrase = (reason: string) => /^http_(\d{3})$/.test(reason) ? `the server answered HTTP ${reason.slice(5)}` : reasonPhrases[reason] ?? 'it could not be loaded'
const recoveryPrompt = (failures: Array<{ url: string; reason: string }>) => [
  '[RealHermes artifact check] Nothing is displayed yet: RealHermes could not load the file you linked.',
  ...failures.map(({ url, reason }) => `- ${url}: ${reasonPhrase(reason)}`),
  "Find a different direct public HTTPS URL that returns the requested PDF or image itself, preferring the publisher's current official copy (for example the corrected path or the folder listing on the same site) over mirrors and archives. Check that it downloads before you reply, and reply with that URL. Do not repeat a URL listed above.",
].join('\n')
// Hermes vision tool results can contain an inline captured frame. Bound them,
// but do not reject a normal panel JPEG before its text answer arrives.
const maxUpstreamEventBytes = 12 * 1024 * 1024
function validateAudio(data: unknown) {
  if (!data || typeof data !== 'object') throw new Error('Invalid audio')
  const { data_url, mime_type } = data as Record<string, unknown>
  if (typeof data_url !== 'string' || typeof mime_type !== 'string') throw new Error('Invalid audio')
  const match = /^data:([^,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data_url)
  const mime = mime_type.split(';')[0].toLowerCase()
  if (!match || match[1] !== mime_type || !(/^(audio\/[a-z0-9.+-]+|video\/webm)$/.test(mime)) || !match[2] || match[2].length % 4 !== 0) throw new Error('Invalid audio')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.toString('base64') !== match[2] || !bytes.length) throw new Error('Invalid audio')
  if (bytes.length > maxAudioBytes) throw Object.assign(new Error('Audio too large'), { status: 413 })
  return { data_url, mime_type }
}
export function createApp(options: RelayOptions = {}) {
  const app = express(); app.disable('x-powered-by')
  const upstream = options.fetch ?? fetch
  const chatBase = (options.chatBaseUrl ?? 'http://127.0.0.1:8642').replace(/\/+$/, '')
  const audioBase = (options.audioBaseUrl ?? 'http://127.0.0.1:9119').replace(/\/+$/, '')
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok', chatConfigured: Boolean(options.apiKey), audioConfigured: Boolean(options.audioSessionToken) }) })
  app.use('/api/hermes', (_req, res, next) => { if (!options.apiKey) { res.status(503).json({ error: 'Hermes chat is not configured' }); return } next() })
  app.use('/api/audio', (_req, res, next) => { if (!options.audioSessionToken) { res.status(503).json({ error: 'Hermes audio is not configured' }); return } next() })
  const artifacts = options.artifactService ?? createArtifactService(options.artifactOptions)
  app.use('/api/artifacts', artifactRoutes(artifacts))
  app.use(express.json({ limit: '15mb' }))
  // One turn may include research and downloads (finding a paper takes ~40 s); bound it generously but firmly.
  const streamTimeout = options.streamTimeoutMs ?? 120_000
  // Checking an answer's file links, including any retries Hermes is asked for, has its own bound.
  const artifactTimeout = options.artifactTimeoutMs ?? 150_000
  const log = options.log ?? ((line: string) => console.warn(line))
  // Sanitized diagnostics: host and path of a public link Hermes offered, never its query, headers or body.
  function logArtifact(event: string, url: string | undefined, fields: Record<string, string | number>) {
    let where = {}
    if (url) try { const { host, pathname } = new URL(url); where = { host, path: pathname.slice(0, 300) } } catch { /* Log the event alone. */ }
    try { log(JSON.stringify({ time: new Date().toISOString(), event, ...where, ...fields })) } catch { /* Logging never breaks a turn. */ }
  }
  // A busy cache (the headset fetching a page) is not a dead link: wait for it within the artifact budget.
  async function whenFree<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      try { return await work() } catch (error) {
        if (failureReason(error) !== 'busy' || signal.aborted) throw error
        await sleep(250, undefined, { signal })
      }
    }
  }
  async function verify(url: string, signal: AbortSignal): Promise<LocalArtifact> {
    const { id, kind, title, pageCount } = await whenFree(() => artifacts.acquire(url), signal)
    await whenFree(() => artifacts.page(id, 1), signal)
    return { id, kind, title, pageCount }
  }
  async function forward(service: 'chat' | 'audio', path: string, body: unknown) {
    const base = service === 'chat' ? chatBase : audioBase
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (service === 'chat') headers.Authorization = `Bearer ${options.apiKey}`
    else headers['X-Hermes-Session-Token'] = options.audioSessionToken!
    const response = await upstream(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error('Upstream failed')
    return response.json()
  }
  const validText = (text: unknown): text is string => typeof text === 'string' && Boolean(text.trim()) && text.length <= 8000
  // Every turn is the user's words on the shared conversation; a legacy include_vision flag is ignored.
  function chatInput(req: express.Request, res: express.Response): { input: string; local?: LocalArtifactRequest } | undefined {
    const text = req.body?.text
    if (!validText(text)) { res.status(400).json({ error: 'Text is required (maximum 8000 characters)' }); return }
    // "Show me <a file> from my computer" is answered here from approved folders, never by a Hermes search.
    const local = parseLocalArtifactRequest(text)
    return local ? { input: text, local } : { input: text }
  }
  function upstreamBody({ input }: { input: string }, stream: boolean) {
    return { input, conversation: 'realhermes-steam-frame-v3', instructions: realHermesInstructions, stream }
  }
  // Only the chosen file's opaque metadata leaves the server; failures become a sanitized retry answer.
  async function localReply(request: LocalArtifactRequest) {
    const result: LocalArtifactResult | undefined = artifacts.acquireLocal ? await artifacts.acquireLocal(request).catch(() => undefined) : { status: 'unconfigured' }
    const found = result?.status === 'found' ? result.metadata : undefined
    return { text: localArtifactAnswer(request, result), artifact: found && { id: found.id, kind: found.kind, title: found.title, pageCount: found.pageCount } }
  }
  app.post('/api/hermes/chat', async (req, res) => {
    const prepared = chatInput(req, res)
    if (!prepared) return
    if (prepared.local) { res.json(await localReply(prepared.local)); return }
    const data = await forward('chat', '/v1/responses', upstreamBody(prepared, false))
    if (!Array.isArray(data?.output)) throw new Error('Invalid response')
    const parts: string[] = []
    for (const item of data.output) {
      if (!item || typeof item !== 'object') throw new Error('Invalid output item')
      if (item.type !== 'message') continue
      if (item.role && item.role !== 'assistant') continue
      if (!Array.isArray(item.content)) throw new Error('Invalid message')
      for (const block of item.content) {
        if (!block || typeof block !== 'object') throw new Error('Invalid content')
        if (block.type === 'output_text') {
          if (typeof block.text !== 'string') throw new Error('Invalid text')
          parts.push(block.text)
        }
      }
    }
    const reply = parts.join('')
    if (!reply.trim()) throw new Error('Empty output')
    res.json({ text: reply })
  })
  app.post('/api/hermes/chat/stream', async (req, res) => {
    const controller = new AbortController()
    const disconnect = () => controller.abort()
    res.on('close', disconnect)
    let timer: ReturnType<typeof setTimeout> | undefined; let handoff = false
    async function emit(event: string, data: unknown) {
      controller.signal.throwIfAborted()
      if (!res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
        await once(res, 'drain', { signal: controller.signal })
      }
    }
    // One Hermes answer on the shared conversation: tool starts become WORKING and text streams as it arrives.
    async function ask(input: string, signal: AbortSignal) {
      const response = await upstream(`${chatBase}/v1/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(upstreamBody({ input }, true)), signal,
      })
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Invalid upstream stream')
      let answer = ''
      for await (const frame of readSSE(response.body, signal, maxUpstreamEventBytes)) {
        const data = JSON.parse(frame.data)
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid event')
        const type = frame.event || data.type
        if (type === 'error' || type === 'response.failed' || type === 'response.error' || type === 'response.incomplete') throw new Error('Upstream failed')
        if (type === 'response.output_item.added' && data.item?.type === 'function_call' && typeof data.item.name === 'string' && data.item.name.trim()) await emit('working', {})
        if (type === 'response.output_text.delta') {
          if (typeof data.delta !== 'string' || answer.length + data.delta.length > maxAnswerCharacters) throw new Error('Invalid text')
          answer += data.delta
          await emit('text', { delta: data.delta })
        }
        if (type === 'response.completed') {
          if (!answer.trim()) throw new Error('Empty answer')
          return answer
        }
      }
      throw new Error('Incomplete stream')
    }
    // Load the first offered file that really is one; otherwise ask Hermes for another source, a bounded number of times.
    // The browser keeps only the text after the last reset, so the final answer always matches what was (or was not) shown.
    async function handOff(first: string): Promise<{ answer: string; artifact?: LocalArtifact }> {
      const budget = AbortSignal.any([controller.signal, AbortSignal.timeout(artifactTimeout)])
      let answer = first
      for (let round = 0; ; round++) {
        const failures: Array<{ url: string; reason: string }> = []
        for (const url of extractArtifactUrls(answer).slice(0, maxArtifactCandidates)) {
          await emit('working', {})
          try {
            const artifact = await verify(url, budget)
            logArtifact('artifact_verified', url, { kind: artifact.kind, pages: artifact.pageCount, round })
            return { answer, artifact }
          } catch (error) {
            budget.throwIfAborted()
            const reason = failureReason(error); failures.push({ url, reason })
            logArtifact('artifact_candidate_failed', url, { reason, round })
          }
        }
        if (!failures.length || round === maxArtifactRecoveries) break
        await emit('reset', {}); await emit('working', {})
        answer = await ask(recoveryPrompt(failures), budget)
      }
      logArtifact('artifact_handoff_failed', undefined, { reason: 'no_loadable_candidate' })
      await emit('reset', {}); await emit('text', { delta: artifactFailure })
      return { answer: artifactFailure }
    }
    try {
      const prepared = chatInput(req, res)
      if (!prepared) return
      timer = setTimeout(disconnect, streamTimeout)
      controller.signal.throwIfAborted()
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
      res.flushHeaders()
      if (prepared.local) {
        const reply = await localReply(prepared.local)
        await emit('text', { delta: reply.text })
        if (reply.artifact) await emit('artifact', reply.artifact)
        await emit('answer', { text: reply.text }); await emit('done', {})
        res.end(); return
      }
      let answer = await ask(prepared.input, controller.signal)
      let artifact: LocalArtifact | undefined
      clearTimeout(timer)
      if (extractArtifactUrls(answer).length) {
        handoff = true
        ;({ answer, artifact } = await handOff(answer))
      }
      if (artifact) await emit('artifact', artifact)
      await emit('answer', { text: answer }); await emit('done', {})
      res.end()
    } catch {
      if (!res.destroyed && !res.writableEnded) {
        // Out of time (or failed) while checking a file link: never let the earlier claim stand as the answer.
        if (handoff && !controller.signal.aborted) {
          logArtifact('artifact_handoff_failed', undefined, { reason: 'interrupted' })
          res.write(`event: reset\ndata: {}\n\nevent: text\ndata: ${JSON.stringify({ delta: artifactFailure })}\n\nevent: answer\ndata: ${JSON.stringify({ text: artifactFailure })}\n\nevent: done\ndata: {}\n\n`)
          res.end()
        } else if (res.headersSent) { res.write('event: error\ndata: {"error":"Hermes request failed"}\n\n'); res.end() }
        else res.status(502).json({ error: 'Hermes request failed' })
      }
    } finally {
      clearTimeout(timer); res.off('close', disconnect); controller.abort()
    }
  })
  app.post('/api/audio/transcribe', async (req, res) => {
    let audio
    try { audio = validateAudio(req.body) } catch (error) {
      if ((error as { status?: number }).status === 413) throw error
      res.status(400).json({ error: 'Valid audio data URL and MIME type are required' }); return
    }
    const data = await forward('audio', '/api/audio/transcribe', audio)
    if (typeof data?.transcript !== 'string') throw new Error('Invalid transcript')
    res.json({ text: data.transcript })
  })
  app.post('/api/audio/speak', async (req, res) => {
    const text = req.body?.text
    if (!validText(text)) { res.status(400).json({ error: 'Text is required (maximum 8000 characters)' }); return }
    const data = await forward('audio', '/api/audio/speak', { text })
    try { const audio = validateAudio(data); if (!audio.mime_type.startsWith('audio/')) throw new Error('Invalid MIME'); res.json(audio) } catch { throw new Error('Invalid speech') }
  })
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 502
    res.status(status).json({ error: status === 413 ? 'Request is too large' : status === 400 ? 'Invalid request' : 'Hermes request failed' })
  }
  app.use(errors); return app
}
