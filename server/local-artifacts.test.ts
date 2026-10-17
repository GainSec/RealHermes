import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArtifactService } from './artifacts.ts'
import type { ArtifactOptions } from './artifacts.ts'
import { parseLocalArtifactRequest, parseLocalArtifactRoots } from './local-artifacts.ts'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex')
const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffd9', 'hex')
const webp = Buffer.from('5249464612000000574542505650384c050000002f0000000000', 'hex')
const pdf = Buffer.from('%PDF-1.7\n test PDF')
const target = 'Can you find an image of number one on my file system and show me?'
// Fixtures use a fictional mascot, "Numbix", whose name is a near spelling of "number" (two letters apart).
const cleaners: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleaners.splice(0)) await clean() })
async function directory(prefix: string) {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)))
  cleaners.push(() => fs.rm(path, { recursive: true, force: true }))
  return path
}
// Approved root laid out from relative path → bytes.
async function root(files: Record<string, Buffer>) {
  const path = await directory('rh-local-root-')
  for (const [name, bytes] of Object.entries(files)) { await fs.mkdir(join(path, name, '..'), { recursive: true }); await fs.writeFile(join(path, name), bytes) }
  return path
}
// Where startup found Poppler (see poppler.ts); local PDFs use the same page counter as web PDFs.
const poppler = { pdfinfo: '/opt/poppler/bin/pdfinfo', pdftoppm: '/opt/poppler/bin/pdftoppm' }
async function service(roots: string[], overrides: ArtifactOptions = {}) {
  const value = createArtifactService({ tmpdir: await directory('rh-local-cache-'), localRoots: roots, run: async () => 'Pages: 2\n', poppler, ...overrides })
  cleaners.push(() => value.dispose())
  return value
}
const find = async (roots: string[], text: string, overrides: ArtifactOptions = {}) => (await service(roots, overrides)).acquireLocal!(parseLocalArtifactRequest(text)!)

it.each([
  [target, { terms: ['number', 'one'], kinds: ['image'] }],
  ['Show me the picture of Numbix One from my computer.', { terms: ['numbix', 'one'], kinds: ['image'] }],
  ['Hey 2x4, find a photo of number 1 on my Mac', { terms: ['number', '1'], kinds: ['image'] }],
  ['Do I have any pictures of Numbix One on my computer?', { terms: ['numbix', 'one'], kinds: ['image'] }],
  ['Pull up my local screenshot of the login page', { terms: ['login', 'page'], kinds: ['image'] }],
  ['Open the invoice PDF on my computer', { terms: ['invoice'], kinds: ['pdf'] }],
  ['Show me the file called budget on my computer', { terms: ['budget'], kinds: ['image', 'pdf'] }],
  ['Can you show me an image from my file system?', { terms: [], kinds: ['image'] }],
  ['Show me ../../etc/passwd as an image from my computer', { terms: ['etc', 'passwd'], kinds: ['image'] }],
])('reads a natural local display request %j', (text, request) => {
  expect(parseLocalArtifactRequest(text)).toEqual(request)
})
it.each([
  'Find an image of a cat and show me', 'Can you find a picture of the local library?', "What's on my computer screen?",
  'Find large files on my computer', 'How much space is left on my disk?', 'What am I looking at?', 'Find me the data sheet', 'Hi',
])('leaves other requests to Hermes: %j', text => { expect(parseLocalArtifactRequest(text)).toBeUndefined() })

