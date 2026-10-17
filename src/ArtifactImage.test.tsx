import { afterEach, expect, it, vi } from 'vitest'
import type { Texture } from 'three'
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, dependency: '', effects: [] as Array<() => (() => void)>, cleanup: undefined as (() => void) | undefined }))
const load = vi.hoisted(() => vi.fn())
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.values)) hooks.values[index] = initial
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next }]
  },
  useEffect(effect: () => (() => void), dependencies: string[]) {
    if (hooks.dependency !== dependencies[0]) { hooks.dependency = dependencies[0]; hooks.effects.push(effect) }
  },
}))
vi.mock('@react-three/drei', () => ({ Text: () => null }))
vi.mock('./artifactTexture', () => ({ loadArtifactTexture: load }))
import { ArtifactImage } from './ArtifactPanel'
const view = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 3, sourceUrl: 'https://example.com/a.pdf', page: 2 }
function render(page: number, base = view) {
  hooks.cursor = 0
  const tree = ArtifactImage({ view: { ...base, page } })
  for (const effect of hooks.effects.splice(0)) { hooks.cleanup?.(); hooks.cleanup = effect() }
  return tree
}
afterEach(() => hooks.cleanup?.())
it('recovers after a failed page by navigating away and successfully retrying it', async () => {
  const texture = () => ({ image: { width: 800, height: 1200 }, dispose: vi.fn() }) as unknown as Texture
  load.mockRejectedValueOnce(new Error('Page failed')).mockResolvedValueOnce(texture()).mockResolvedValueOnce(texture())
  render(2); await vi.waitFor(() => expect(render(2).props.children).toContain('Page unavailable'))
  render(1); await vi.waitFor(() => expect(render(1).type).toBe('mesh'))
  render(2); await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3))
  await vi.waitFor(() => expect(render(2).type).toBe('mesh'))
})
// The tallest-page fit is measured on the rendered panel in ArtifactPanel.test.tsx: the panel's grab handle needs
// a real R3F root, which this file's stand-in React hooks cannot host.
