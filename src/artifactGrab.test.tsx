import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { Mesh, Vector3 } from 'three'
import type { MeshBasicMaterial } from 'three'
import { noEvents } from '@react-three/xr'
// The real Simulator, PointerEvents, Handle and drei OrbitControls run in a real R3F root (simulatorStage.tsx).
// Only what Node cannot provide is replaced: WebGL, the avatar model, troika text and XR sessions.
// XR controller grabs go through the Frame's real controller seam instead: see frameControllerGrab.test.tsx.
const orbit = vi.hoisted(() => ({ starts: 0, ends: 0 }))
const canvasProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('@react-three/fiber', async importOriginal => ({ ...await importOriginal<typeof import('@react-three/fiber')>(), Canvas: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => { canvasProps.current = props; return <>{children}</> } }))
vi.mock('@react-three/drei', async () => {
  const { OrbitControls } = await import('@react-three/drei/core/OrbitControls.js')
  const { Group } = await import('three')
  const avatar = { scene: new Group(), animations: [] }
  return {
    OrbitControls: (props: object) => <OrbitControls {...props} onStart={() => { orbit.starts++ }} onEnd={() => { orbit.ends++ }} />,
    // Troika text needs workers and fonts; a plane of similar size takes its hits.
    Text: ({ children, position, fontSize = 0.1 }: { children: ReactNode; position?: [number, number, number]; fontSize?: number }) => <mesh name={`Text ${String(children)}`} position={position}><planeGeometry args={[String(children).length * fontSize * 0.6, fontSize * 1.2]} /><meshBasicMaterial /></mesh>,
    Html: () => null, useGLTF: () => avatar, useAnimations: () => ({ actions: {}, names: [] }),
  }
})
vi.mock('@react-three/xr', async () => ({ ...await import('@react-three/xr/dist/events.js'), XR: ({ children }: { children: ReactNode }) => <>{children}</>, useXRInputSourceEvent: () => undefined }))
vi.mock('./xr', () => ({ xrStore: {} }))
vi.mock('./model', () => ({ groundOffset: () => 0 }))
vi.mock('./artifactTexture', async () => {
  const { Texture } = await import('three')
  const page = Object.assign(new Texture(), { image: { width: 1000, height: 1294 } })
  return { loadArtifactTexture: async () => page }
})
import { stageSimulator } from './simulatorStage'
import type { Point } from './simulatorStage'
import type { ArtifactPlacement } from './artifactPlacement'

const view = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 3, sourceUrl: 'https://example.com/a.pdf', page: 1 }
const home: ArtifactPlacement = { home: [1.05, 1.2, -2.6], x: 0, y: 0, z: 0, scale: 1 }
// Panel-local points: bare background, title, page, and the front face of the Next control.
const surface: Point = [-0.78, 0.6, 0], title: Point = [0, 0.92, 0.04], page: Point = [0, 0.08, 0.02], next: Point = [0.11, -0.725, 0.0525]
const upright = [0, 0, 0, 1]
let current: Awaited<ReturnType<typeof stageSimulator>> | undefined
async function staged() { return current = await stageSimulator(view, home) }
afterEach(async () => { await current?.unmount(); current = undefined; orbit.starts = 0; orbit.ends = 0 })

