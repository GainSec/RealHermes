import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtifactService, isPublicAddress, validateArtifactUrl } from './artifacts.ts'
import type { ArtifactOptions } from './artifacts.ts'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const pdf = Buffer.from('%PDF-1.7\n test PDF')
// Where startup found Poppler (see poppler.ts); PDF work must run exactly these executables.
const poppler = { pdfinfo: '/opt/poppler/bin/pdfinfo', pdftoppm: '/opt/poppler/bin/pdftoppm' }
const cleaners: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleaners.splice(0)) await clean() })
async function fixture(overrides: Record<string, any> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rh-artifact-test-'))
  cleaners.push(() => fs.rm(root, { recursive: true, force: true }))
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  const fetch = vi.fn(async (_url: string, _options: { addresses: { address: string; family: number }[]; signal: AbortSignal }) => new Response(png, { headers: { 'content-type': 'image/png' } }))
  const run = vi.fn(async () => 'Pages: 3\n')
  const service = createArtifactService({ tmpdir: root, resolve, fetch, run, poppler, ...overrides })
  cleaners.push(() => service.dispose())
  return { service, resolve, fetch, run, root }
}

it.each(['http://example.com/a.pdf', 'file:///a.pdf', 'not a url', 'https://user:pass@example.com/a.pdf', 'https://example.com:444/a.pdf', 'https://example.com\\@127.0.0.1/a.pdf', 'https://example.com/a.pdf\n'])('rejects malformed/unsafe URL %s', async url => {
  expect(() => validateArtifactUrl(url)).toThrow()
})
it('accepts only standard HTTPS, with nonstandard ports requiring an explicit safe allowlist', () => {
  expect(validateArtifactUrl('https://example.com:443/a.pdf').href).toBe('https://example.com/a.pdf')
  expect(validateArtifactUrl('https://example.com:8443/a.pdf', [8443]).port).toBe('8443')
})
it.each(['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.1.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.2', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', '3fff::1'])('rejects non-public address %s', address => {
  expect(isPublicAddress(address)).toBe(false)
})
it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('allows global address %s', address => expect(isPublicAddress(address)).toBe(true))
it.each(['https://127.0.0.1/a.pdf', 'https://2130706433/a.pdf', 'https://0x7f000001/a.pdf', 'https://[::1]/a.pdf', 'https://[::ffff:127.0.0.1]/a.pdf'])('rejects private literal host before fetch %s', async url => {
  const { service, fetch } = await fixture()
  await expect(service.acquire(url)).rejects.toThrow('Artifact unavailable')
  expect(fetch).not.toHaveBeenCalled()
})
it('rejects every DNS result, including mixed public/private and empty answers', async () => {
  for (const addresses of [[], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }]]) {
    const { service, fetch } = await fixture({ resolve: async () => addresses })
    await expect(service.acquire('https://example.com/a.png')).rejects.toThrow('Artifact unavailable')
    expect(fetch).not.toHaveBeenCalled()
  }
})
it('pins the validated DNS addresses and strips fragments; returns only opaque metadata and final URL', async () => {
  const { service, fetch, resolve } = await fixture()
  const value = await service.acquire('https://example.com/picture.png#fragment')
  expect(resolve).toHaveBeenCalledWith('example.com')
  expect(fetch.mock.calls[0][0]).toBe('https://example.com/picture.png')
  expect(fetch.mock.calls[0][1].addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  expect(value).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/), kind: 'image', title: 'picture.png', pageCount: 1, sourceUrl: 'https://example.com/picture.png' })
  expect(await service.page(value.id, 1)).toEqual({ bytes: png, mime: 'image/png' })
  const second = await service.acquire('https://example.com/picture.png'); expect(second.id).not.toBe(value.id)
})
it('revalidates URLs and DNS on every redirect including the same hostname', async () => {
  const resolve = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/final.png' } }))
  const { service } = await fixture({ resolve, fetch })
  await expect(service.acquire('https://example.com/start.png')).rejects.toThrow('Artifact unavailable')
  expect(resolve).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledTimes(1)
})
it.each(['http://example.com/a.png', 'https://user:pw@example.com/a.png', 'https://10.1.1.1/a.png', 'https://[fe80::1]/a.png', 'https://example.com:444/a.png'])('blocks redirect to %s', async location => {
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
  const { service } = await fixture({ fetch })
  await expect(service.acquire('https://example.com/start.png')).rejects.toThrow('Artifact unavailable')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('bounds redirects and records a validated relative final URL', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final.png' } })).mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }))
  const { service } = await fixture({ fetch })
  expect((await service.acquire('https://example.com/start.png')).sourceUrl).toBe('https://example.com/final.png')
  const looping = await fixture({ fetch: async () => new Response(null, { status: 302, headers: { location: '/loop.png' } }), maxRedirects: 2 })
  await expect(looping.service.acquire('https://example.com/a.png')).rejects.toThrow('Artifact unavailable')
})
it.each([
  ['text/html', png], ['image/svg+xml', Buffer.from('<svg/>')], ['image/png', pdf], ['application/pdf', png], ['image/jpeg', png], ['image/webp', png], ['image/png', Buffer.alloc(0)],
])('rejects unsupported MIME/magic mismatch %s', async (mime, bytes) => {
  const { service } = await fixture({ fetch: async () => new Response(bytes, { headers: { 'content-type': mime } }) })
  await expect(service.acquire('https://example.com/file.png')).rejects.toThrow('Artifact unavailable')
})
it('accepts generic binary responses only when an explicit supported extension and magic bytes agree', async () => {
  const genericPdf = await fixture({ fetch: async () => new Response(pdf, { headers: { 'content-type': 'application/octet-stream' } }) })
  const item = await genericPdf.service.acquire('https://raw.example.com/document.pdf')
  expect(item).toMatchObject({ kind: 'pdf', title: 'document.pdf', pageCount: 3 })
  for (const [url, bytes] of [
    ['https://example.com/document.pdf', png],
    ['https://example.com/image.png', pdf],
    ['https://example.com/document.bin', pdf],
  ] as const) {
    const mismatch = await fixture({ fetch: async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }) })
    await expect(mismatch.service.acquire(url)).rejects.toThrow('Artifact unavailable')
  }
})

