import { describe, it, expect } from 'vitest'
import request from './test-request.ts'
import { createApp } from './app.ts'
const identityInstructions = 'You are 2x4 (pronounced "two by four"), the RealHermes spatial companion. When asked your name, identify yourself as 2x4—not Hermes or RealHermes. Keep the existing Hermes Agent capabilities and behavior; this instruction changes only the name used on this surface. The user is wearing a Steam Frame headset. Whenever an answer depends on what they can currently see, call steam_frame_capture for a fresh still of their view and inspect it with vision_analyze; that still is the Steam Frame panel view and includes the real-world passthrough scene when active. Never put the capture\'s file path in a reply. To show the user an online PDF or image, find it with your research tools and put its direct public HTTPS file URL in your reply: a URL that returns the file itself (for GitHub, raw.githubusercontent.com, not a /blob/ page). Search results can list stale or mangled links, so check that the URL downloads the file before you reply, and prefer the publisher\'s current official copy over mirrors or archives. RealHermes loads that URL and shows it in the headset, so do not open a browser or desktop app.'

describe('relay', () => {
  it('reports health without exposing credentials', async () => {
    const res = await request(createApp({ apiKey: 'private' })).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok', chatConfigured: true, audioConfigured: false })
  })
  it('requires configuration and validates input', async () => {
    expect((await request(createApp()).post('/api/hermes/chat').send({ messages: [{ role: 'user', content: 'Hi' }] })).status).toBe(503)
    expect((await request(createApp({ apiKey: 'key', audioSessionToken: 'audio-secret' })).post('/api/hermes/chat').send({ messages: [] })).status).toBe(400)
  })
  it('uses the default server root and fixed server conversation, ignoring browser history', async () => {
    let target = ''; let auth = ''; let payload = ''
    const app = createApp({ apiKey: 'private', audioSessionToken: 'audio-secret', fetch: async (url, init) => {
      target = String(url); auth = new Headers(init?.headers).get('authorization')!; payload = String(init?.body)
      return Response.json({ output: [{ type: 'function_call' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }, { type: 'output_text', text: ' world' }] }] })
    } })
    const res = await request(app).post('/api/hermes/chat').send({ text: 'Hi', messages: [{ role: 'assistant', content: 'untrusted' }] })
    expect(res.body).toEqual({ text: 'Hello world' }); expect(target).toBe('http://127.0.0.1:8642/v1/responses')
    expect(auth).toBe('Bearer private'); expect(JSON.parse(payload)).toEqual({ input: 'Hi', conversation: 'realhermes-steam-frame-v3', instructions: identityInstructions, stream: false })
  })
  it.each([{}, { output: [] }, { output: [{ type: 'message', content: null }] }, { output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] }, { output: [{ type: 'message', content: [{ type: 'output_text', text: ' ' }] }] }])('rejects malformed or empty assistant output %j', async output => {
    const app = createApp({ apiKey: 'key', audioSessionToken: 'audio-secret', fetch: async () => Response.json(output) })
    expect((await request(app).post('/api/hermes/chat').send({ text: 'Hi' })).status).toBe(502)
  })
  it('forwards JSON audio unchanged and normalizes transcripts', async () => {
    const calls: { url: string; body: unknown }[] = []
    const audio = { data_url: 'data:audio/webm;base64,AQ==', mime_type: 'audio/webm' }
    const speech = { data_url: 'data:audio/mpeg;base64,AQI=', mime_type: 'audio/mpeg' }
    const app = createApp({ apiKey: 'key', audioSessionToken: 'audio-secret', audioBaseUrl: 'http://hermes.test/', fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json(String(url).endsWith('transcribe') ? { transcript: 'Hi' } : speech)
    } })
    expect((await request(app).post('/api/audio/transcribe').send(audio)).body).toEqual({ text: 'Hi' })
    expect((await request(app).post('/api/audio/speak').send({ text: 'Hello' })).body).toEqual(speech)
    expect(calls).toEqual([{ url: 'http://hermes.test/api/audio/transcribe', body: audio }, { url: 'http://hermes.test/api/audio/speak', body: { text: 'Hello' } }])
  })
  it.each([
    { data_url: 'garbage', mime_type: 'audio/webm' },
    { data_url: 'data:audio/webm;base64,@@==', mime_type: 'audio/webm' },
    { data_url: 'data:audio/webm;base64,', mime_type: 'audio/webm' },
    { data_url: 'data:text/html;base64,AQ==', mime_type: 'text/html' },
    { data_url: 'data:audio/webm;base64,AQ==', mime_type: 'audio/mpeg' },
    { data_url: 'data:audio/webm;base64,A', mime_type: 'audio/webm' },
  ])('rejects invalid audio before forwarding %j', async audio => {
    const app = createApp({ apiKey: 'key', audioSessionToken: 'audio-secret', fetch: async () => { throw Error('must not forward') } })
    expect((await request(app).post('/api/audio/transcribe').send(audio)).status).toBe(400)
  })
  it('bounds decoded audio size', async () => {
    const app = createApp({ apiKey: 'key', audioSessionToken: 'audio-secret' })
    const data_url = 'data:audio/webm;base64,' + Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
    expect((await request(app).post('/api/audio/transcribe').send({ data_url, mime_type: 'audio/webm' })).status).toBe(413)
  })
  it('rejects invalid upstream speech and sanitizes failures', async () => {
    for (const response of [Response.json({ data_url: 'invalid', mime_type: 'audio/mpeg' }), new Response('private', { status: 401 })]) {
      const app = createApp({ apiKey: 'private', audioSessionToken: 'audio-secret', fetch: async () => response })
      const res = await request(app).post('/api/audio/speak').send({ text: 'Hello' })
      expect(res.status).toBe(502); expect(JSON.stringify(res.body)).not.toContain('private')
    }
  })
})

