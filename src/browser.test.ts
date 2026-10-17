import { expect, it, vi } from 'vitest'
import { browserServices, recordingPeak, recordMicrophone } from './browser'
it('sends chat through the local relay and reports relay failures', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => streamReply('Hello'))
  const services = browserServices(fetcher)
  expect(await services.chat('Hi')).toBe('Hello')
  expect(fetcher.mock.calls[0][0]).toBe('/api/hermes/chat/stream')
  await expect(browserServices(async () => Response.json({ error: 'Unavailable' }, { status: 503 })).chat('Hi')).rejects.toThrow('Unavailable')
})
it('plays returned data URL directly and signals speaking only after playback starts', async () => {
  const started = vi.fn(); const pause = vi.fn(); let source = ''
  class FakeAudio { onended?: () => void; onerror?: () => void; constructor(url: string) { source = url } async play() { expect(started).not.toHaveBeenCalled(); queueMicrotask(() => this.onended?.()) } pause = pause }
  vi.stubGlobal('Audio', FakeAudio)
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ data_url: 'data:audio/mpeg;base64,AQI=', mime_type: 'audio/mpeg' }))
  await browserServices(fetcher).speak('Hi', started)
  expect(source).toBe('data:audio/mpeg;base64,AQI='); expect(started).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0][0]).toBe('/api/audio/speak')
  vi.stubGlobal('Audio', class extends FakeAudio { async play() { throw Error('Playback blocked') } })
  started.mockClear()
  await expect(browserServices(fetcher).speak('Hi', started)).rejects.toThrow('Playback blocked')
  expect(started).not.toHaveBeenCalled(); vi.unstubAllGlobals()
})
it('encodes microphone audio as JSON with MIME parameters and no credentials', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ text: 'Hi' }))
  await browserServices(fetcher).transcribe(new Blob(['voice'], { type: 'audio/webm;codecs=opus' }))
  expect(fetcher.mock.calls[0][0]).toBe('/api/audio/transcribe')
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ data_url: 'data:audio/webm;codecs=opus;base64,dm9pY2U=', mime_type: 'audio/webm;codecs=opus' })
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
})
it('refuses digital-silence recordings before upload and names the microphone, not speech', async () => {
  for (const peak of [0, 2 ** -15]) {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ text: 'You' }))
    await expect(browserServices(fetcher, async () => peak).transcribe(new Blob(['silence'], { type: 'audio/webm;codecs=opus' }))).rejects.toThrow('Microphone returned digital silence')
    expect(fetcher).not.toHaveBeenCalled()
  }
})
it('uploads audible recordings and recordings that cannot be analysed', async () => {
  for (const peak of [2 ** -14, 0.25, undefined]) {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ text: 'Hi' }))
    expect(await browserServices(fetcher, async () => peak).transcribe(new Blob(['voice'], { type: 'audio/webm' }))).toBe('Hi')
    expect(fetcher).toHaveBeenCalledOnce()
  }
})
it('measures the decoded peak across channels and reports undecodable audio as unknown', async () => {
  const channels = [Float32Array.of(0, 2 ** -16, -0.5), Float32Array.of(0.25)]
  const decode = vi.fn(async (_data: ArrayBuffer) => ({ numberOfChannels: 2, getChannelData: (channel: number) => channels[channel] }))
  expect(await recordingPeak(new Blob(['voice']), decode)).toBe(0.5)
  expect(new TextDecoder().decode(decode.mock.calls[0][0])).toBe('voice')
  expect(await recordingPeak(new Blob(['voice']), async () => { throw new Error('Unsupported codec') })).toBeUndefined()
})
it('records audio and stops microphone tracks', async () => {
  const stop = vi.fn(); const stream = { getTracks: () => [{ stop }] }
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream } })
  class Recorder {
    mimeType = 'audio/webm'; state = 'inactive'; ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice']) }); this.onstop?.() }
  }
  vi.stubGlobal('MediaRecorder', Recorder)
  const complete = vi.fn(); const recording = await recordMicrophone(complete, () => {})
  recording.stop(); expect(stop).toHaveBeenCalledOnce(); expect(complete.mock.calls[0][0].type).toBe('audio/webm')
  vi.unstubAllGlobals()
})

it('rejects malformed speech before attempting playback', async () => {
  const audio = vi.fn(); vi.stubGlobal('Audio', audio)
  await expect(browserServices(async () => Response.json({ data_url: 'data:audio/mpeg;base64,@@@@', mime_type: 'audio/mpeg' })).speak('Hi', () => {})).rejects.toThrow('Invalid relay audio')
  expect(audio).not.toHaveBeenCalled(); vi.unstubAllGlobals()
})