it.each([
  ['image/jpeg', Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex')],
  ['image/webp', Buffer.from('5249464612000000574542505650384c050000002f0000000000', 'hex')],
])('serves validated image bytes as exact %s', async (mime, bytes) => {
  const { service } = await fixture({ fetch: async () => new Response(bytes, { headers: { 'content-type': mime + '; charset=binary' } }) })
  const item = await service.acquire('https://example.com/image.jpg')
  expect(await service.page(item.id, 1)).toEqual({ bytes, mime })
})
it('bounds both declared and streamed bytes', async () => {
  for (const response of [new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '1000' } }), new Response(png, { headers: { 'content-type': 'image/png' } })]) {
    const { service } = await fixture({ maxDownloadBytes: 16, fetch: async () => response })
    await expect(service.acquire('https://example.com/a.png')).rejects.toThrow('Artifact unavailable')
  }
})
it('bounds fetch, body, and DNS time even if injected operations ignore abort', async () => {
  for (const overrides of [{ fetch: () => new Promise(() => {}) }, { resolve: () => new Promise(() => {}) }, { fetch: async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'image/png' } }) }]) {
    const { service } = await fixture({ timeoutMs: 15, ...overrides })
    await expect(service.acquire('https://example.com/a.png')).rejects.toThrow('Artifact unavailable')
  }
})
it('sanitizes transport/filesystem errors and never uses attacker filenames', async () => {
  const { service, root } = await fixture()
  const item = await service.acquire('https://example.com/..%2F..%2Fsecret.png')
  const dirs = await fs.readdir(root)
  expect(dirs).toHaveLength(1); expect(dirs[0]).toMatch(/^realhermes-artifacts-/)
  expect(await fs.readdir(join(root, dirs[0]))).toEqual([item.id])
  expect(await fs.readdir(join(root, dirs[0], item.id))).toEqual(['source'])
  const broken = await fixture({ fetch: async () => { throw new Error('/private/token SECRET') } })
  await expect(broken.service.acquire('https://example.com/a.png')).rejects.toThrow(/^Artifact unavailable$/)
})
it('bounds PDF pages before exposing an ID', async () => {
  for (const stdout of ['Pages: 0', 'Pages: 501', 'Pages: 999999', 'Pages: nope', 'no page info']) {
    const { service } = await fixture({ fetch: async () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }), run: async () => stdout })
    await expect(service.acquire('https://example.com/a.pdf')).rejects.toThrow('Artifact unavailable')
  }
})
it('accepts a 119-page paper within the bounded PDF limit', async () => {
  const { service } = await fixture({ fetch: async () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }), run: async () => 'Pages: 119\n' })
  await expect(service.acquire('https://example.com/long-paper.pdf')).resolves.toMatchObject({ kind: 'pdf', pageCount: 119 })
})
it('uses the configured pdfinfo and pdftoppm executables with fixed argv and on-demand bounded pages', async () => {
  const run = vi.fn(async (exe: string, args: string[], _options: Parameters<NonNullable<ArtifactOptions['run']>>[2]) => {
    if (exe.endsWith('/pdfinfo')) return 'Pages: 3\n'
    await fs.writeFile(args.at(-1) + '.png', png); return ''
  })
  const { service } = await fixture({ fetch: async () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }), run })
  const item = await service.acquire('https://example.com/evil%20$(touch%20file).pdf')
  expect(item.kind).toBe('pdf'); expect(item.pageCount).toBe(3)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0][0]).toBe('/opt/poppler/bin/pdfinfo')
  const source = run.mock.calls[0][1][0]
  expect(source).toMatch(/\/realhermes-artifacts-[^/]+\/[a-f0-9]{32}\/source$/)
  expect(await service.page(item.id, 2)).toEqual({ bytes: png, mime: 'image/png' })
  expect(run.mock.calls[1][0]).toBe('/opt/poppler/bin/pdftoppm')
  expect(run.mock.calls[1][1]).toEqual(['-f', '2', '-l', '2', '-singlefile', '-scale-to', '1600', '-png', source, source.replace(/source$/, 'page-2')])
  expect(run.mock.calls[1][2]).toMatchObject({ timeout: 10_000, maxBuffer: 64 * 1024 })
  await service.page(item.id, 2); expect(run).toHaveBeenCalledTimes(2)
  for (const page of [0, -1, 4, 1.5, NaN]) await expect(service.page(item.id, page)).rejects.toThrow('Artifact unavailable')
  for (const id of ['../secret', 'unknown', 'a'.repeat(32)]) await expect(service.page(id, 1)).rejects.toThrow('Artifact unavailable')
})
it('leaves PDFs unavailable without Poppler, never starting a process or caching the source, while images still work', async () => {
  const { service, run, root } = await fixture({ poppler: undefined, fetch: async (url: string) => new Response(url.endsWith('.pdf') ? pdf : png, { headers: { 'content-type': url.endsWith('.pdf') ? 'application/pdf' : 'image/png' } }) })
  await expect(service.acquire('https://example.com/a.pdf')).rejects.toThrow(/^Artifact unavailable$/)
  expect(run).not.toHaveBeenCalled()
  const [cache] = await fs.readdir(root)
  expect(cache === undefined ? [] : await fs.readdir(join(root, cache))).toEqual([])
  await expect(service.acquire('https://example.com/a.png')).resolves.toMatchObject({ kind: 'image', pageCount: 1 })
})
it('bounds raster output and sanitizes Poppler failure', async () => {
  const { service } = await fixture({ fetch: async () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }), run: async (exe: string, args: string[]) => {
    if (exe.endsWith('/pdfinfo')) return 'Pages: 1'
    await fs.writeFile(args.at(-1) + '.png', Buffer.alloc(100)); return ''
  }, maxRasterBytes: 32 })
  const item = await service.acquire('https://example.com/a.pdf')
  await expect(service.page(item.id, 1)).rejects.toThrow(/^Artifact unavailable$/)
})
it('cleans TTL and evicts least recently used entries under count/byte bounds', async () => {
  let now = 0
  const { service } = await fixture({ now: () => now, ttlMs: 20, maxEntries: 2, maxCacheBytes: png.length * 2 })
  const first = await service.acquire('https://example.com/1.png'); now = 1
  const second = await service.acquire('https://example.com/2.png'); now = 2
  await service.page(first.id, 1); now = 3
  const third = await service.acquire('https://example.com/3.png')
  await expect(service.page(second.id, 1)).rejects.toThrow()
  await expect(service.page(first.id, 1)).resolves.toMatchObject({ mime: 'image/png' })
  now = 25; await service.cleanup()
  await expect(service.page(first.id, 1)).rejects.toThrow(); await expect(service.page(third.id, 1)).rejects.toThrow()
})
it('rejects overlapping work to bound memory/process usage', async () => {
  let finish!: (response: Response) => void
  const { service } = await fixture({ fetch: () => new Promise<Response>(resolve => { finish = resolve }) })
  const pending = service.acquire('https://example.com/a.png')
  void pending.catch(() => {})
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await expect(service.acquire('https://example.com/b.png')).rejects.toThrow('Artifact unavailable')
  finish(new Response(png, { headers: { 'content-type': 'image/png' } })); await pending
})

