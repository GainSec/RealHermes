import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { connect as http2Connect } from 'node:http2'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { Readable } from 'node:stream'
import { execFile } from 'node:child_process'
import { findLocalArtifacts, localScanDefaults, readLocalArtifact } from './local-artifacts.ts'
import type { LocalArtifactRequest, LocalArtifactResult, LocalScanLimits } from './local-artifacts.ts'
import type { PopplerTools } from './poppler.ts'

// Local artifacts have no source URL; neither kind ever carries a local path.
export type ArtifactMetadata = { id: string; kind: 'pdf' | 'image'; title: string; pageCount: number; sourceUrl?: string }
export type ArtifactPage = { bytes: Buffer; mime: 'image/png' | 'image/jpeg' | 'image/webp' }
export type ArtifactService = { acquire: (url: string) => Promise<ArtifactMetadata>; acquireLocal?: (request: LocalArtifactRequest) => Promise<LocalArtifactResult>; page: (id: string, page: number) => Promise<ArtifactPage>; cleanup: () => Promise<void>; dispose: () => Promise<void> }
type Address = { address: string; family: number }
type PinnedFetchOptions = { addresses: Address[]; signal: AbortSignal }
type RunOptions = { timeout: number; maxBuffer: number; signal: AbortSignal }
export type ArtifactOptions = {
  resolve?: (host: string) => Promise<Address[]>
  fetch?: (url: string, options: PinnedFetchOptions) => Promise<Response>
  execFile?: typeof execFile
  run?: (executable: string, args: string[], options: RunOptions) => Promise<string>
  fs?: typeof filesystem
  tmpdir?: string
  now?: () => number
  safePorts?: number[]
  timeoutMs?: number
  maxDownloadBytes?: number
  maxRasterBytes?: number
  maxRedirects?: number
  maxEntries?: number
  maxCacheBytes?: number
  ttlMs?: number
  // Approved folders for local discovery (unset disables it) and tighter scan bounds.
  localRoots?: string[]
  localScan?: Partial<LocalScanLimits>
  // Poppler executables found at startup (see poppler.ts); unset leaves PDFs unavailable while images still work.
  poppler?: PopplerTools
}
// Callers only ever see "Artifact unavailable"; the short reason code is for sanitized server logs and for telling
// Hermes why a link failed (never a path, header, body, or query string).
export class ArtifactUnavailable extends Error {
  readonly reason: string
  constructor(reason = 'unavailable') { super('Artifact unavailable'); this.reason = reason }
}
const unavailable = (reason?: string) => new ArtifactUnavailable(reason)
const blocked = new BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(ip, prefix, 'ipv4')
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(ip, prefix, 'ipv6')
export function isPublicAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  // Fail closed for mapped IPv4, transition mechanisms, scoped and non-global IPv6.
  return family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}