it('finds the Number One image by natural wording among decoys, and serves it only by opaque ID', async () => {
  const path = await root({
    'Characters/Numbix One.png': png, 'Characters/Numbix_2x4 (1).webp': webp, 'Characters/Numbix_2x4.webp': webp,
    'phone_number.png': png, 'number-two.jpg': jpeg, 'Image Feb 27, 2026, 10_30_35 PM.png': png, 'Numbix One notes.pdf': pdf,
  })
  const result = await find([path], target)
  expect(result).toEqual({ status: 'found', matches: 1, metadata: { id: expect.stringMatching(/^[a-f0-9]{32}$/), kind: 'image', title: 'Numbix One.png', pageCount: 1 } })
  if (result.status !== 'found') throw new Error('unreachable')
  expect(JSON.stringify(result)).not.toContain(path)
})
it('matches folder names, camel case, digits and spelling variants, preferring the closest name', async () => {
  const path = await root({ 'Numbix 1/front.jpg': jpeg, 'NumbixOne.webp': webp, 'numbix1 and friends at the beach.png': png })
  expect(await find([path], 'Show me the picture of Numbix One from my computer')).toMatchObject({ status: 'found', matches: 3, metadata: { title: 'NumbixOne.webp' } })
  expect(await find([path], 'find a photo of number 1 on my mac')).toMatchObject({ status: 'found', metadata: { title: 'NumbixOne.webp' } })
  expect(await find([await root({ 'Numbix 1/front.jpg': jpeg })], target)).toMatchObject({ status: 'found', metadata: { title: 'front.jpg' } })
})
it('answers no match quickly instead of guessing from a partial name match', async () => {
  // A realistic art tree with near names (Numbix 2x4) and generated images, but no Number One image.
  const path = await root({ 'art/public/models/mascots/Numbix_2x4 (1).webp': webp, 'art/public/models/mascots/Image Feb 27, 2026, 10_30_16 PM.png': png })
  expect(await find([path], target)).toEqual({ status: 'none' })
})
it('opens PDFs through the configured page counter and searches every approved root deterministically', async () => {
  const first = await root({ 'misc/readme.png': png }); const second = await root({ 'Invoice 2026.pdf': pdf })
  const run = vi.fn(async (_executable: string, _args: string[]) => 'Pages: 2\n')
  const result = await find([first, second], 'Open the invoice PDF on my computer', { run })
  expect(result).toMatchObject({ status: 'found', metadata: { kind: 'pdf', title: 'Invoice 2026.pdf', pageCount: 2 } })
  expect(run.mock.calls[0][0]).toBe('/opt/poppler/bin/pdfinfo')
})
it('serves the chosen file’s bytes from the private cache under its opaque ID', async () => {
  const path = await root({ 'Numbix One.png': png })
  const value = await service([path])
  const result = await value.acquireLocal!(parseLocalArtifactRequest(target)!)
  if (result.status !== 'found') throw new Error('not found')
  await fs.writeFile(join(path, 'Numbix One.png'), jpeg)
  expect(await value.page(result.metadata.id, 1)).toEqual({ bytes: png, mime: 'image/png' })
})
it('reports unconfigured local search without touching the filesystem', async () => {
  const value = createArtifactService({ tmpdir: await directory('rh-local-cache-') }); cleaners.push(() => value.dispose())
  expect(await value.acquireLocal!(parseLocalArtifactRequest(target)!)).toEqual({ status: 'unconfigured' })
})

