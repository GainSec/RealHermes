import { afterEach, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import type { ArtifactMetadata, ArtifactService } from './artifacts.ts'
import request from './test-request.ts'
// The exact dead link Hermes returned live (its directory is duplicated: HTTP 404), and the verified single-directory file.
const dead = 'https://media.defcon.org/DEF%20CON%2034/DEF%20CON%2034%20presentations/DEF%20CON%2034%20presentations/DEF%20CON%2034%20-%20Jon%20Gaines%20-%20Bird%20Hunting%20Season%20The%20Final%20Flight%20-%20PDF%20v1.pdf'
const good = 'https://media.defcon.org/DEF%20CON%2034/DEF%20CON%2034%20presentations/DEF%20CON%2034%20-%20Jon%20Gaines%20-%20Bird%20Hunting%20Season%20The%20Final%20Flight%20-%20PDF%20v1.pdf'
const paper: ArtifactMetadata = { id: 'c'.repeat(32), kind: 'pdf', title: 'DEF CON 34 - Jon Gaines - Bird Hunting Season The Final Flight - PDF v1.pdf', pageCount: 119, sourceUrl: good }
const shown = { id: paper.id, kind: paper.kind, title: paper.title, pageCount: paper.pageCount }
const failure = 'I errored out while loading the artifact. Check the logs.'
const request_ = 'Find the latest GainSec paper from DEF CON and show it to me.'
const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const reply = (text: string) => new Response(sse('response.output_text.delta', { delta: text }) + sse('response.completed', {}), { headers: { 'Content-Type': 'text/event-stream' } })
afterEach(() => { vi.useRealTimers() })

// One model answer per upstream call, recording each request body.
function hermes(...answers: string[]) {
  const bodies: Array<{ input: string; conversation: string; instructions: string; stream: boolean }> = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const answer = answers[bodies.length - 1]
    if (answer === undefined) throw new Error('unexpected upstream call')
    return reply(answer)
  })
  return { fetch, bodies }
}
// Like the real service: success returns metadata, failure throws with a sanitized reason.
function artifacts(outcomes: Record<string, ArtifactMetadata | string | Array<ArtifactMetadata | string>>) {
  const calls: string[] = []
  const outcome = (url: string) => { const value = outcomes[url]; return Array.isArray(value) ? value.shift() : value }
  const service: ArtifactService = {
    acquire: vi.fn(async (url: string) => {
      calls.push(`acquire ${url}`)
      const result = outcome(url)
      if (!result || typeof result === 'string') throw Object.assign(new Error('Artifact unavailable'), { reason: result ?? 'http_404' })
      return { ...result }
    }),
    page: vi.fn(async (id: string, page: number) => { calls.push(`page ${id} ${page}`); return { bytes: Buffer.from('89504e47', 'hex'), mime: 'image/png' as const } }),
    acquireLocal: vi.fn(), cleanup: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  }
  return { service, calls }
}
function events(body: Buffer) {
  return body.toString().split('\r\n').filter(line => !/^[0-9a-f]+$/.test(line)).join('\n').split('\n\n').filter(Boolean).map(block => {
    const [event, data] = block.split('\n'); return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) }
  })
}
// What the browser will accept as the final answer: the text deltas after the last reset.
function finalText(stream: Array<{ event: string; data: { delta?: string } }>) {
  const last = stream.map(({ event }) => event).lastIndexOf('reset')
  return stream.slice(last + 1).filter(({ event }) => event === 'text').map(({ data }) => data.delta).join('')
}
async function send(options: Parameters<typeof createApp>[0], text = request_) {
  return events((await request(createApp(options)).post('/api/hermes/chat/stream').send({ text })).body)
}

