import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { Vector3 } from 'three'
// The Steam Frame controller seam, as the Frame's Chromium OpenXR runtime delivers it: XR session select (trigger) and
// squeeze (grip) events whose poses come only from XRFrame.getPose (see the controller rig in simulatorStage.tsx). They
// run through the real Simulator, panel, grab handle, controller push-to-talk, and the pointers @react-three/xr's default
// controller binds to those events. Only what Node cannot provide is replaced: WebGL, the avatar model, troika text and
// the WebXR session itself.
const session = vi.hoisted(() => new EventTarget())
const reference = vi.hoisted(() => ({}))
const orbit = vi.hoisted(() => ({ starts: 0 }))
vi.mock('@react-three/fiber', async importOriginal => ({ ...await importOriginal<typeof import('@react-three/fiber')>(), Canvas: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@react-three/drei', async () => {
  const { OrbitControls } = await import('@react-three/drei/core/OrbitControls.js')
  const { Group } = await import('three')
  const avatar = { scene: new Group(), animations: [] }
  return {
    OrbitControls: (props: object) => <OrbitControls {...props} onStart={() => { orbit.starts++ }} />,
    // Troika text needs workers and fonts; a plane of similar size takes its hits.
    Text: ({ children, position, fontSize = 0.1 }: { children: ReactNode; position?: [number, number, number]; fontSize?: number }) => <mesh name={`Text ${String(children)}`} position={position}><planeGeometry args={[String(children).length * fontSize * 0.6, fontSize * 1.2]} /><meshBasicMaterial /></mesh>,
    Html: () => null, useGLTF: () => avatar, useAnimations: () => ({ actions: {}, names: [] }),
  }
})
// @react-three/xr's own useXRInputSourceEvent binds the store's session with this same function; here it is the test's session.
vi.mock('@react-three/xr', async () => {
  const { useEffect } = await import('react')
  const { bindXRInputSourceEvent } = await import('@pmndrs/xr/internals')
  return {
    ...await import('@react-three/xr/dist/events.js'), XR: ({ children }: { children: ReactNode }) => <>{children}</>,
    useXRInputSourceEvent: (source: XRInputSource | 'all', type: 'selectstart', fn: (event: XRInputSourceEvent) => void, deps: unknown[]) => {
      // oxlint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => bindXRInputSourceEvent(session as XRSession, source, type, fn), [type, source, ...deps])
    },
  }
})
vi.mock('./xr', () => ({ xrStore: { getState: () => ({ originReferenceSpace: reference }) } }))
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
// Panel-local points: the page, and the front face of the Next control.
const page: Point = [0, 0.08, 0.02], next: Point = [0.11, -0.725, 0.0525]
// Where the wearer, standing at the origin of the local-floor space, holds the right controller: 2.4 m from the page.
const hand = new Vector3(0.25, 1.1, -0.35)
const upright = [0, 0, 0, 1]
let current: Awaited<ReturnType<typeof stageSimulator>> | undefined
async function staged() {
  const stage = current = await stageSimulator(view, home)
  return { ...stage, right: stage.controller(session, reference, 'right') }
}
afterEach(async () => { await current?.unmount(); current = undefined; orbit.starts = 0 })

it('grips the distant panel like a book with the Frame grip aimed at it: it follows the hand, not the wrist, upright and unscaled', async () => {
  const { right, at, panel, handlers } = await staged()
  const move = new Vector3(-0.3, 0.1, 0.25)
  right.aim(hand, at(page)); right.press('squeeze')
  // The hand moves and the wrist turns; a book held in it goes where the hand goes, without swinging 2.4 m out on the wrist.
  right.aim(hand.clone().add(move), at(page).add(move).add(new Vector3(0.4, 0, 0)))
  right.release('squeeze')
  expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, x: -0.3, y: 0.1, z: 0.25 })
  const [x, y, z] = panel().position.toArray()
  expect(x).toBeCloseTo(0.75); expect(y).toBeCloseTo(1.3); expect(z).toBeCloseTo(-2.35)
  expect(panel().quaternion.toArray()).toEqual(upright); expect(panel().scale.toArray()).toEqual([1, 1, 1])
  expect(handlers.onArtifactPage).not.toHaveBeenCalled(); expect(handlers.onPushToTalkStart).not.toHaveBeenCalled(); expect(orbit.starts).toBe(0)
})
it('moves the panel when the grip squeezes with the controller aimed at a control, never activating the control', async () => {
  const { right, at, handlers } = await staged()
  const move = new Vector3(0.2, 0, 0)
  right.aim(hand, at(next)); right.press('squeeze')
  right.aim(hand.clone().add(move), at(next).add(move))
  right.release('squeeze')
  expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, x: 0.2 }); expect(handlers.onArtifactPage).not.toHaveBeenCalled()
})
it('grabs with the grip squeezed against the panel even when the controller points away, still never clicking the control there', async () => {
  const { right, at, handlers } = await staged()
  // Held against the face of the Next control, 6 cm in front of the surface, pointing up and back toward the wearer.
  const touching = at([0.11, -0.725, 0.06]), away = new Vector3(0, 1, 1), move = new Vector3(0.2, 0, 0)
  right.aim(touching, touching.clone().add(away)); right.press('squeeze')
  right.aim(touching.clone().add(move), touching.clone().add(move).add(away))
  right.release('squeeze')
  expect(handlers.onArtifactPage).not.toHaveBeenCalled(); expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, x: 0.2 })
})
it('keeps the trigger for controls, with no grab or push-to-talk, while a trigger drag on the page follows the hand rather than the wrist', async () => {
  const { right, at, panel, handlers } = await staged()
  const start = panel().position.clone()
  right.aim(hand, at(next)); right.press('select'); right.release('select')
  expect(handlers.onArtifactPage).toHaveBeenCalledExactlyOnceWith(1); expect(panel().position).toEqual(start); expect(handlers.onArtifactPlace).not.toHaveBeenCalled()
  const move = new Vector3(0.1, -0.1, 0.2)
  right.aim(hand, at(page)); right.press('select')
  right.aim(hand.clone().add(move), at(page).add(move).add(new Vector3(-0.4, 0, 0)))
  right.release('select')
  expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, x: 0.1, y: -0.1, z: 0.2 })
  expect(handlers.onArtifactPage).toHaveBeenCalledTimes(1); expect(handlers.onPushToTalkStart).not.toHaveBeenCalled(); expect(orbit.starts).toBe(0)
})
it('stops a panel pulled toward the wearer at the reading distance, 0.45 m in front of them, never in their face', async () => {
  const { right, at, panel, handlers } = await staged()
  const pull = new Vector3(0, 0, 3)
  right.aim(hand, at(page)); right.press('squeeze')
  right.aim(hand.clone().add(pull), at(page).add(pull))
  right.release('squeeze')
  expect(panel().position.z).toBeCloseTo(-0.45); expect(handlers.onArtifactPlace).toHaveBeenLastCalledWith(view.id, { ...home, z: 2.15 })
})
it('drops a controller grab in progress when a different artifact opens, which then sits at its own home', async () => {
  const { right, at, panel, handlers, render: show } = await staged()
  right.aim(hand, at(page)); right.press('squeeze')
  right.aim(hand.clone().add(new Vector3(0.3, 0, 0)), at(page).add(new Vector3(0.3, 0, 0)))
  await show({ ...view, id: 'b'.repeat(32) }, { home: [1.05, 1.7, -3.6], x: 0, y: 0, z: 0, scale: 1 })
  right.aim(hand.clone().add(new Vector3(0.5, 0, 0)), at(page).add(new Vector3(0.5, 0, 0)))
  right.release('squeeze')
  expect(panel().position.toArray()).toEqual([1.05, 1.7, -3.6])
  for (const [id] of handlers.onArtifactPlace.mock.calls) expect(id).toBe(view.id)
})
