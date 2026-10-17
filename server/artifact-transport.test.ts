import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createSecureServer } from 'node:http2'
import type { IncomingHttpHeaders } from 'node:http2'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import type { request } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import type { AddressInfo, Server } from 'node:net'
import { createPinnedFetch } from './artifacts.ts'
import { selfSignedCertificate } from './test-certificate.ts'

// A throwaway self-signed P-256 certificate for example.com, generated for this run (no key is stored in the repo).
const { key, cert } = selfSignedCertificate('example.com')
const pinned = [{ address: '93.184.216.34', family: 4 }]
// The transport may resolve the hostname only to the validated addresses, never through DNS.
function expectPinned(options: Record<string, unknown>) {
  const done = vi.fn(); (options.lookup as (host: string, options: object, callback: typeof done) => void)('example.com', { all: true }, done)
  expect(done).toHaveBeenCalledWith(null, pinned)
}
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))) })
async function listen(server: Server) {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}
// Like some real HTTP/2-only media origins: negotiate only h2 and reset anything else (ECONNRESET).
function h2Only(handler: Parameters<typeof createSecureServer>[1]) {
  return createSecureServer({ key, cert, allowHTTP1: false }, handler).on('unknownProtocol', socket => socket.destroy())
}
// Route the pinned public address to a local origin trusting only its test certificate, through either
// transport seam (HTTP/1.1 request lookup or TLS connect), and record the address the transport asked for.
function routeTo(port: number) {
  const reached: Record<string, unknown>[] = []
  const connect = ((options: Record<string, unknown>) => { reached.push(options); return tlsConnect({ ...options, host: '127.0.0.1', port, ca: cert }) }) as unknown as typeof tlsConnect
  const lookup = (_host: string, options: { all?: boolean }, done: (error: null, address: unknown, family?: number) => void) => options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)
  const route = ((url: URL, options: Record<string, unknown>, respond: () => void) => httpsRequest(url, options.createConnection ? options : { ...options, port, ca: cert, lookup }, respond)) as unknown as typeof request
  return { reached, connect, request: route }
}
it('fetches from HTTP/2-only origins, which reset HTTP/1.1, over the pinned hostname-verified connection', async () => {
  const seen: IncomingHttpHeaders[] = []
  const port = await listen(h2Only((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '9' }); res.end('%PDF-1.7\n') }))
  const route = routeTo(port)
  const response = await createPinnedFetch(route.request, route.connect)('https://example.com/talks/paper.pdf?v=1', { addresses: pinned, signal: AbortSignal.timeout(5000) })
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/pdf'); expect(await response.text()).toBe('%PDF-1.7\n')
  expect(route.reached).toMatchObject([{ host: 'example.com', servername: 'example.com', rejectUnauthorized: true, ALPNProtocols: ['h2', 'http/1.1'] }]); expectPinned(route.reached[0])
  expect(seen).toMatchObject([{ ':method': 'GET', ':path': '/talks/paper.pdf?v=1', ':authority': 'example.com', 'accept-encoding': 'identity', 'user-agent': 'RealHermes/0.0.0 (artifact viewer)' }])
})
it('falls back to HTTP/1.1 on the same pinned connection when the origin does not offer h2', async () => {
  const seen: unknown[] = []
  const port = await listen(createHttpsServer({ key, cert, ALPNProtocols: ['http/1.1'] }, (req, res) => { seen.push([(req.socket as TLSSocket).alpnProtocol, req.headers.host, req.url]); res.writeHead(200, { 'content-type': 'image/png' }); res.end('png-bytes') }))
  const route = routeTo(port)
  const response = await createPinnedFetch(route.request, route.connect)('https://example.com/a.png', { addresses: pinned, signal: AbortSignal.timeout(5000) })
  expect(await response.text()).toBe('png-bytes'); expect(seen).toEqual([['http/1.1', 'example.com', '/a.png']])
  expect(route.reached).toMatchObject([{ host: 'example.com', servername: 'example.com', rejectUnauthorized: true }]); expectPinned(route.reached[0])
})
it('still rejects a certificate for another hostname before any HTTP/2 request is sent', async () => {
  const handler = vi.fn()
  const route = routeTo(await listen(h2Only(handler)))
  await expect(createPinnedFetch(route.request, route.connect)('https://evil.example/paper.pdf', { addresses: pinned, signal: AbortSignal.timeout(5000) })).rejects.toThrow()
  expect(handler).not.toHaveBeenCalled()
})
it('aborts a stalled HTTP/2 body when the acquisition signal fires', async () => {
  const route = routeTo(await listen(h2Only((_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write('%PDF-') })))
  const controller = new AbortController()
  const response = await createPinnedFetch(route.request, route.connect)('https://example.com/stall.pdf', { addresses: pinned, signal: controller.signal })
  const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('%PDF-')
  controller.abort(); await expect(reader.read()).rejects.toThrow()
})
// A connected HTTP/1.1 TLS socket stand-in for the request-option tests below.
function fakeTls() {
  const socket = Object.assign(new EventEmitter(), { alpnProtocol: 'http/1.1', destroy: vi.fn() })
  const connect = vi.fn((_options: Record<string, unknown>) => { queueMicrotask(() => socket.emit('secureConnect')); return socket })
  return { socket, connect, seam: connect as unknown as typeof tlsConnect }
}
it('connects only to the validated address with hostname TLS checks and reuses that socket, never resolving DNS again', async () => {
  let passed: any
  const requestFake = vi.fn((url, options, respond) => {
    passed = options
    expect(url.href).toBe('https://example.com/a.png')
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => {
      const stream = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> }
      stream.statusCode = 200; stream.headers = { 'content-type': 'image/png' }
      respond(stream); stream.end('bytes')
    }
    return req
  })
  const tls = fakeTls()
  const response = await createPinnedFetch(requestFake as unknown as typeof request, tls.seam)('https://example.com/a.png', { addresses: [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }], signal: new AbortController().signal })
  expect(tls.connect.mock.calls[0][0]).toMatchObject({ host: 'example.com', port: 443, servername: 'example.com', rejectUnauthorized: true, ALPNProtocols: ['h2', 'http/1.1'] })
  const callback = vi.fn(); const lookup = tls.connect.mock.calls[0][0].lookup as (host: string, options: object, done: typeof callback) => void
  lookup('example.com', {}, callback); expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  lookup('example.com', { all: true }, callback); expect(callback).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }])
  expect(passed.createConnection()).toBe(tls.socket); expect(passed.lookup).toBeUndefined(); expect(passed.agent).toBeUndefined()
  // Some large media hosts reject requests without a User-Agent (403).
  expect(passed.headers).toEqual({ Accept: 'application/pdf,image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity', 'User-Agent': 'RealHermes/0.0.0 (artifact viewer)' })
  expect(passed.signal).toBeInstanceOf(AbortSignal); expect(await response.text()).toBe('bytes')
})
it('refuses invalid addresses even at the pinned transport boundary', async () => {
  const requestFake = vi.fn(); const tls = fakeTls()
  await expect(createPinnedFetch(requestFake as unknown as typeof request, tls.seam)('https://example.com/a.png', { addresses: [{ address: '127.0.0.1', family: 4 }], signal: new AbortController().signal })).rejects.toThrow('Artifact unavailable')
  expect(tls.connect).not.toHaveBeenCalled(); expect(requestFake).not.toHaveBeenCalled()
})

it('explicitly requires TLS certificate verification even if the host environment disables Node defaults', async () => {
  const requestFake = vi.fn((_url, _options, respond) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => {
      const stream = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> }
      stream.statusCode = 204; stream.headers = {}; respond(stream); stream.end()
    }
    return req
  })
  const tls = fakeTls()
  // IP-literal origins verify the certificate against the IP and send no SNI.
  await createPinnedFetch(requestFake as unknown as typeof request, tls.seam)('https://93.184.216.34/a.png', { addresses: [{ address: '93.184.216.34', family: 4 }], signal: new AbortController().signal })
  expect(tls.connect.mock.calls[0][0]).toMatchObject({ host: '93.184.216.34', rejectUnauthorized: true }); expect(tls.connect.mock.calls[0][0].servername).toBeUndefined()
})
