import { expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createApp } from './app.ts'
const identityInstructions = 'You are 2x4 (pronounced "two by four"), the RealHermes spatial companion. When asked your name, identify yourself as 2x4—not Hermes or RealHermes. Keep the existing Hermes Agent capabilities and behavior; this instruction changes only the name used on this surface. The user is wearing a Steam Frame headset. Whenever an answer depends on what they can currently see, call steam_frame_capture for a fresh still of their view and inspect it with vision_analyze; that still is the Steam Frame panel view and includes the real-world passthrough scene when active. Never put the capture\'s file path in a reply. To show the user an online PDF or image, find it with your research tools and put its direct public HTTPS file URL in your reply: a URL that returns the file itself (for GitHub, raw.githubusercontent.com, not a /blob/ page). Search results can list stale or mangled links, so check that the URL downloads the file before you reply, and prefer the publisher\'s current official copy over mirrors or archives. RealHermes loads that URL and shows it in the headset, so do not open a browser or desktop app.'
import request from './test-request.ts'
const event = (type: string, data: unknown) => `event: ${type}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`
function sse(source: string) {
  const bytes = new TextEncoder().encode(source)
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
const delta = (text: string) => event('response.output_text.delta', { delta: text })
const completed = event('response.completed', {})
function decode(body: Buffer) {
  // The in-process HTTP harness captures HTTP chunk framing as well as SSE.
  return body.toString().split('\r\n').filter(line => !/^[0-9a-f]+$/.test(line)).join('\n')
}
it('streams fragmented UTF-8 and real tool starts with fixed authenticated conversation', async () => {
  let payload: unknown; let signal: AbortSignal | undefined
  const source = event('response.output_item.added', { item: { type: 'message' } }) + event('response.reasoning.delta', { delta: 'private' }) + event('response.output_item.added', { item: { type: 'function_call', name: 'shell', arguments: '/private/key' } }) + delta('Hé') + event('response.output_item.done', { item: { type: 'function_call' } }) + delta('llo') + completed
  const app = createApp({ apiKey: 'secret', fetch: async (url, init) => {
    expect(String(url)).toBe('http://127.0.0.1:8642/v1/responses'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
    payload = JSON.parse(String(init?.body)); signal = init?.signal as AbortSignal; return sse(source)
  } })
  const res = await request(app).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(res.status).toBe(200); expect(res.headers['content-type']).toContain('text/event-stream')
  expect(payload).toEqual({ input: 'Hi', conversation: 'realhermes-steam-frame-v3', instructions: identityInstructions, stream: true }); expect(signal).toBeInstanceOf(AbortSignal)
  const wire = decode(res.body)
  expect(wire.match(/event: working/g)).toHaveLength(1)
  expect(wire).toContain('data: {"delta":"Hé"}'); expect(wire).toContain('data: {"text":"Héllo"}'); expect(wire).toContain('event: done')
  for (const secret of ['private', 'shell', 'arguments', 'reasoning']) expect(wire).not.toContain(secret)
})
it('never reports working for text, commentary or tool completion', async () => {
  const app = createApp({ apiKey: 'key', fetch: async () => sse(event('response.output_item.done', { item: { type: 'function_call' } }) + event('status', { text: 'Working' }) + delta('Hello') + completed) })
  const res = await request(app).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(res.status).toBe(200); expect(decode(res.body)).not.toContain('event: working'); expect(decode(res.body)).toContain('event: done')
})
it.each([event('error', { message: '/private/secret Bearer key' }), delta('Hi'), completed, 'data: invalid\n\n', delta('x'.repeat(8001)) + completed, 'x'.repeat(65537)])('sanitizes failed, incomplete, empty and oversized streams', async source => {
  const res = await request(createApp({ apiKey: 'key', fetch: async () => sse(source) })).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(res.status).toBe(200); const wire = decode(res.body)
  expect(wire).toContain('event: error'); expect(wire).toContain('Hermes request failed'); expect(wire).not.toContain('secret'); expect(wire).not.toContain('event: done')
})
it('validates text before streaming', async () => {
  const fetcher = vi.fn()
  for (const body of [{ text: '' }, { text: ' ' }, { text: 'x'.repeat(8001) }, { messages: [{ role: 'user', content: 'Hi' }] }]) expect((await request(createApp({ apiKey: 'key', fetch: fetcher })).post('/api/hermes/chat/stream').send(body)).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['timeout', 'disconnect'])('aborts upstream and cancels reader on %s', async mode => {
  let relayResponse!: ServerResponse; let upstreamSignal!: AbortSignal
  const cancelled = vi.fn(); let closeTimer: ReturnType<typeof setTimeout>
  const app = createApp({ apiKey: 'key', streamTimeoutMs: mode === 'timeout' ? 5 : 1000, fetch: async (_url, init) => {
    upstreamSignal = init!.signal as AbortSignal
    if (mode === 'disconnect') queueMicrotask(() => relayResponse.emit('close'))
    return new Response(new ReadableStream({ start(c) { closeTimer = setTimeout(() => c.close(), 50) }, cancel() { clearTimeout(closeTimer); cancelled() } }), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const res = await request(app, response => { relayResponse = response }).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(upstreamSignal.aborted).toBe(true); expect(cancelled).toHaveBeenCalledOnce()
  expect(decode(res.body)).toContain('event: error'); expect(decode(res.body)).not.toContain('event: done')
})
it('sanitizes upstream HTTP failures', async () => {
  const res = await request(createApp({ apiKey: 'secret', fetch: async () => new Response('/private/secret', { status: 401 }) })).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(decode(res.body)).toContain('Hermes request failed'); expect(decode(res.body)).not.toContain('secret')
})
it('accepts bounded inline vision-tool output without forwarding it downstream', async () => {
  const wire = event('response.output_item.done', { item: { type: 'function_call_output', output: '😀'.repeat(17000) } }) + delta('Hello') + completed
  const res = await request(createApp({ apiKey: 'test-value', fetch: async () => sse(wire) })).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(decode(res.body)).toContain('event: done'); expect(decode(res.body)).toContain('data: {"text":"Hello"}'); expect(decode(res.body)).not.toContain('😀')
})
it('waits for downstream drain before writing further events', async () => {
  let writes = 0; let waiting = false; let violation = false
  const app = createApp({ apiKey: 'key', fetch: async () => sse(delta('Hi') + completed) })
  const res = await request(app, response => {
    const write = response.write.bind(response)
    response.write = ((...args: Parameters<typeof response.write>) => {
      if (waiting) violation = true
      const result = write(...args); writes++
      if (writes === 1) {
        waiting = true
        setTimeout(() => { waiting = false; response.emit('drain') }, 5)
        return false
      }
      return result
    }) as typeof response.write
  }).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(violation).toBe(false); expect(decode(res.body)).toContain('event: done')
})
it('accepts data.type SSE envelopes without mistaking unnamed or other items for starts', async () => {
  const wire = 'data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n' + 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n' + 'data: {"type":"response.completed"}\n\n'
  const res = await request(createApp({ apiKey: 'key', fetch: async () => sse(wire) })).post('/api/hermes/chat/stream').send({ text: 'Hi' })
  expect(decode(res.body)).not.toContain('event: working'); expect(decode(res.body)).toContain('data: {"text":"Hi"}'); expect(decode(res.body)).toContain('event: done')
})
