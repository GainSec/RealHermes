import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { BoxGeometry, Mesh, PerspectiveCamera, PlaneGeometry, Vector3 } from 'three'
import type { MeshBasicMaterial, Object3D } from 'three'
import { OrbitControls } from 'three-stdlib'
// Scene-level tests render the real panel inside the real Simulator in a real R3F root (simulatorStage.tsx).
// Only what Node cannot provide is replaced: WebGL, the avatar model, troika text and XR sessions.
const orbit = vi.hoisted(() => ({ starts: 0, ends: 0 }))
const pageImage = vi.hoisted(() => ({ width: 1000, height: 1294 }))
vi.mock('@react-three/fiber', async importOriginal => ({ ...await importOriginal<typeof import('@react-three/fiber')>(), Canvas: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@react-three/drei', async () => {
  const { OrbitControls } = await import('@react-three/drei/core/OrbitControls.js')
  const { Group } = await import('three')
  const avatar = { scene: new Group(), animations: [] }
  return {
    OrbitControls: (props: object) => <OrbitControls {...props} onStart={() => { orbit.starts++ }} onEnd={() => { orbit.ends++ }} />,
    // Troika text needs workers and fonts; a plane of similar size takes its hits and keeps its font size.
    Text: ({ children, position, fontSize = 0.1 }: { children: ReactNode; position?: [number, number, number]; fontSize?: number }) => <mesh name={`Text ${String(children)}`} position={position} userData={{ fontSize }}><planeGeometry args={[String(children).length * fontSize * 0.6, fontSize * 1.2]} /><meshBasicMaterial /></mesh>,
    Html: () => null, useGLTF: () => avatar, useAnimations: () => ({ actions: {}, names: [] }),
  }
})
vi.mock('@react-three/xr', async () => ({ ...await import('@react-three/xr/dist/events.js'), XR: ({ children }: { children: ReactNode }) => <>{children}</>, useXRInputSourceEvent: () => undefined }))
vi.mock('./xr', () => ({ xrStore: {} }))
vi.mock('./model', () => ({ groundOffset: () => 0 }))
vi.mock('./artifactTexture', async () => {
  const { Texture } = await import('three')
  return { loadArtifactTexture: async () => Object.assign(new Texture(), { image: { ...pageImage } }) }
})
import { ArtifactControls } from './ArtifactPanel'
import { simulatorCamera } from './placement'
import { isCanvasPushToTalkPointer } from './pointerPushToTalk'
import { stageSimulator } from './simulatorStage'
import type { Point } from './simulatorStage'
import type { ArtifactView } from './artifact'
import type { ArtifactPlacement } from './artifactPlacement'
const view = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 3, sourceUrl: 'https://example.com/a.pdf', page: 1 }
// Where an artifact opens for the default avatar placement (height 0, distance 2).
const home = { home: [1.05, 1.2, -2.6] as [number, number, number], x: 0, y: 0, z: 0, scale: 1 }
const handlers = () => ({ onPage: vi.fn(), onClose: vi.fn(), onAdjust: vi.fn() })
const names = ['Previous', 'Next', 'Close', 'Left', 'Right', 'Up', 'Down', 'Nearer', 'Farther', 'Smaller', 'Larger', 'Reset']
// Panel-local points: bare background and the front face of the Next control; a spot on the canvas with nothing there.
const surface: Point = [-0.78, 0.6, 0], next: Point = [0.11, -0.725, 0.0525], bare = new Vector3(-2.5, 1, -2)
// Controls are named meshes; search the returned element tree (nested components are not rendered).
function find(node: any, name: string): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.props?.name === name) return node
  for (const child of [node.props?.children].flat(Infinity)) { const hit = find(child, name); if (hit) return hit }
}
const canvasPress = () => ({ nativeEvent: { button: 0, target: { tagName: 'CANVAS' }, stopPropagation: vi.fn(), preventDefault: vi.fn() }, stopPropagation: vi.fn() })
// Measured live on Steam Frame Chromium (1280x680 viewport): a 641x543 CSS px canvas whose top 62 px sit under
// the stage heading and whose bottom 144 px sit under the stage footer while an artifact is open.
const frame = { width: 641, height: 543, heading: 62, footer: 144 }
function frameCamera() {
  const camera = new PerspectiveCamera(simulatorCamera.fov, frame.width / frame.height)
  camera.position.set(...simulatorCamera.position); camera.lookAt(...simulatorCamera.target); camera.updateMatrixWorld()
  return camera
}
const texturedMeshes = (root: Object3D) => { const found: Mesh[] = []; root.traverse(object => { if (object instanceof Mesh && (object.material as MeshBasicMaterial).map) found.push(object) }); return found }
let staged: Awaited<ReturnType<typeof stageSimulator>> | undefined
const stage = async (artifact: ArtifactView = view, placement: ArtifactPlacement = home) => staged = await stageSimulator(artifact, placement)
afterEach(async () => { await staged?.unmount(); staged = undefined; orbit.starts = 0; orbit.ends = 0; Object.assign(pageImage, { width: 1000, height: 1294 }) })