// Hermes decides when a turn needs the wearer's view; the browser never classifies wording.
it.each([
  "What is the orange thing I'm looking at?", "Do you tell me what I'm looking at?", 'What am I looking at?',
  'Can you read the label in front of me?', 'Which of these cables goes to port two?', 'LOOK AT THIS!',
  'Find me the data sheet.', 'Hi',
])('sends %j as plain text, with no visual flag', async text => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => streamReply('Hello'))
  await browserServices(fetcher).chat(text)
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ text })
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
})

function streamReply(text: string) { return streamed(`event: text\ndata: ${JSON.stringify({ delta: text })}\n\nevent: answer\ndata: ${JSON.stringify({ text })}\n\nevent: done\ndata: {}\n\n`) }
function streamed(wire: string) {
  const bytes = new TextEncoder().encode(wire)
  return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
it('accumulates fragmented text and signals only sanitized working events', async () => {
  const working = vi.fn()
  const wire = 'event: working\ndata: {}\n\nevent: text\ndata: {"delta":"Hé"}\n\nevent: text\ndata: {"delta":"llo"}\n\nevent: answer\ndata: {"text":"Héllo"}\n\nevent: done\ndata: {}\n\n'
  expect(await browserServices(async () => streamed(wire)).chat('Hi', working)).toBe('Héllo')
  expect(working).toHaveBeenCalledOnce()
})
it.each([
  '', 'event: done\ndata: {}\n\n', 'event: text\ndata: {"delta":"Hi"}\n\n',
  'event: text\ndata: invalid\n\n', 'event: error\ndata: {"error":"Hermes request failed"}\n\n',
  'event: status\ndata: {}\n\n', 'event: working\ndata: {"arguments":"private"}\n\n',
  'event: answer\ndata: {"text":" "}\n\nevent: done\ndata: {}\n\n',
  'event: text\ndata: {"delta":42}\n\n',
  'event: text\ndata: {"delta":"Hi"}\n\nevent: answer\ndata: {"text":"Other"}\n\nevent: done\ndata: {}\n\n',
  'event: answer\ndata: {"text":"Hi"}\n\nevent: done\ndata: {}\n\nevent: text\ndata: {"delta":"late"}\n\n',
  'x'.repeat(65537),
])('rejects malformed, empty, error and incomplete browser streams', async wire => {
  await expect(browserServices(async () => streamed(wire)).chat('Hi')).rejects.toThrow()
})
it('rejects non-SSE chat responses', async () => {
  await expect(browserServices(async () => Response.json({ text: 'Hi' })).chat('Hi')).rejects.toThrow()
})
it('shows every relay error event as the one sanitized failure', async () => {
  for (const error of ['The visual answer timed out. Please ask again.', '/private/secret token', 42]) {
    await expect(browserServices(async () => streamed(`event: error\ndata: ${JSON.stringify({ error })}\n\n`)).chat('What is this?')).rejects.toThrow(new Error('Hermes request failed'))
  }
})
it('gives every turn, visual wording included, the same 125-second deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const signals: Record<string, AbortSignal> = {}
    const fetcher = (_url: RequestInfo | URL, init?: RequestInit) => {
      signals[JSON.parse(String(init?.body)).text] = init!.signal!
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    }
    const turns = ["What is the orange thing I'm looking at?", 'What am I looking at?', 'Hi'].map(text => browserServices(fetcher).chat(text))
    for (const turn of turns) turn.catch(() => {})
    const aborted = () => Object.values(signals).map(signal => signal.aborted)
    await vi.advanceTimersByTimeAsync(124_999); expect(aborted()).toEqual([false, false, false])
    await vi.advanceTimersByTimeAsync(1); expect(aborted()).toEqual([true, true, true])
    await expect(turns[0]).rejects.toThrow(new Error('Hermes request timed out'))
  } finally { vi.useRealTimers() }
})
const verified = { id: 'c'.repeat(32), kind: 'pdf', title: 'Bird Hunting Season.pdf', pageCount: 119 }
const recovered = (artifact: unknown, tail = '') => 'event: text\ndata: {"delta":"https://dead.example.com/a.pdf"}\n\nevent: working\ndata: {}\n\nevent: reset\ndata: {}\n\n' +
  `event: text\ndata: ${JSON.stringify({ delta: 'Here: https://good.example.com/a.pdf' })}\n\nevent: artifact\ndata: ${JSON.stringify(artifact)}\n\n${tail}` +
  `event: answer\ndata: ${JSON.stringify({ text: 'Here: https://good.example.com/a.pdf' })}\n\nevent: done\ndata: {}\n\n`
