import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { createArtifactService } from './artifacts.ts'
import request from './test-request.ts'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const target = 'Can you find an image of number one on my file system and show me?'
const cleaners: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleaners.splice(0)) await clean() })
async function directory(prefix: string) {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)))
  cleaners.push(() => fs.rm(path, { recursive: true, force: true }))
  return path
}
async function fixture(localRoots?: string[]) {
  const service = createArtifactService({ tmpdir: await directory('rh-local-chat-cache-'), localRoots })
  cleaners.push(() => service.dispose())
  const upstream = vi.fn(async () => Response.json({ output: [] }))
  return { app: createApp({ apiKey: 'key', artifactService: service, fetch: upstream }), upstream }
}
async function approvedFolder() {
  const root = await directory('rh-local-chat-root-')
  await fs.mkdir(join(root, 'Mascots')); await fs.writeFile(join(root, 'Mascots', 'Numbix One.png'), png); await fs.writeFile(join(root, 'Mascots', 'Numbix_2x4 (1).png'), png)
  return root
}
function events(body: Buffer) {
  return body.toString().split('\r\n').filter(line => !/^[0-9a-f]+$/.test(line)).join('\n').split('\n\n').filter(Boolean).map(block => {
    const [event, data] = block.split('\n'); return { event: event.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) }
  })
}

it('answers the natural local request itself, with only opaque metadata, and never asks Hermes to search', async () => {
  const root = await approvedFolder(); const { app, upstream } = await fixture([root])
  const res = await request(app).post('/api/hermes/chat/stream').send({ text: target, include_vision: true })
  const answer = 'Here’s “Numbix One” from your approved folders.'
  const stream = events(res.body)
  expect(stream).toEqual([
    { event: 'text', data: { delta: answer } },
    { event: 'artifact', data: { id: expect.stringMatching(/^[a-f0-9]{32}$/), kind: 'image', title: 'Numbix One.png', pageCount: 1 } },
    { event: 'answer', data: { text: answer } }, { event: 'done', data: {} },
  ])
  expect(upstream).not.toHaveBeenCalled()
  for (const leaked of [root, 'Mascots', 'file://', tmpdir()]) expect(res.body.toString()).not.toContain(leaked)
  const page = await request(app).get(`/api/artifacts/${stream[1].data.id}/pages/1`)
  expect(page.headers['content-type']).toBe('image/png'); expect(page.body).toEqual(png)
})
it.each([
  ['no match', async (): Promise<string[] | undefined> => [await directory('rh-local-chat-empty-')], 'I couldn’t find an image matching “number one” in your approved folders.'],
  ['unconfigured', async (): Promise<string[] | undefined> => undefined, 'Local file search isn’t set up yet. Add approved folders in the RealHermes server settings.'],
] as const)('answers quickly on %s without an artifact or a Hermes search', async (_case, roots, answer) => {
  const { app, upstream } = await fixture(await roots())
  expect(events((await request(app).post('/api/hermes/chat/stream').send({ text: target })).body)).toEqual([
    { event: 'text', data: { delta: answer } }, { event: 'answer', data: { text: answer } }, { event: 'done', data: {} },
  ])
  expect(upstream).not.toHaveBeenCalled()
})
it('answers a busy or failed local search with a sanitized retry message', async () => {
  const service = { acquire: vi.fn(), acquireLocal: vi.fn(async () => { throw new Error('/private/secret busy') }), page: vi.fn(), cleanup: vi.fn(), dispose: vi.fn() }
  const upstream = vi.fn()
  const wire = (await request(createApp({ apiKey: 'key', artifactService: service, fetch: upstream })).post('/api/hermes/chat/stream').send({ text: target })).body.toString()
  expect(wire).toContain('I couldn’t search your approved folders just now. Please ask again.'); expect(wire).not.toContain('secret'); expect(upstream).not.toHaveBeenCalled()
})
it('still sends web image requests to Hermes on the shared conversation', async () => {
  const { app, upstream } = await fixture([await approvedFolder()])
  await request(app).post('/api/hermes/chat/stream').send({ text: 'Find an image of a cat and show me' })
  expect(upstream).toHaveBeenCalledOnce()
  expect(JSON.parse(String((upstream.mock.calls[0] as unknown[])[1] && ((upstream.mock.calls[0] as unknown[])[1] as RequestInit).body)).conversation).toBe('realhermes-steam-frame-v3')
})
it('gives JSON chat the same local answer and opaque artifact', async () => {
  const { app, upstream } = await fixture([await approvedFolder()])
  const res = await request(app).post('/api/hermes/chat').send({ text: target })
  expect(res.body).toEqual({ text: 'Here’s “Numbix One” from your approved folders.', artifact: { id: expect.stringMatching(/^[a-f0-9]{32}$/), kind: 'image', title: 'Numbix One.png', pageCount: 1 } })
  expect(upstream).not.toHaveBeenCalled()
})
it('serves the natural request from the production app configured only through the environment', async () => {
  const { relayOptionsFromEnv } = await import('./config.ts')
  const { createProductionApp } = await import('./production.ts')
  const dist = await directory('rh-local-chat-dist-'); await fs.writeFile(join(dist, 'index.html'), '<html></html>')
  const root = await approvedFolder(); const upstream = vi.fn()
  const options = relayOptionsFromEnv({ HERMES_API_KEY: 'key', REALHERMES_LOCAL_ARTIFACT_ROOTS: root })
  const { app, dispose } = createProductionApp({ ...options, artifactOptions: { ...options.artifactOptions, tmpdir: await directory('rh-local-chat-cache-') }, distPath: dist, fetch: upstream })
  cleaners.push(dispose)
  const stream = events((await request(app).post('/api/hermes/chat/stream').send({ text: target })).body)
  expect(stream[1]).toEqual({ event: 'artifact', data: { id: expect.stringMatching(/^[a-f0-9]{32}$/), kind: 'image', title: 'Numbix One.png', pageCount: 1 } })
  expect(upstream).not.toHaveBeenCalled()
})
