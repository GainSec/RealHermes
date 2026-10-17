import { expect, it, vi } from 'vitest'
import { extractArtifactUrls, changeArtifactPage, closeArtifact, artifactPageUrl, createArtifactViewer } from './artifact'
import { Conversation } from './conversation'

it('extracts only explicit HTTPS PDF/common-image links, preserving order and deduplicating Markdown URLs', () => {
  expect(extractArtifactUrls('Read [PDF](https://example.com/a.PDF?download=1), ![photo](https://example.com/p.png). https://example.com/a.PDF?download=1 https://example.com/b.jpeg https://example.com/c.webp https://example.com/d.jpg https://example.com/page http://example.com/no.pdf')).toEqual([
    'https://example.com/a.PDF?download=1', 'https://example.com/p.png', 'https://example.com/b.jpeg', 'https://example.com/c.webp', 'https://example.com/d.jpg',
  ])
  expect(extractArtifactUrls('[x](https://user:pw@example.com/a.pdf) https://example.com:444/a.pdf https://[::1]/a.pdf https://example.com/a.svg https://example.com/get?file=a.pdf https://')).toEqual(['https://[::1]/a.pdf'])
})
it('bounds paging and closes the view', () => {
  const view = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 3, sourceUrl: 'https://example.com/a.pdf', page: 1 }
  expect(changeArtifactPage(view, -1)?.page).toBe(1)
  expect(changeArtifactPage(view, 1)?.page).toBe(2)
  expect(changeArtifactPage({ ...view, page: 3 }, 1)?.page).toBe(3)
  expect(changeArtifactPage(null, 1)).toBeNull(); expect(closeArtifact()).toBeNull()
  expect(artifactPageUrl({ ...view, page: 2 })).toBe(`/api/artifacts/${view.id}/pages/2`)
})
it('delivers only completed answers to the artifact callback without delaying or breaking TTS', async () => {
  const completed = vi.fn(() => { throw new Error('viewer unavailable') })
  const speak = vi.fn(async (_text, started) => { started() })
  const states = vi.fn()
  const conversation = new Conversation({ chat: async () => 'https://example.com/a.pdf', speak, transcribe: async () => '' }, states, completed)
  await expect(conversation.send('guide')).resolves.toBeUndefined()
  expect(completed).toHaveBeenCalledWith('https://example.com/a.pdf'); expect(speak).toHaveBeenCalledWith("Here's the PDF.", expect.any(Function))
  expect(conversation.messages.at(-1)?.content).toBe('https://example.com/a.pdf'); expect(states).toHaveBeenLastCalledWith('idle')
})

it('extracts adjacent Markdown links, reference destinations and filenames containing balanced parentheses', () => {
  expect(extractArtifactUrls('[a](https://example.com/a.pdf)[b](https://example.com/b.png)\n[ref]: <https://example.com/c.webp>\n[guide](https://example.com/guide(2026).pdf)')).toEqual(['https://example.com/a.pdf', 'https://example.com/b.png', 'https://example.com/c.webp', 'https://example.com/guide(2026).pdf'])
})
it('does not notify the artifact viewer for an incomplete/failed chat', async () => {
  const completed = vi.fn(); const speak = vi.fn()
  const conversation = new Conversation({ chat: async () => { throw new Error('Incomplete stream') }, speak, transcribe: async () => '' }, vi.fn(), completed)
  await expect(conversation.send('guide')).rejects.toThrow('Incomplete stream')
  expect(completed).not.toHaveBeenCalled(); expect(speak).not.toHaveBeenCalled()
})

it('preserves signed query punctuation and balanced parentheses inside explicit Markdown/angle URLs', () => {
  expect(extractArtifactUrls('[pdf](https://example.com/a.pdf?token=abc!) <https://example.com/b.pdf?token=(abc)>')).toEqual(['https://example.com/a.pdf?token=abc!', 'https://example.com/b.pdf?token=(abc)'])
})

const local = { id: 'b'.repeat(32), kind: 'image' as const, title: 'Numbix One.png', pageCount: 1 }
it('opens only a relay-verified artifact by opaque ID and never fetches links from the answer itself', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  try {
    const changed = vi.fn(); const notice = vi.fn()
    const viewer = createArtifactViewer(changed, notice)
    viewer.open('Here is the paper: https://example.com/dead.pdf')
    expect(changed).not.toHaveBeenCalled(); expect(notice).toHaveBeenLastCalledWith('')
    const paper = { id: 'c'.repeat(32), kind: 'pdf' as const, title: 'Bird Hunting Season.pdf', pageCount: 119 }
    viewer.open('Here is the paper: https://example.com/good.pdf', paper)
    expect(changed).toHaveBeenCalledExactlyOnceWith({ ...paper, page: 1 }); expect(notice).toHaveBeenLastCalledWith('')
    viewer.open('Here’s “Numbix One” from your approved folders.', local)
    expect(changed).toHaveBeenLastCalledWith({ ...local, page: 1 })
    viewer.dismiss(); expect(changed).toHaveBeenLastCalledWith(null)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
it('refuses unsafe local artifact metadata in the viewer', async () => {
  for (const change of [{ id: '../x' }, { pageCount: 0 }, { pageCount: 3 }, { kind: 'html' }, { path: '/private/Numbix One.png' }]) {
    const changed = vi.fn(); const notice = vi.fn()
    createArtifactViewer(changed, notice).open('Here.', { ...local, ...change } as typeof local)
    expect(changed).not.toHaveBeenCalled()
    expect(notice).toHaveBeenLastCalledWith('Artifact could not be opened. The answer is still available.')
  }
})
