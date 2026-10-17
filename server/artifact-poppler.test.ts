import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createArtifactService } from './artifacts.ts'
import { findPoppler } from './poppler.ts'

// The same discovery the server uses at startup: REALHERMES_POPPLER_DIR, else the first PATH directory with both tools.
const poppler = findPoppler(process.env)

// Small deterministic two-page PDF. Offsets/xref are generated from ASCII bytes.
function twoPagePdf() {
  const stream = (label: string) => {
    const data = `BT /F1 24 Tf 40 400 Td (${label}) Tj ET\n`
    return `<< /Length ${Buffer.byteLength(data)} >>\nstream\n${data}endstream`
  }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    stream('RealHermes page one'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream('RealHermes page two'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let text = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = Buffer.byteLength(text)
  text += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(text)
}
it.skipIf(!poppler)('counts and rasters real PDF pages with the Poppler executables installed on this machine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rh-poppler-test-'))
  const service = createArtifactService({ tmpdir: root, poppler, resolve: async () => [{ address: '93.184.216.34', family: 4 }], fetch: async () => new Response(twoPagePdf(), { headers: { 'content-type': 'application/pdf' } }) })
  try {
    const item = await service.acquire('https://example.com/two-pages.pdf')
    expect(item.pageCount).toBe(2)
    const first = await service.page(item.id, 1); const second = await service.page(item.id, 2)
    expect(first.mime).toBe('image/png'); expect(first.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(first.bytes.readUInt32BE(16)).toBe(1280); expect(first.bytes.readUInt32BE(20)).toBe(1600)
    expect(first.bytes.equals(second.bytes)).toBe(false)
    await expect(service.page(item.id, 3)).rejects.toThrow(/^Artifact unavailable$/)
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }) }
})
