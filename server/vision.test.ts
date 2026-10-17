import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import request from './test-request.ts'
// Server-owned: the 2x4 identity, then the standing capability to look at the wearer's current view.
const instructions = 'You are 2x4 (pronounced "two by four"), the RealHermes spatial companion. When asked your name, identify yourself as 2x4—not Hermes or RealHermes. Keep the existing Hermes Agent capabilities and behavior; this instruction changes only the name used on this surface. The user is wearing a Steam Frame headset. Whenever an answer depends on what they can currently see, call steam_frame_capture for a fresh still of their view and inspect it with vision_analyze; that still is the Steam Frame panel view and includes the real-world passthrough scene when active. Never put the capture\'s file path in a reply. To show the user an online PDF or image, find it with your research tools and put its direct public HTTPS file URL in your reply: a URL that returns the file itself (for GitHub, raw.githubusercontent.com, not a /blob/ page). Search results can list stale or mangled links, so check that the URL downloads the file before you reply, and prefer the publisher\'s current official copy over mirrors or archives. RealHermes loads that URL and shows it in the headset, so do not open a browser or desktop app.'
const demo = "What is the orange thing I'm looking at?"
const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const delta = (text: string) => event('response.output_text.delta', { delta: text })
const completed = event('response.completed', {})
const toolStart = (name: string) => event('response.output_item.added', { item: { type: 'function_call', name, arguments: '{"image_url":"/home/example/.hermes/cache/steam-frame-view/capture.jpg"}' } })
function streamed(source: string) { return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }) }
function decode(body: Buffer) { return body.toString().split('\r\n').filter(line => !/^[0-9a-f]+$/.test(line)).join('\n') }
afterEach(() => { vi.useRealTimers() })

it.each([demo, "Do you tell me what I'm looking at?", 'What is this?', 'Read this', 'Find me the data sheet', 'Which cable goes to port two?'])('sends %j on the shared conversation as plain text, leaving the view to Hermes', async text => {
  let payload: unknown
  const app = createApp({ apiKey: 'key', fetch: async (_url, init) => { payload = JSON.parse(String(init?.body)); return streamed(delta('An orange traffic cone.') + completed) } })
  const wire = decode((await request(app).post('/api/hermes/chat/stream').send({ text })).body)
  expect(wire).toContain('data: {"text":"An orange traffic cone."}'); expect(wire).toContain('event: done')
  expect(payload).toEqual({ input: text, conversation: 'realhermes-steam-frame-v3', instructions, stream: true })
})

it('lets Hermes capture, inspect and look things up with its own tools, reporting only that it is working', async () => {
  const app = createApp({ apiKey: 'key', fetch: async () => streamed(toolStart('steam_frame_capture') + toolStart('vision_analyze') + toolStart('web_search') + delta('An orange traffic cone.') + completed) })
  const wire = decode((await request(app).post('/api/hermes/chat/stream').send({ text: demo })).body)
  expect(wire.match(/event: working/g)).toHaveLength(3)
  expect(wire).toContain('data: {"text":"An orange traffic cone."}'); expect(wire).toContain('event: done')
  for (const leaked of ['steam_frame_capture', 'vision_analyze', 'web_search', 'image_url', 'steam-frame-view']) expect(wire).not.toContain(leaked)
})

it.each([true, false, 'true'])('ignores a legacy include_vision flag (%j): no frame is attached and nothing is rejected', async include_vision => {
  const payloads: unknown[] = []
  const app = createApp({ apiKey: 'key', fetch: async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return String(_url).endsWith('/v1/responses') && JSON.parse(String(init?.body)).stream ? streamed(delta('Seen') + completed) : Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Seen' }] }] }) } })
  expect((await request(app).post('/api/hermes/chat/stream').send({ text: 'What is this?', include_vision })).status).toBe(200)
  expect((await request(app).post('/api/hermes/chat').send({ text: 'What is this?', include_vision })).body).toEqual({ text: 'Seen' })
  expect(payloads).toEqual([
    { input: 'What is this?', conversation: 'realhermes-steam-frame-v3', instructions, stream: true },
    { input: 'What is this?', conversation: 'realhermes-steam-frame-v3', instructions, stream: false },
  ])
})

it('gives a visually worded or research turn the standard 120-second turn budget', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let signal: AbortSignal | undefined; let started!: () => void
  const fetched = new Promise<void>(resolve => { started = resolve })
  const app = createApp({ apiKey: 'key', fetch: async (_url, init) => {
    signal = init!.signal as AbortSignal; started()
    return new Response(new ReadableStream({ start(controller) { signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true }) } }), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const turn = Promise.resolve(request(app).post('/api/hermes/chat/stream').send({ text: demo }))
  await fetched
  await vi.advanceTimersByTimeAsync(119_999); expect(signal!.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1); expect(signal!.aborted).toBe(true)
  expect(decode((await turn).body)).toContain('event: error\ndata: {"error":"Hermes request failed"}')
})