it('recovers from a dead first link: one bounded retry, one verified artifact, and the truthful answer', async () => {
  const { fetch, bodies } = hermes(dead, `Here is the DEF CON 34 paper: ${good}`)
  const { service, calls } = artifacts({ [dead]: 'http_404', [good]: paper })
  const log = vi.fn()
  const stream = await send({ apiKey: 'key', fetch, artifactService: service, log })
  const kinds = stream.map(({ event }) => event)
  expect(stream.filter(({ event }) => event === 'artifact')).toEqual([{ event: 'artifact', data: shown }])
  expect(stream.find(({ event }) => event === 'answer')).toEqual({ event: 'answer', data: { text: `Here is the DEF CON 34 paper: ${good}` } })
  expect(finalText(stream)).toBe(`Here is the DEF CON 34 paper: ${good}`)
  expect(kinds.indexOf('reset')).toBeGreaterThan(kinds.indexOf('text')); expect(kinds.indexOf('reset')).toBeLessThan(kinds.indexOf('artifact'))
  expect(kinds.slice(-3)).toEqual(['artifact', 'answer', 'done']); expect(kinds).not.toContain('error')
  expect(calls).toEqual([`acquire ${dead}`, `acquire ${good}`, `page ${paper.id} 1`])
  // The retry asks Hermes, on the same conversation, for a different direct source and says why the first failed.
  expect(bodies).toHaveLength(2)
  expect(bodies[1].conversation).toBe(bodies[0].conversation); expect(bodies[1].instructions).toBe(bodies[0].instructions)
  expect(bodies[1].input).toContain(dead); expect(bodies[1].input).toContain('HTTP 404'); expect(bodies[1].input).toMatch(/different direct public HTTPS URL/); expect(bodies[1].input).toMatch(/publisher's current official copy/)
  const logged = log.mock.calls.map(([line]) => String(line)).join('\n')
  expect(logged).toContain('media.defcon.org'); expect(logged).toContain('http_404')
})

it('says it errored out, with no artifact, when every bounded candidate and retry fails', async () => {
  const urls = [1, 2, 3].map(n => `https://papers.example.com/dead-${n}.pdf?token=SECRET${n}`)
  const { fetch, bodies } = hermes(`Here it is: ${urls[0]}`, `Try this: ${urls[1]}`, `Here: ${urls[2]}`)
  const { service, calls } = artifacts({})
  const log = vi.fn()
  const stream = await send({ apiKey: 'key', fetch, artifactService: service, log })
  expect(stream.map(({ event }) => event)).not.toContain('artifact'); expect(stream.map(({ event }) => event)).not.toContain('error')
  expect(stream.slice(-2)).toEqual([{ event: 'answer', data: { text: failure } }, { event: 'done', data: {} }])
  expect(finalText(stream)).toBe(failure)
  expect(bodies).toHaveLength(3); expect(calls).toEqual(urls.map(url => `acquire ${url}`))
  const logged = log.mock.calls.map(([line]) => String(line)).join('\n')
  expect(logged).toContain('papers.example.com'); expect(logged).not.toContain('SECRET')
})

it('treats a retry that offers no file as the same failure, without asking again', async () => {
  const { fetch, bodies } = hermes(`Here it is: ${dead}`, 'I could not find another copy, sorry.')
  const stream = await send({ apiKey: 'key', fetch, artifactService: artifacts({}).service })
  expect(stream.slice(-2)).toEqual([{ event: 'answer', data: { text: failure } }, { event: 'done', data: {} }])
  expect(bodies).toHaveLength(2)
})

it('acquires a valid first link once and shows it with the completed answer', async () => {
  const answer = `Here is the paper: ${good}`
  const { fetch, bodies } = hermes(answer)
  const { service, calls } = artifacts({ [good]: paper })
  const stream = await send({ apiKey: 'key', fetch, artifactService: service })
  expect(stream).toEqual([
    { event: 'text', data: { delta: answer } }, { event: 'working', data: {} },
    { event: 'artifact', data: shown }, { event: 'answer', data: { text: answer } }, { event: 'done', data: {} },
  ])
  expect(calls).toEqual([`acquire ${good}`, `page ${paper.id} 1`]); expect(bodies).toHaveLength(1)
})

it('waits out a busy artifact cache instead of calling a good link dead', async () => {
  const { fetch, bodies } = hermes(good)
  const { service, calls } = artifacts({ [good]: ['busy', paper] })
  const stream = await send({ apiKey: 'key', fetch, artifactService: service })
  expect(stream.filter(({ event }) => event === 'artifact')).toEqual([{ event: 'artifact', data: shown }])
  expect(calls).toEqual([`acquire ${good}`, `acquire ${good}`, `page ${paper.id} 1`]); expect(bodies).toHaveLength(1)
})

it('streams ordinary replies exactly as before and never acquires anything', async () => {
  for (const answer of ['Hello there.', 'See https://gainsec.com/2026/08/09/bird-hunting-season-at-def-con-34/ for details.']) {
    const { service } = artifacts({})
    const stream = await send({ apiKey: 'key', fetch: hermes(answer).fetch, artifactService: service }, 'Hi')
    expect(stream).toEqual([{ event: 'text', data: { delta: answer } }, { event: 'answer', data: { text: answer } }, { event: 'done', data: {} }])
    expect(service.acquire).not.toHaveBeenCalled()
  }
})

it('fails the artifact handoff truthfully when recovery outlives its time budget', async () => {
  const { service } = artifacts({})
  let calls = 0
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (++calls === 1) return reply(dead)
    const signal = init!.signal!
    return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }) } }), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const stream = await send({ apiKey: 'key', fetch, artifactService: service, artifactTimeoutMs: 50 })
  expect(stream.slice(-2)).toEqual([{ event: 'answer', data: { text: failure } }, { event: 'done', data: {} }])
  expect(stream.map(({ event }) => event)).not.toContain('artifact')
})
