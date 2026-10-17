import express from 'express'
import type { ArtifactService } from './artifacts.ts'
export function artifactRoutes(service: ArtifactService) {
  const router = express.Router()
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
    })
    next()
  })
  router.post('/', (req, res, next) => {
    if (req.get('sec-fetch-site') === 'cross-site') { res.status(403).json({ error: 'Artifact unavailable' }); return }
    if (!req.is('application/json')) { res.status(400).json({ error: 'Invalid artifact request' }); return }
    next()
  }, express.json({ limit: '8kb' }), async (req, res) => {
    if (!req.body || typeof req.body.url !== 'string' || req.body.url.length > 4096 || Object.keys(req.body).length !== 1) { res.status(400).json({ error: 'Invalid artifact request' }); return }
    try {
      const { id, kind, title, pageCount, sourceUrl } = await service.acquire(req.body.url)
      res.json({ id, kind, title, pageCount, sourceUrl })
    } catch { res.status(502).json({ error: 'Artifact unavailable' }) }
  })
  router.get('/:id/pages/:page', async (req, res) => {
    const { id, page } = req.params
    if (!/^[a-f0-9]{32}$/.test(id) || !/^[1-9]\d{0,2}$/.test(page) || Number(page) > 500) { res.status(404).json({ error: 'Artifact unavailable' }); return }
    try {
      const result = await service.page(id, Number(page))
      res.set('Content-Type', result.mime).send(result.bytes)
    } catch { res.status(404).json({ error: 'Artifact unavailable' }) }
  })
  return router
}