it('gives the canvas one event system, the pointer events that grab handles and XR inputs share', async () => {
  await staged()
  expect(canvasProps.current.events).toBe(noEvents)
})
it('grabs the whole panel, controls included, by its surface, title or page', async () => {
  const { drag, at, panel, handlers, scene } = await staged()
  let pageMesh: Mesh | undefined
  scene().traverse(object => { if (object instanceof Mesh && (object.material as MeshBasicMaterial).map) pageMesh = object })
  expect(pageMesh).toBeDefined()
  const next = scene().getObjectByName('Next')!.getWorldPosition(new Vector3())
  for (const [index, part] of [surface, title, page].entries()) {
    drag(at(part), at(part, [0.1, 0, 0]))
    expect(panel().position.x).toBeCloseTo(home.home[0] + 0.1 * (index + 1))
    expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, x: [0.1, 0.2, 0.3][index] })
  }
  expect(scene().getObjectByName('Next')!.getWorldPosition(new Vector3()).x).toBeCloseTo(next.x + 0.3)
})
it('never starts a grab from a control: pressing Next and sliding off moves nothing, and a click still pages', async () => {
  const { drag, press, send, at, panel, handlers } = await staged()
  const start = panel().position.clone()
  drag(at(next), at(next, [0.3, 0, 0]))
  expect(panel().position).toEqual(start); expect(handlers.onArtifactPlace).not.toHaveBeenCalled(); expect(handlers.onArtifactPage).not.toHaveBeenCalled()
  press(at(next)); send('pointerup', at(next))
  expect(handlers.onArtifactPage).toHaveBeenCalledExactlyOnceWith(1); expect(panel().position).toEqual(start)
})
it('keeps a slow, deliberate desktop press on a control a click, as before grabbing existed', async () => {
  const { press, send, at, handlers } = await staged()
  press(at(next)); send('pointerup', at(next), { wait: 900 })
  expect(handlers.onArtifactPage).toHaveBeenCalledExactlyOnceWith(1)
})
it('translates the panel with one pointer, keeping it upright, unscaled and facing the user', async () => {
  const { drag, at, panel, handlers } = await staged()
  drag(at(surface), at(surface, [0.3, -0.2, 0]))
  const [, placement] = handlers.onArtifactPlace.mock.lastCall!
  expect(placement.x).toBeCloseTo(0.3, 2); expect(placement.y).toBeCloseTo(-0.2, 1); expect(Math.abs(placement.z)).toBeLessThan(0.05); expect(placement.scale).toBe(1)
  expect(panel().quaternion.toArray()).toEqual(upright); expect(panel().scale.toArray()).toEqual([1, 1, 1])
})
it('stops at the placement bounds while grabbed and follows again when brought back, so the panel is never lost', async () => {
  const { press, send, frame: render, at, panel, handlers } = await staged()
  const from = at(surface)
  press(from)
  send('pointermove', from.clone().add(new Vector3(3, 0, 0))); render()
  expect(panel().position.x).toBeCloseTo(home.home[0] + 0.6)
  send('pointermove', from.clone().add(new Vector3(-0.2, 0, 0))); render()
  expect(panel().position.x).toBeCloseTo(home.home[0] - 0.2)
  send('pointerup', from.clone().add(new Vector3(-0.2, 0, 0)))
  expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, x: -0.2 })
})
it('scales uniformly between half and double size with two simultaneous grips, without rotating', async () => {
  const { press, send, frame: render, at, panel, handlers } = await staged()
  const a = at([-0.3, 0.1, 0.02]), b = at([0.3, 0.1, 0.02]), middle = a.clone().add(b).multiplyScalar(0.5)
  const touch = (id: number) => ({ id, pointerType: 'touch' })
  const apart = (distance: number) => {
    send('pointermove', middle.clone().add(new Vector3(-distance / 2, 0, 0)), touch(11)); send('pointermove', middle.clone().add(new Vector3(distance / 2, 0, 0)), touch(12)); render()
    return panel().scale.toArray()
  }
  press(a, touch(11)); press(b, touch(12))
  expect(apart(0.9)).toEqual([1.5, 1.5, 1.5])
  expect(apart(6)).toEqual([2, 2, 2])
  expect(apart(0.06)).toEqual([0.5, 0.5, 0.5])
  expect(apart(0.9)).toEqual([1.5, 1.5, 1.5]); expect(panel().quaternion.toArray()).toEqual(upright)
  send('pointerup', middle, touch(12)); send('pointerup', middle, touch(11))
  expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, expect.objectContaining({ scale: 1.5 }))
})
it('grabs only with the primary button: a right-button drag on the surface leaves the panel in place', async () => {
  const { drag, at, panel, handlers } = await staged()
  const start = panel().position.clone()
  drag(at(surface), at(surface, [0.3, 0, 0]), { button: 2 })
  expect(panel().position).toEqual(start); expect(handlers.onArtifactPlace).not.toHaveBeenCalled()
})
it('starts and releases a grab without starting or stopping PTT or orbiting the camera, while bare canvas presses still do both', async () => {
  const { drag, press, send, at, ptt } = await staged()
  const { down } = drag(at(surface), at(surface, [0.2, 0, 0]))
  expect(down.stopped).toBe(true)
  expect(ptt.start).not.toHaveBeenCalled(); expect(ptt.stop).not.toHaveBeenCalled(); expect(orbit.starts).toBe(0)
  // Off to the left of the panel and the character there is nothing to hit.
  press(new Vector3(-2.5, 1, -2))
  expect(orbit.starts).toBe(1); expect(ptt.start).toHaveBeenCalledTimes(1)
  // Released over the panel, that hold still ends: the release reaches PTT and OrbitControls' document listener.
  const release = send('pointerup', at(surface))
  expect(release.stopped).toBe(false); expect(ptt.stop).toHaveBeenCalledTimes(1); expect(orbit.ends).toBe(1)
})
it('drops a grab in progress when a different artifact opens, which then sits at its own home', async () => {
  const { press, send, frame: render, render: show, at, panel, handlers } = await staged()
  const from = at(surface)
  press(from); send('pointermove', from.clone().add(new Vector3(0.3, 0, 0))); render()
  const other = { ...view, id: 'b'.repeat(32) }, otherHome: ArtifactPlacement = { home: [1.05, 1.7, -3.6], x: 0, y: 0, z: 0, scale: 1 }
  await show(other, otherHome)
  send('pointermove', from.clone().add(new Vector3(0.5, 0, 0))); render(); send('pointerup', from.clone().add(new Vector3(0.5, 0, 0)))
  expect(panel().position.toArray()).toEqual([1.05, 1.7, -3.6])
  for (const [id] of handlers.onArtifactPlace.mock.calls) expect(id).toBe(view.id)
})