it('drops text the relay superseded and opens only the artifact it verified', async () => {
  const found = vi.fn()
  expect(await browserServices(async () => streamed(recovered(verified))).chat('Show me the paper', undefined, found)).toBe('Here: https://good.example.com/a.pdf')
  expect(found).toHaveBeenCalledExactlyOnceWith(verified)
})
it.each([
  ['a reset after the artifact', recovered(verified, 'event: reset\ndata: {}\n\n')],
  ['a reset with a payload', recovered(verified).replace('event: reset\ndata: {}', 'event: reset\ndata: {"text":"x"}')],
  ['an answer that repeats superseded text', 'event: text\ndata: {"delta":"old"}\n\nevent: reset\ndata: {}\n\nevent: answer\ndata: {"text":"old"}\n\nevent: done\ndata: {}\n\n'],
])('rejects %s', async (_case, wire) => {
  const found = vi.fn()
  await expect(browserServices(async () => streamed(wire)).chat('Show me the paper', undefined, found)).rejects.toThrow()
  expect(found).not.toHaveBeenCalled()
})
it('keeps a long verified turn alive while the relay reports progress, and gives up after 125 s of silence', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let push!: (wire: string) => void; let signal!: AbortSignal
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init!.signal!
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        push = wire => controller.enqueue(new TextEncoder().encode(wire))
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      } }), { headers: { 'Content-Type': 'text/event-stream' } })
    }
    const turn = browserServices(fetcher).chat('Show me the paper'); turn.catch(() => {})
    for (let step = 0; step < 3; step++) { await vi.advanceTimersByTimeAsync(100_000); push('event: working\ndata: {}\n\n') }
    await vi.advanceTimersByTimeAsync(124_999); expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1); expect(signal.aborted).toBe(true)
    await expect(turn).rejects.toThrow(new Error('Hermes request timed out'))
  } finally { vi.useRealTimers() }
})
const localArtifact = { id: 'a'.repeat(32), kind: 'image', title: 'Numbix One.png', pageCount: 1 }
const localWire = (artifact: unknown) => `event: text\ndata: {"delta":"Here."}\n\nevent: artifact\ndata: ${JSON.stringify(artifact)}\n\nevent: answer\ndata: {"text":"Here."}\n\nevent: done\ndata: {}\n\n`
it('hands over a relay-found local artifact only once the answer is complete', async () => {
  const found = vi.fn()
  expect(await browserServices(async () => streamed(localWire(localArtifact))).chat('Show me the picture of Numbix One from my computer', undefined, found)).toBe('Here.')
  expect(found).toHaveBeenCalledExactlyOnceWith(localArtifact)
  const incomplete = vi.fn()
  await expect(browserServices(async () => streamed(localWire(localArtifact).replace('event: done\ndata: {}\n\n', ''))).chat('Show me', undefined, incomplete)).rejects.toThrow()
  expect(incomplete).not.toHaveBeenCalled()
})
it.each([
  { path: '/home/example/Numbix One.png' }, { sourceUrl: 'file:///home/example/Numbix%20One.png' }, { id: '../secret' }, { kind: 'html' },
  { pageCount: 2 }, { kind: 'pdf', pageCount: 501 }, { title: 'x'.repeat(161) }, { title: 7 },
])('rejects unsafe local artifact metadata %j', async change => {
  const found = vi.fn()
  await expect(browserServices(async () => streamed(localWire({ ...localArtifact, ...change }))).chat('Show me', undefined, found)).rejects.toThrow('Invalid relay stream')
  expect(found).not.toHaveBeenCalled()
})
it('rejects repeated or late local artifact events', async () => {
  const artifact = `event: artifact\ndata: ${JSON.stringify(localArtifact)}\n\n`
  for (const wire of [localWire(localArtifact).replace('event: answer', artifact.trimEnd() + '\n\nevent: answer'), localWire(localArtifact).replace('event: done', artifact + 'event: done')]) {
    await expect(browserServices(async () => streamed(wire)).chat('Show me', undefined, vi.fn())).rejects.toThrow('Invalid relay stream')
  }
})