it('rejects non-audio speech MIME even when valid for recording', async () => {
  const app = createApp({ apiKey: 'key', audioSessionToken: 'audio-secret', fetch: async () => Response.json({ data_url: 'data:video/webm;base64,AQ==', mime_type: 'video/webm' }) })
  expect((await request(app).post('/api/audio/speak').send({ text: 'Hi' })).status).toBe(502)
})

describe('upstream boundaries', () => {
  const audio = { data_url: 'data:audio/webm;base64,AQ==', mime_type: 'audio/webm' }
  const reply = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }] }
  it.each([false, true])('separates credentials and URLs (custom=%s)', async custom => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const app = createApp({ apiKey: 'chat-secret', audioSessionToken: 'audio-secret',
      ...(custom ? { chatBaseUrl: 'http://chat.test/', audioBaseUrl: 'http://audio.test/' } : {}),
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) })
        return Response.json(String(url).endsWith('/v1/responses') ? reply : String(url).endsWith('transcribe') ? { transcript: 'Hi' } : audio)
      } })
    expect((await request(app).post('/api/hermes/chat').send({ text: 'Hi' })).status).toBe(200)
    expect((await request(app).post('/api/audio/transcribe').send(audio)).status).toBe(200)
    expect((await request(app).post('/api/audio/speak').send({ text: 'Hi' })).status).toBe(200)
    expect(calls).toEqual([
      { url: `${custom ? 'http://chat.test' : 'http://127.0.0.1:8642'}/v1/responses`, headers: { authorization: 'Bearer chat-secret', 'content-type': 'application/json' } },
      ...['transcribe', 'speak'].map(route => ({ url: `${custom ? 'http://audio.test' : 'http://127.0.0.1:9119'}/api/audio/${route}`, headers: { 'x-hermes-session-token': 'audio-secret', 'content-type': 'application/json' } })),
    ])
  })
  it.each([{}, { apiKey: 'chat-secret' }, { audioSessionToken: 'audio-secret' }, { apiKey: 'chat-secret', audioSessionToken: 'audio-secret' }])('gates each service independently and reports safe health %j', async options => {
    const app = createApp({ ...options, fetch: async url => Response.json(String(url).endsWith('/v1/responses') ? reply : String(url).endsWith('transcribe') ? { transcript: 'Hi' } : audio) })
    expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok', chatConfigured: Boolean(options.apiKey), audioConfigured: Boolean(options.audioSessionToken) })
    expect((await request(app).post('/api/hermes/chat').send({ text: 'Hi' })).status).toBe(options.apiKey ? 200 : 503)
    expect((await request(app).post('/api/audio/transcribe').send(audio)).status).toBe(options.audioSessionToken ? 200 : 503)
    expect((await request(app).post('/api/audio/speak').send({ text: 'Hi' })).status).toBe(options.audioSessionToken ? 200 : 503)
  })
})