it('injects filesystem failures without leaking paths and removes partial cache directories', async () => {
  const writeFile = vi.fn(async () => { throw new Error('/private/secret filesystem failed') })
  const { service, root } = await fixture({ fs: { ...fs, writeFile } })
  await expect(service.acquire('https://example.com/image.png')).rejects.toThrow(/^Artifact unavailable$/)
  expect(writeFile).toHaveBeenCalledTimes(1)
  const dirs = await fs.readdir(root)
  expect(await fs.readdir(join(root, dirs[0]))).toEqual([])
})
it('rejects empty URL credentials on absolute redirects before URL normalization', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://@example.com/final.png' } }))
  const { service } = await fixture({ fetch })
  await expect(service.acquire('https://example.com/start.png')).rejects.toThrow(/^Artifact unavailable$/)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('cancels rejected oversized bodies without leaving the transport streaming', async () => {
  const cancel = vi.fn()
  const { service } = await fixture({ fetch: async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'image/png', 'content-length': '999999999' } }) })
  await expect(service.acquire('https://example.com/a.png')).rejects.toThrow()
  expect(cancel).toHaveBeenCalledOnce()
})

it('exposes injectable execFile with shell disabled and fixed executable/argv/time/output bounds', async () => {
  const execFile = vi.fn((executable: string, args: string[], options: any, callback: (error: Error | null, stdout: string) => void) => {
    expect(options.shell).toBe(false)
    if (executable.endsWith('/pdfinfo')) { callback(null, 'Pages: 1'); return }
    void fs.writeFile(args.at(-1) + '.png', png).then(() => callback(null, ''))
  })
  const { service } = await fixture({ run: undefined, execFile, fetch: async () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }) })
  const item = await service.acquire('https://example.com/a.pdf')
  await service.page(item.id, 1)
  expect(execFile.mock.calls[0][0]).toBe('/opt/poppler/bin/pdfinfo')
  expect(execFile.mock.calls[1][0]).toBe('/opt/poppler/bin/pdftoppm')
  expect(execFile.mock.calls[1][2]).toMatchObject({ shell: false, timeout: 10_000, maxBuffer: 65536, encoding: 'utf8', killSignal: 'SIGKILL' })
})