it('renders the artifact as a WebGL panel beside the existing character, with title, page and visible controls', async () => {
  const { panel } = await stage(view, { ...home, home: [1.05, 1.7, -3.6] })
  expect(panel().position.toArray()).toEqual([1.05, 1.7, -3.6])
  expect(panel().getObjectByName('Text Guide')).toBeDefined(); expect(panel().getObjectByName('Text 1 / 3')).toBeDefined()
  for (const label of ['Previous', 'Next', 'Close', 'Nearer', 'Farther', 'Smaller', 'Larger', 'Reset']) expect(panel().getObjectByName(label)!.getObjectByName(`Text ${label}`)).toBeDefined()
  // WebGL rather than DOM content: a plane surface, with the page drawn as a texture on a mesh.
  expect((panel().getObjectByName('Surface') as Mesh).geometry).toBeInstanceOf(PlaneGeometry); expect(texturedMeshes(panel())).toHaveLength(1)
})
it('moves and scales as one spatial object from its own placement', async () => {
  const { panel } = await stage(view, { ...home, x: -0.4, y: 0.2, z: 0.3, scale: 1.5 })
  const [x, y, z] = panel().position.toArray()
  expect(x).toBeCloseTo(0.65); expect(y).toBeCloseTo(1.4); expect(z).toBeCloseTo(-2.3); expect(panel().scale.toArray()).toEqual([1.5, 1.5, 1.5])
  // Surface, title, page and every control are inside that one object.
  for (const name of ['Surface', 'Text Guide', ...names]) expect(panel().getObjectByName(name)).toBeDefined()
  expect(texturedMeshes(panel())).toHaveLength(1)
})
it('keeps the whole panel and both legible control rows inside the Steam Frame canvas and clear of its DOM overlays', async () => {
  const { panel } = await stage()
  const camera = frameCamera()
  const project = (point: Vector3) => { const projected = point.clone().project(camera); return { left: (projected.x + 1) / 2 * frame.width, top: (1 - projected.y) / 2 * frame.height } }
  const inside = ({ left, top }: { left: number; top: number }) => { expect(left).toBeGreaterThanOrEqual(0); expect(left).toBeLessThanOrEqual(frame.width); expect(top).toBeGreaterThanOrEqual(frame.heading); expect(top).toBeLessThanOrEqual(frame.height - frame.footer) }
  const surfaceMesh = panel().getObjectByName('Surface') as Mesh
  const { width: panelWidth, height: panelHeight } = (surfaceMesh.geometry as PlaneGeometry).parameters
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) inside(project(surfaceMesh.localToWorld(new Vector3(dx * panelWidth / 2, dy * panelHeight / 2, 0))))
  for (const name of names) {
    const control = panel().getObjectByName(name) as Mesh
    const { width, height } = (control.geometry as BoxGeometry).parameters
    const corner = project(control.localToWorld(new Vector3(-width / 2, height / 2, 0))), opposite = project(control.localToWorld(new Vector3(width / 2, -height / 2, 0)))
    inside(corner); inside(opposite)
    // Big enough to read and to hit with the Frame's laser pointer.
    expect(opposite.top - corner.top).toBeGreaterThanOrEqual(20); expect(opposite.left - corner.left).toBeGreaterThanOrEqual(14)
  }
})
it('fits even the tallest page between the title and both control rows', async () => {
  Object.assign(pageImage, { width: 100, height: 8000 })
  const { panel } = await stage({ ...view, id: 'b'.repeat(32) })
  const local = (object: Object3D) => panel().worldToLocal(object.getWorldPosition(new Vector3()))
  const [page] = texturedMeshes(panel())
  const { height } = (page.geometry as PlaneGeometry).parameters; const { y } = local(page)
  const controlsTop = Math.max(...names.map(name => { const control = panel().getObjectByName(name) as Mesh; return local(control).y + (control.geometry as BoxGeometry).parameters.height / 2 }))
  const title = panel().getObjectByName('Text Guide')!
  expect(y - height / 2).toBeGreaterThan(controlsTop); expect(y + height / 2).toBeLessThan(local(title).y - title.userData.fontSize / 2)
})
it('suppresses canvas PTT for control down/click, including R3F synthetic stopPropagation that alone does not stop DOM bubbling', () => {
  const { onPage, onClose, onAdjust } = handlers()
  const controls = ArtifactControls({ view, placement: home, onPage, onClose, onAdjust })
  const event = canvasPress(); const { nativeEvent } = event
  expect(isCanvasPushToTalkPointer(nativeEvent)).toBe(true)
  find(controls, 'Next').props.onPointerDown(event)
  expect(event.stopPropagation).toHaveBeenCalled(); expect(nativeEvent.stopPropagation).toHaveBeenCalled(); expect(nativeEvent.preventDefault).not.toHaveBeenCalled()
  expect(isCanvasPushToTalkPointer(nativeEvent)).toBe(false)
  find(controls, 'Next').props.onClick(event); expect(onPage).toHaveBeenCalledWith(1)
  find(controls, 'Previous').props.onClick(event); expect(onPage).toHaveBeenCalledTimes(1)
  find(controls, 'Close').props.onClick(event); expect(onClose).toHaveBeenCalledTimes(1)
  expect(onAdjust).not.toHaveBeenCalled()
  expect(isCanvasPushToTalkPointer({ button: 0, target: { tagName: 'CANVAS' } })).toBe(true)
})
it('gives every placement control a consumed press that requests exactly its own adjustment', () => {
  const { onPage, onClose, onAdjust } = handlers()
  const controls = ArtifactControls({ view, placement: { ...home, x: -0.2 }, onPage, onClose, onAdjust })
  for (const [name, adjustment] of [['Left', 'left'], ['Right', 'right'], ['Up', 'up'], ['Down', 'down'], ['Nearer', 'nearer'], ['Farther', 'farther'], ['Smaller', 'smaller'], ['Larger', 'larger'], ['Reset', 'reset']]) {
    const event = canvasPress(); const control = find(controls, name)
    control.props.onPointerDown(event); expect(isCanvasPushToTalkPointer(event.nativeEvent)).toBe(false)
    control.props.onClick(event); expect(onAdjust).toHaveBeenLastCalledWith(adjustment)
  }
  expect(onAdjust).toHaveBeenCalledTimes(9); expect(onPage).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
})
it('disables placement controls that cannot change anything: bounds reached, or reset at the opening placement', () => {
  const { onPage, onClose, onAdjust } = handlers()
  find(ArtifactControls({ view, placement: home, onPage, onClose, onAdjust }), 'Reset').props.onClick(canvasPress())
  // Nearer stops at the reading distance, 0.45 m in front of the wearer (z -0.45 for this home).
  const corner = ArtifactControls({ view, placement: { ...home, x: 0.6, y: -0.6, z: 2.15, scale: 2 }, onPage, onClose, onAdjust })
  for (const name of ['Right', 'Down', 'Nearer', 'Larger']) find(corner, name).props.onClick(canvasPress())
  expect(onAdjust).not.toHaveBeenCalled()
  find(corner, 'Left').props.onClick(canvasPress()); expect(onAdjust).toHaveBeenCalledWith('left')
})
it('keeps an artifact press from starting a camera orbit, without stopping XR session events', () => {
  // The Simulator's PointerEvents connects its canvas listeners before drei connects OrbitControls to the same element.
  const element = Object.assign(new EventTarget(), { style: {}, ownerDocument: new EventTarget(), releasePointerCapture() {} })
  const larger = find(ArtifactControls({ view, placement: home, ...handlers() }), 'Larger')
  element.addEventListener('pointerdown', event => { if ((event as Event & { overArtifact?: boolean }).overArtifact) larger.props.onPointerDown({ nativeEvent: event, stopPropagation() {} }) })
  const orbit = new OrbitControls(new PerspectiveCamera(), element as unknown as HTMLElement)
  let orbits = 0; orbit.addEventListener('start', () => orbits++)
  const press = (overArtifact: boolean) => {
    element.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 5, clientY: 5, overArtifact }))
    element.ownerDocument.dispatchEvent(Object.assign(new Event('pointerup'), { button: 0, pointerType: 'mouse', pointerId: 1 }))
  }
  press(false); expect(orbits).toBe(1)
  press(true); expect(orbits).toBe(1)
  // XR selectstart reaches R3F handlers through @react-three/xr; its session listeners must all still run.
  const selectStart = { inputSource: {}, stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() }
  larger.props.onPointerDown({ nativeEvent: selectStart, stopPropagation() {} })
  expect(selectStart.stopImmediatePropagation).not.toHaveBeenCalled()
  orbit.dispose()
})
it('lets releases over the panel reach document listeners so OrbitControls ends its drag instead of orbiting', async () => {
  // A hold started on the bare canvas (orbit and push-to-talk), then released over the surface or any control.
  for (const target of ['Surface', ...names]) {
    const { press, send, at, panel, ptt } = await stage()
    press(bare)
    expect(orbit.starts, target).toBe(1); expect(ptt.start, target).toHaveBeenCalledTimes(1)
    const over = target === 'Surface' ? at(surface) : panel().getObjectByName(target)!.getWorldPosition(new Vector3())
    send('pointermove', over)
    const release = send('pointerup', over)
    expect(release.stopped, target).toBe(false); expect(orbit.ends, target).toBe(1); expect(ptt.stop, target).toHaveBeenCalledTimes(1)
    await staged?.unmount(); staged = undefined; orbit.starts = 0; orbit.ends = 0
  }
})
it('does not page beyond the last page and consumes the panel surface pointer events', async () => {
  const { press, send, at, handlers: { onArtifactPage }, ptt } = await stage({ ...view, page: 3 })
  press(at(next)); send('pointerup', at(next)); expect(onArtifactPage).not.toHaveBeenCalled()
  const down = press(at(surface))
  expect(down.stopped).toBe(true); expect(isCanvasPushToTalkPointer(down)).toBe(false); expect(ptt.start).not.toHaveBeenCalled()
})
it('loads only same-origin page bytes into a texture, with disposal and bounded decoded size', async () => {
  const { loadArtifactTexture } = await vi.importActual<typeof import('./artifactTexture')>('./artifactTexture')
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(new Blob(['pixels'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }))
  const image = { width: 800, height: 1200, close: vi.fn() }
  const decode = vi.fn(async () => image as unknown as ImageBitmap)
  const texture = await loadArtifactTexture(view, new AbortController().signal, fetcher, decode)
  expect(fetcher.mock.calls[0][0]).toBe(`/api/artifacts/${view.id}/pages/1`)
  expect(texture.image).toBe(image)
  texture.dispose(); expect(image.close).toHaveBeenCalledTimes(1)
  await expect(loadArtifactTexture({ ...view, id: '../secret' }, new AbortController().signal, fetcher, decode)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(loadArtifactTexture(view, new AbortController().signal, vi.fn(async () => new Response('oops', { status: 404 })), decode)).rejects.toThrow()
  await expect(loadArtifactTexture(view, new AbortController().signal, fetcher, async () => ({ ...image, width: 99999 }) as unknown as ImageBitmap)).rejects.toThrow()
})
