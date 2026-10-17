import { expect, it, vi } from 'vitest'
import request from './test-request.ts'
import { createApp } from './app.ts'
import type { ArtifactPage } from './artifacts.ts'
const id = 'a'.repeat(32)
const metadata = { id, kind: 'pdf' as const, title: 'Guide', pageCount: 2, sourceUrl: 'https://example.com/final.pdf' }
function fixture() {
  const service = { acquire: vi.fn(async () => ({ ...metadata, localPath: '/private/secret' })), page: vi.fn(async (): Promise<ArtifactPage> => ({ bytes: Buffer.from('image bytes'), mime: 'image/png' as const })), cleanup: async () => {}, dispose: async () => {} }
  return { service, app: createApp({ artifactService: service }) }
}
it('acquires through one narrow route and returns only public metadata', async () => {
  const { app, service } = fixture()
  const response = await request(app).post('/api/artifacts').send({ url: 'https://example.com/a.pdf' })
  expect(response.status).toBe(200); expect(response.body).toEqual(metadata)
  expect(service.acquire).toHaveBeenCalledWith('https://example.com/a.pdf')
  expect(response.headers['cache-control']).toBe('no-store')
})
it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('serves only opaque same-origin page URLs with exact %s and security headers', async mime => {
  const { app, service } = fixture(); service.page.mockResolvedValueOnce({ bytes: Buffer.from('image bytes'), mime })
  const response = await request(app).get(`/api/artifacts/${id}/pages/2`)
  expect(response.status).toBe(200); expect(response.body).toEqual(Buffer.from('image bytes'))
  expect(service.page).toHaveBeenCalledWith(id, 2)
  expect(response.headers['content-type']).toBe(mime)
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
  expect(response.headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(response.headers['referrer-policy']).toBe('no-referrer')
})
it('rejects malformed request shapes and cross-site acquisition before calling the service', async () => {
  const { app, service } = fixture()
  for (const body of [{}, { url: 1 }, { url: 'x', path: '/private' }, { url: 'x'.repeat(4097) }]) {
    expect((await request(app).post('/api/artifacts').send(body)).status).toBe(400)
  }
  expect((await request(app).post('/api/artifacts').set('sec-fetch-site', 'cross-site').send({ url: 'https://example.com/a.pdf' })).status).toBe(403)
  expect(service.acquire).not.toHaveBeenCalled()
})
it.each([`/api/artifacts/not-an-id/pages/1`, `/api/artifacts/${id}/pages/0`, `/api/artifacts/${id}/pages/501`, `/api/artifacts/${id}/pages/1.5`, `/api/artifacts/${id}/pages/01`, '/api/artifacts/file?path=/private/secret'])('rejects unsupported page/file routes %s', async path => {
  const { app, service } = fixture()
  expect((await request(app).get(path)).status).toBe(404)
  expect(service.page).not.toHaveBeenCalled()
})
it('sanitizes acquisition/raster errors and does not proxy source URLs or expose local paths', async () => {
  const { app, service } = fixture()
  service.acquire.mockRejectedValueOnce(new Error('/private/SECRET token'))
  expect((await request(app).post('/api/artifacts').send({ url: 'https://example.com/a.pdf' })).body).toEqual({ error: 'Artifact unavailable' })
  service.page.mockRejectedValueOnce(new Error('/private/SECRET token'))
  const response = await request(app).get(`/api/artifacts/${id}/pages/1`)
  expect(response.status).toBe(404); expect(response.body).toEqual({ error: 'Artifact unavailable' })
})
