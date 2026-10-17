import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
const play = vi.hoisted(() => vi.fn())
const gltf = vi.hoisted(() => vi.fn(() => ({ scene: { clone: () => ({}) }, animations: [] })))
vi.mock('./model', () => ({ groundOffset: () => 1, prepareAvatarScene: (scene: unknown) => scene }))
// Server markup runs no frame loop, so frame callbacks (such as the controller grab's) never fire.
vi.mock('@react-three/fiber', () => ({ useThree: (selector: (state: any) => unknown) => selector({ gl: { xr: { getReferenceSpace: () => null } } }), useFrame: () => {}, Canvas: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('@react-three/drei', () => ({ useGLTF: gltf, useAnimations: () => ({ actions: { Idle: { reset: () => ({ play }) } }, names: ['Idle'] }), OrbitControls: () => null, Html: () => null, Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@react-three/xr', () => ({ createXRStore: () => ({}), XR: ({ children }: { children: React.ReactNode }) => <>{children}</>, useXRInputSourceEvent: () => undefined, noEvents: () => ({ enabled: false, priority: 0 }), PointerEvents: () => null }))
// Server markup has no R3F root for the grab handle's hooks; the handle itself is exercised in artifactGrab.test.tsx.
vi.mock('@react-three/handle', () => ({ Handle: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
import Simulator from './Simulator'
it('loads the approved model in the simulator', () => {
  renderToStaticMarkup(<Simulator state="idle" />)
  expect(gltf).toHaveBeenCalledWith('/models/realhermes-idle.glb')
})

it('preserves the existing character height and distance placement', () => {
  const html = renderToStaticMarkup(<Simulator state="working" placement={{ height: 0.5, distance: 3 }} />)
  expect(html).toContain('position="0,0.5,-3"')
  expect(html).toContain('position="0,1,0"')
  expect(html).toContain('#efc477')
  expect(html).toContain('WORKING')
})

const artifact = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Reference PDF', pageCount: 2, page: 1, sourceUrl: 'https://example.com/a.pdf' }
const opened = { home: [1.05, 1.2, -2.6] as [number, number, number], x: 0, y: 0, z: 0, scale: 1 }
it('renders an artifact inside the existing canvas while preserving the avatar and controller PTT', () => {
  const html = renderToStaticMarkup(<Simulator state="idle" artifact={artifact} artifactPlacement={opened} onArtifactPage={() => {}} onArtifactClose={() => {}} onArtifactAdjust={() => {}} onArtifactPlace={() => {}} onPushToTalkStart={() => {}} onPushToTalkStop={() => {}} />)
  expect(html).toContain('Reference PDF'); expect(html).toContain('1 / 2'); expect(html).toContain('Close'); expect(html).toContain('Reset')
  expect(gltf).toHaveBeenCalledWith('/models/realhermes-idle.glb')
})
it('places the artifact from its own placement, never from the avatar placement', () => {
  const html = renderToStaticMarkup(<Simulator state="idle" placement={{ height: 0.5, distance: 3 }} artifact={artifact} artifactPlacement={{ ...opened, x: -0.4, scale: 1.25 }} onArtifactPage={() => {}} onArtifactClose={() => {}} onArtifactAdjust={() => {}} onArtifactPlace={() => {}} />)
  expect(html).toContain('position="0.65,1.2,-2.6" scale="1.25"'); expect(html).not.toContain('position="1.05,1.7,-3.6"')
  expect(html).toContain('position="0,0.5,-3"')
})