it('never follows symlinked files or directories out of an approved root', async () => {
  const outside = await root({ 'Numbix One.png': png, 'secret/Numbix One.png': png })
  const path = await root({ 'readme.png': png })
  await fs.symlink(join(outside, 'Numbix One.png'), join(path, 'Numbix One.png'))
  await fs.symlink(join(outside, 'secret'), join(path, 'Numbix One'))
  expect(await find([path], target)).toEqual({ status: 'none' })
})
it('skips hidden, system and vendor folders, unsupported types and copies outside the kind asked for', async () => {
  const path = await root({
    '.private/Numbix One.png': png, '.Numbix One.png': png, 'node_modules/pkg/Numbix One.png': png, 'Library/Caches/Numbix One.png': png,
    'dist/Numbix One.png': png, 'Photos.photoslibrary/Numbix One.png': png, 'Numbix One.gif': png, 'Numbix One.svg': png, 'Numbix One.png.txt': png, 'Numbix One.pdf': pdf,
  })
  expect(await find([path], target)).toEqual({ status: 'none' })
})
it.each([
  ['wrong magic', pdf, {}],
  ['empty', Buffer.alloc(0), {}],
  ['oversized', png, { maxDownloadBytes: 16 }],
  ['huge dimensions', (() => { const huge = Buffer.from(png); huge.writeUInt32BE(99_999, 16); return huge })(), {}],
] as const)('refuses a %s match without exposing its path', async (_kind, bytes, overrides) => {
  const path = await root({ 'Numbix One.png': bytes })
  const result = await find([path], target, overrides)
  expect(result).toEqual({ status: 'unavailable', title: 'Numbix One.png' })
})
it('refuses a match swapped for a symlink after the scan (TOCTOU)', async () => {
  const outside = await root({ 'secret.png': png })
  const path = await root({ 'Numbix One.png': png })
  const open = vi.fn(async (...args: Parameters<typeof fs.open>) => {
    await fs.rm(join(path, 'Numbix One.png')); await fs.symlink(join(outside, 'secret.png'), join(path, 'Numbix One.png'))
    return fs.open(...args)
  })
  expect(await find([path], target, { fs: { ...fs, open } })).toEqual({ status: 'unavailable', title: 'Numbix One.png' })
  expect(open).toHaveBeenCalledOnce()
})
it('refuses a match whose parent folder is swapped for a symlink out of the root (TOCTOU)', async () => {
  const outside = await root({ 'Numbix One/front.png': png })
  const path = await root({ 'Numbix One/front.png': png })
  const open = vi.fn(async (...args: Parameters<typeof fs.open>) => {
    await fs.rename(join(path, 'Numbix One'), join(path, 'moved')); await fs.symlink(join(outside, 'Numbix One'), join(path, 'Numbix One'))
    return fs.open(...args)
  })
  expect(await find([path], target, { fs: { ...fs, open } })).toEqual({ status: 'unavailable', title: 'front.png' })
})
it('bounds the scan by entries, folders and depth', async () => {
  const files: Record<string, Buffer> = { 'a/b/c/d/e/f/g/h/i/Numbix One.png': png }
  for (let index = 0; index < 30; index++) files[`bulk/${String(index).padStart(2, '0')}.png`] = png
  const path = await root(files)
  // Nine folders deep is past the default depth bound.
  expect(await find([path], target)).toEqual({ status: 'none' })
  const opendir = vi.fn(fs.opendir)
  await find([path], target, { fs: { ...fs, opendir }, localScan: { maxDirectories: 3 } })
  expect(opendir).toHaveBeenCalledTimes(3)
  // Twelve files fill a ten-entry budget before the folder holding the match is read.
  expect(await find([await root({ 'zz/Numbix One.png': png, ...Object.fromEntries(Array.from({ length: 12 }, (_value, index) => [`a${index}.png`, png])) })], target, { localScan: { maxEntries: 10 } })).toEqual({ status: 'none' })
})

it.each([
  [undefined, undefined], ['', undefined], [' : ', undefined],
  ['/home/example/Pictures/mascots', ['/home/example/Pictures/mascots']],
  ['/Volumes/Shared/Art:/home/example/Pictures/', ['/Volumes/Shared/Art', '/home/example/Pictures']],
])('reads approved roots %j', (value, roots) => { expect(parseLocalArtifactRoots(value, '/home/example')).toEqual(roots) })
it.each(['relative/folder', '/', '/home', '/home/example', '/home/example/.hermes', '/home/example/Projects/../.ssh', '/home/example/a\u0000b', Array.from({ length: 9 }, (_value, index) => `/Volumes/Shared/Art/${index}`).join(':')])('refuses broad, hidden or malformed root list %j', value => {
  expect(() => parseLocalArtifactRoots(value, '/home/example')).toThrow('Invalid REALHERMES_LOCAL_ARTIFACT_ROOTS')
})
it('prefers an original over its numbered copies', async () => {
  const path = await root({ 'Numbix_2x4 (1).webp': webp, 'Numbix_2x4 (2).webp': webp, 'Numbix_2x4.webp': webp })
  expect(await find([path], 'Show me the Numbix 2x4 picture from my computer')).toMatchObject({ status: 'found', matches: 3, metadata: { title: 'Numbix_2x4.webp' } })
})