export function validateArtifactUrl(value: string, safePorts: number[] = []): URL {
  // oxlint-disable-next-line no-control-regex -- Reject URL control characters before URL normalization.
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw unavailable('invalid_url')
  let url: URL
  try { url = new URL(value) } catch { throw unavailable('invalid_url') }
  if (!/^https:\/\//i.test(value) || url.protocol !== 'https:' || url.username || url.password || /^https:\/\/[^/]*@/i.test(value) || (url.port && !safePorts.includes(Number(url.port)))) throw unavailable('invalid_url')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || /(^|\.)(localhost|local|internal|onion)\.?$/i.test(host) || (isIP(host) && !isPublicAddress(host))) throw unavailable('blocked_address')
  url.hash = ''; return url
}

const accepted = 'application/pdf,image/png,image/jpeg,image/webp'
// A fixed, non-identifying product token; some large media hosts refuse requests without one.
const userAgent = 'RealHermes/0.0.0 (artifact viewer)'
// HTTPS connects only to already-validated DNS results, while retaining hostname TLS checks.
// Native fetch would resolve the hostname again, leaving a DNS rebinding gap. ALPN offers h2 like
// browsers do, because some HTTP/2-only origins reset HTTP/1.1 requests.
export function createPinnedFetch(request: typeof httpsRequest = httpsRequest, connect: typeof tlsConnect = tlsConnect) {
  return (url: string, { addresses, signal }: PinnedFetchOptions): Promise<Response> => new Promise((resolve, reject) => {
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) { reject(unavailable()); return }
    const target = new URL(url); const host = target.hostname.replace(/^\[|\]$/g, '')
    const socket = connect({
      host, port: Number(target.port) || 443, servername: isIP(host) ? undefined : host, rejectUnauthorized: true, ALPNProtocols: ['h2', 'http/1.1'],
      // Resolve only to validated addresses; Node may still fall back between them by family.
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, addresses as { address: string; family: 4 | 6 }[])
        else callback(null, addresses[0].address, addresses[0].family as 4 | 6)
      },
    })
    const fail = (error: unknown) => { socket.destroy(); reject(error) }
    const abort = () => fail(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    socket.once('close', () => signal.removeEventListener('abort', abort)).on('error', fail)
    const respond = (status: number, fields: Record<string, string | string[] | number | undefined>, body: Readable) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(fields)) if (!name.startsWith(':') && value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
      if ([204, 205, 304].includes(status)) { body.resume(); resolve(new Response(null, { status, headers })); return }
      resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }))
    }
    socket.once('secureConnect', () => {
      if (socket.alpnProtocol === 'h2') {
        const session = http2Connect(target.origin, { createConnection: () => socket, settings: { enablePush: false, maxHeaderListSize: 16 * 1024 } }).on('error', fail)
        const stream = session.request({ ':authority': target.host, ':path': target.pathname + target.search, accept: accepted, 'accept-encoding': 'identity', 'user-agent': userAgent }, { endStream: true, signal }).on('error', fail)
        stream.once('close', () => session.close()).once('response', fields => respond(Number(fields[':status']), fields, stream))
        return
      }
      request(target, { method: 'GET', createConnection: () => socket, defaultPort: 443, signal, maxHeaderSize: 16 * 1024, headers: { Accept: accepted, 'Accept-Encoding': 'identity', 'User-Agent': userAgent } },
        response => respond(response.statusCode ?? 502, response.headers, response)).on('error', fail).end()
    })
  })
}
const pinnedFetch = createPinnedFetch()
function runPoppler(executable: string, args: string[], options: RunOptions, execute: typeof execFile = execFile): Promise<string> {
  return new Promise((resolve, reject) => {
    execute(executable, args, { ...options, shell: false, encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
}
function matchesMagic(bytes: Buffer, mime: string) {
  if (mime === 'application/pdf') return bytes.subarray(0, 5).toString() === '%PDF-'
  if (mime === 'image/png') return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/webp') return bytes.length >= 20 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString())
  return false
}
function boundedImage(bytes: Buffer, mime: string) {
  let width = 0; let height = 0
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(12, 16).toString() === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
  } else if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break
      }
      offset += length
    }
  } else if (mime === 'image/webp') {
    const chunk = bytes.subarray(12, 16).toString()
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3)
    } else if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const dimensions = bytes.readUInt32LE(21)
      width = 1 + (dimensions & 0x3fff); height = 1 + ((dimensions >>> 14) & 0x3fff)
    } else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).toString('hex') === '9d012a') {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000
}
async function download(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (!response.ok || !response.body || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))) {
    void response.body?.cancel().catch(() => {}); throw unavailable(!response.ok ? `http_${response.status}` : !response.body ? 'empty' : 'too_large')
  }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw unavailable('too_large')
      chunks.push(Buffer.from(value))
    }
    signal.throwIfAborted()
    return Buffer.concat(chunks, size)
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}) }
}
// oxlint-disable-next-line no-control-regex -- Strip inert title controls from display metadata.
const cleanTitle = (title: string) => title.replace(/[\x00-\x1f\x7f-\x9f/\\]/g, ' ').slice(0, 160) || 'Artifact'
function titleOf(url: URL) {
  let title = url.pathname.split('/').at(-1) || 'Artifact'
  try { title = decodeURIComponent(title) } catch { /* Keep undecodable title inert. */ }
  return cleanTitle(title)
}
type Entry = { metadata: ArtifactMetadata; created: number; used: number; bytes: number; mime: string; pages: Map<number, number> }
export function createArtifactService(options: ArtifactOptions = {}): ArtifactService {
  const fs = options.fs ?? filesystem
  const now = options.now ?? Date.now
  const resolve = options.resolve ?? (host => lookup(host, { all: true, verbatim: true }))
  const fetch = options.fetch ?? pinnedFetch
  const run = options.run ?? ((executable, args, config) => runPoppler(executable, args, config, options.execFile))
  const poppler = options.poppler
  // Configurable limits may tighten defaults; they cannot remove the safety bounds.
  const limit = (value: number | undefined, maximum: number) => Math.max(1, Math.min(maximum, value ?? maximum))
  const maxDownload = limit(options.maxDownloadBytes, 25 * 1024 * 1024)
  const maxRaster = limit(options.maxRasterBytes, 12 * 1024 * 1024)
  const maxCache = limit(options.maxCacheBytes, 100 * 1024 * 1024)
  const maxEntries = limit(options.maxEntries, 8)
  const timeout = limit(options.timeoutMs, 30_000)
  const ttl = limit(options.ttlMs, 10 * 60_000)
  const maxRedirects = Math.min(4, Math.max(0, options.maxRedirects ?? 4))
  const entries = new Map<string, Entry>()
  let root: string | undefined; let busy = false; let disposed = false
  let activeController: AbortController | undefined
  async function directory() {
    root ??= await fs.mkdtemp(join(options.tmpdir ?? tmpdir(), 'realhermes-artifacts-'))
    return root
  }
  const totalBytes = () => [...entries.values()].reduce((total, entry) => total + entry.bytes, 0)
  async function remove(id: string) {
    if (root) await fs.rm(join(root, id), { recursive: true, force: true })
    entries.delete(id)
  }
  async function clean() {
    for (const [id, entry] of entries) if (now() - entry.created >= ttl) await remove(id)
  }
  async function makeRoom(bytes: number, preserve?: string) {
    if (bytes > maxCache) throw unavailable('too_large')
    while (totalBytes() + bytes > maxCache || (!preserve && entries.size >= maxEntries)) {
      const oldest = [...entries].filter(([id]) => id !== preserve).sort((a, b) => a[1].used - b[1].used)[0]
      if (!oldest) throw unavailable('cache_full')
      await remove(oldest[0])
    }
  }
  async function exclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (busy || disposed) throw unavailable(disposed ? 'disposed' : 'busy')
    busy = true
    const controller = new AbortController()
    activeController = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable('timeout')) }, timeout)
    })
    // Keep the gate closed until timed-out filesystem/process work has actually settled.
    const operation = Promise.resolve().then(() => work(controller.signal))
    void operation.finally(async () => {
      busy = false; activeController = undefined
      if (disposed && root) await fs.rm(root, { recursive: true, force: true })
    }).catch(() => {})
    try { return await Promise.race([operation, expired]) } catch (error) { throw error instanceof ArtifactUnavailable ? error : unavailable() }
    finally { clearTimeout(timer); controller.abort() }
  }
  async function acquire(value: string) {
    return exclusive(async signal => {
      await clean()
      let url = validateArtifactUrl(value, options.safePorts)
      let response: Response | undefined
      for (let redirects = 0; redirects <= maxRedirects; redirects++) {
        const host = url.hostname.replace(/^\[|\]$/g, '')
        let addresses: Address[]
        try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host) } catch { throw unavailable('dns') }
        signal.throwIfAborted()
        if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) throw unavailable('blocked_address')
        try { response = await fetch(url.href, { addresses, signal }) } catch (error) { throw signal.aborted ? error : unavailable('network') }
        signal.throwIfAborted()
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        void response.body?.cancel().catch(() => {})
        const location = response.headers.get('location')
        // oxlint-disable-next-line no-control-regex -- Redirect normalization must not hide controls or backslashes.
        if (!location || redirects === maxRedirects || /[\s\\\x00-\x1f\x7f]/.test(location)) throw unavailable('redirect')
        if (/^(?:https:)?\/\/[^/]*@/i.test(location)) throw unavailable('redirect')
        if (/^https:/i.test(location)) validateArtifactUrl(location, options.safePorts)
        url = validateArtifactUrl(new URL(location, url).href, options.safePorts)
        response = undefined
      }
      if (!response) throw unavailable()
      // A missing or failed page is reported as such, before its (usually HTML) content type is judged.
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw unavailable(`http_${response.status}`) }
      const declaredMime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
      const supportedMimes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
      const extensionMime = (() => {
        const pathname = url.pathname.toLowerCase()
        if (pathname.endsWith('.pdf')) return 'application/pdf'
        if (pathname.endsWith('.png')) return 'image/png'
        if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg'
        if (pathname.endsWith('.webp')) return 'image/webp'
        return ''
      })()
      const mime = supportedMimes.includes(declaredMime)
        ? declaredMime
        : declaredMime === 'application/octet-stream' ? extensionMime : ''
      if (!mime || !['identity', null].includes(response.headers.get('content-encoding'))) {
        void response.body?.cancel().catch(() => {}); throw unavailable('unsupported_type')
      }
      return store(await download(response, maxDownload, signal), mime, titleOf(url), url.href, signal)
    })
  }
  // Validate magic/dimensions, then cache under a fresh opaque ID with fixed server-chosen filenames.
  async function store(bytes: Buffer, mime: string, title: string, sourceUrl: string | undefined, signal: AbortSignal) {
    if (!matchesMagic(bytes, mime)) throw unavailable('not_file')
    // Without Poppler a PDF is refused before anything is cached or run.
    if (mime === 'application/pdf' ? !poppler : !boundedImage(bytes, mime)) throw unavailable(mime === 'application/pdf' ? 'pdf_unsupported' : 'image_bounds')
    await makeRoom(bytes.length)
    signal.throwIfAborted()
    const id = randomBytes(16).toString('hex')
    const dir = join(await directory(), id)
    await fs.mkdir(dir, { mode: 0o700 })
    try {
      await fs.writeFile(join(dir, 'source'), bytes, { mode: 0o600, flag: 'wx' })
      let pageCount = 1
      if (mime === 'application/pdf') {
        let info: string
        try { info = await run(poppler!.pdfinfo, [join(dir, 'source')], { timeout: 10_000, maxBuffer: 64 * 1024, signal }) } catch (error) { throw signal.aborted ? error : unavailable('pdf_unreadable') }
        pageCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1])
        if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 500) throw unavailable('page_count')
      }
      signal.throwIfAborted()
      const metadata: ArtifactMetadata = { id, kind: mime === 'application/pdf' ? 'pdf' : 'image', title, pageCount, ...(sourceUrl ? { sourceUrl } : {}) }
      entries.set(id, { metadata, mime, created: now(), used: now(), bytes: bytes.length, pages: new Map() })
      return { ...metadata }
    } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error }
  }
  const localLimits: LocalScanLimits = {
    maxDepth: limit(options.localScan?.maxDepth, localScanDefaults.maxDepth), maxDirectories: limit(options.localScan?.maxDirectories, localScanDefaults.maxDirectories),
    maxEntries: limit(options.localScan?.maxEntries, localScanDefaults.maxEntries), timeBudgetMs: limit(options.localScan?.timeBudgetMs, localScanDefaults.timeBudgetMs),
  }
  // Server-owned discovery under the approved roots only; the caller learns opaque metadata or a status, never a path.
  async function acquireLocal(request: LocalArtifactRequest): Promise<LocalArtifactResult> {
    const roots = options.localRoots ?? []
    if (!roots.length) return { status: 'unconfigured' }
    return exclusive(async signal => {
      await clean()
      const candidates = await findLocalArtifacts(roots, request, { fs, signal, limits: localLimits, now })
      const chosen = candidates[0]
      if (!chosen) return { status: 'none' }
      const title = cleanTitle(chosen.segments.at(-1)!)
      try {
        return { status: 'found', matches: candidates.length, metadata: await store(await readLocalArtifact(fs, chosen, maxDownload), chosen.mime, title, undefined, signal) as Extract<LocalArtifactResult, { status: 'found' }>['metadata'] }
      } catch (error) {
        if (signal.aborted) throw error
        return { status: 'unavailable', title }
      }
    })
  }
  async function page(id: string, number: number) {
    return exclusive(async signal => {
      await clean()
      const entry = /^[a-f0-9]{32}$/.test(id) ? entries.get(id) : undefined
      if (!entry || !Number.isInteger(number) || number < 1 || number > entry.metadata.pageCount) throw unavailable()
      entry.used = now()
      const dir = join(root!, id)
      if (entry.metadata.kind === 'image') return { bytes: await fs.readFile(join(dir, 'source')), mime: entry.mime as ArtifactPage['mime'] }
      const target = join(dir, `page-${number}`)
      if (!entry.pages.has(number)) {
        try {
          // Only a PDF counted by pdfinfo has an entry, so Poppler is configured here.
          await run(poppler!.pdftoppm, ['-f', String(number), '-l', String(number), '-singlefile', '-scale-to', '1600', '-png', join(dir, 'source'), target], { timeout: 10_000, maxBuffer: 64 * 1024, signal })
          signal.throwIfAborted()
          const stat = await fs.stat(target + '.png')
          if (!stat.isFile() || stat.size > maxRaster || stat.size < 24) throw unavailable()
          await makeRoom(stat.size, id)
          const bytes = await fs.readFile(target + '.png')
          if (!matchesMagic(bytes, 'image/png') || bytes.readUInt32BE(16) > 1600 || bytes.readUInt32BE(20) > 1600) throw unavailable()
          entry.pages.set(number, stat.size); entry.bytes += stat.size
        } catch (error) { await fs.rm(target + '.png', { force: true }); throw error }
      }
      return { bytes: await fs.readFile(target + '.png'), mime: 'image/png' as const }
    })
  }
  const sweep = setInterval(() => { if (!busy && !disposed) void exclusive(async () => clean()).catch(() => {}) }, Math.min(ttl, 60_000))
  sweep.unref()
  return {
    acquire, acquireLocal, page,
    cleanup: () => exclusive(async () => clean()),
    async dispose() {
      disposed = true; clearInterval(sweep); activeController?.abort()
      if (root) await fs.rm(root, { recursive: true, force: true })
      entries.clear()
    },
  }
}
