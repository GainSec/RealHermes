import { expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createArtifactService } from './artifacts.ts'
import request from './test-request.ts'
// Opt-in live replay (network + Poppler): REALHERMES_LIVE_ARTIFACTS=1 npx vitest run server/artifact-live.test.ts
const live = process.env.REALHERMES_LIVE_ARTIFACTS === '1'
const dead = 'https://media.defcon.org/DEF%20CON%2034/DEF%20CON%2034%20presentations/DEF%20CON%2034%20presentations/DEF%20CON%2034%20-%20Jon%20Gaines%20-%20Bird%20Hunting%20Season%20The%20Final%20Flight%20-%20PDF%20v1.pdf'
const good = 'https://media.defcon.org/DEF%20CON%2034/DEF%20CON%2034%20presentations/DEF%20CON%2034%20-%20Jon%20Gaines%20-%20Bird%20Hunting%20Season%20The%20Final%20Flight%20-%20PDF%20v1.pdf'
const remediation = 'https://raw.githubusercontent.com/GainSec/anti-crime-ecosystem-research/main/remediationtestwhitepaper/GainSec_Whitepaper_AntiCrimeEcosystem-LPR-Remediation.pdf'
const longDocument = 'https://www.rfc-editor.org/rfc/rfc9110.pdf'
const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
const reply = (text: string) => new Response(sse('response.output_text.delta', { delta: text }) + sse('response.completed', {}), { headers: { 'Content-Type': 'text/event-stream' } })
function events(body: Buffer) {
  return body.toString().split('\r\n').filter(line => !/^[0-9a-f]+$/.test(line)).join('\n').split('\n\n').filter(Boolean).map(block => {
    const [event, data] = block.split('\n'); return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) }
  })
}
const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))

it.runIf(live)('replays the live DEF CON handoff: the exact dead link is HTTP 404, the corrected source is shown', async () => {
  const service = createArtifactService(); const lines: string[] = []
  try {
    await expect(service.acquire(dead)).rejects.toMatchObject({ reason: 'http_404' })
    const answers = [dead, `Here is the DEF CON 34 paper: ${good}`]; let call = 0
    const app = createApp({ apiKey: 'key', artifactService: service, log: line => lines.push(line), fetch: async () => reply(answers[call++]) })
    const stream = events((await request(app).post('/api/hermes/chat/stream').send({ text: 'Find the latest GainSec paper from DEF CON and show it to me.' })).body)
    const artifacts = stream.filter(({ event }) => event === 'artifact')
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].data).toMatchObject({ kind: 'pdf', title: 'DEF CON 34 - Jon Gaines - Bird Hunting Season The Final Flight - PDF v1.pdf' })
    expect(stream.slice(-2)).toEqual([{ event: 'answer', data: { text: `Here is the DEF CON 34 paper: ${good}` } }, { event: 'done', data: {} }])
    expect(lines.join('\n')).toContain('"reason":"http_404"')
    const page = await request(app).get(`/api/artifacts/${artifacts[0].data.id}/pages/1`)
    expect(page.headers['content-type']).toBe('image/png'); expect(isPng(page.body)).toBe(true)
  } finally { await service.dispose() }
}, 120_000)

it.runIf(live)('tells the truth live when the exact dead link is all Hermes can offer', async () => {
  const service = createArtifactService()
  try {
    const answers = [dead, 'I could not find another copy.']; let call = 0
    const app = createApp({ apiKey: 'key', artifactService: service, log: () => {}, fetch: async () => reply(answers[call++]) })
    const stream = events((await request(app).post('/api/hermes/chat/stream').send({ text: 'Find the latest GainSec paper from DEF CON and show it to me.' })).body)
    expect(stream.map(({ event }) => event)).not.toContain('artifact')
    expect(stream.slice(-2)).toEqual([{ event: 'answer', data: { text: 'I errored out while loading the artifact. Check the logs.' } }, { event: 'done', data: {} }])
  } finally { await service.dispose() }
}, 120_000)

it.runIf(live).each([
  ['the 119-page remediation paper', remediation, 119, 119],
  ['a longer standards document', longDocument, 120, 500],
])('acquires %s within the 500-page bound and renders page 1', async (_name, url, fewest, most) => {
  const service = createArtifactService()
  try {
    const metadata = await service.acquire(url)
    expect(metadata.kind).toBe('pdf'); expect(metadata.pageCount).toBeGreaterThanOrEqual(fewest); expect(metadata.pageCount).toBeLessThanOrEqual(most)
    const page = await service.page(metadata.id, 1)
    expect(page.mime).toBe('image/png'); expect(isPng(page.bytes)).toBe(true)
  } finally { await service.dispose() }
}, 120_000)