it('rejects compressed image dimensions that would exceed texture/pixel bounds before serving or decoding', async () => {
  const hugePng = Buffer.from(png); hugePng.writeUInt32BE(99999, 16)
  const hugeJpeg = Buffer.from('ffd8ffc0000b08ffff000101011100ffd9', 'hex')
  const hugeWebp = Buffer.from('524946462200000057454250565038580a00000000000000ffffff00000000', 'hex')
  for (const [mime, bytes] of [['image/png', hugePng], ['image/jpeg', hugeJpeg], ['image/webp', hugeWebp], ['image/jpeg', Buffer.from('ffd8ffe000104a4649460001', 'hex')]] as const) {
    const { service } = await fixture({ fetch: async () => new Response(bytes, { headers: { 'content-type': mime } }) })
    await expect(service.acquire('https://example.com/a.png')).rejects.toThrow(/^Artifact unavailable$/)
  }
})

it('disposal aborts active owned work and refuses future requests', async () => {
  let signal: AbortSignal | undefined
  const { service } = await fixture({ timeoutMs: 200, fetch: (_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal = options.signal
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
  }) })
  const pending = service.acquire('https://example.com/a.png'); void pending.catch(() => {})
  await vi.waitFor(() => expect(signal).toBeDefined(), { interval: 1, timeout: 50 })
  await service.dispose()
  expect(signal?.aborted).toBe(true)
  await expect(pending).rejects.toThrow(/^Artifact unavailable$/)
  await expect(service.acquire('https://example.com/b.png')).rejects.toThrow(/^Artifact unavailable$/)
})
