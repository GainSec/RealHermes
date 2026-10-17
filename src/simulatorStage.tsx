// Test harness, not app code: a real R3F root running the real Simulator, PointerEvents, Handle and drei
// OrbitControls against DOM-level pointer events. Test files using it mock only what Node cannot provide:
// WebGL, the avatar model, troika text and XR sessions (see artifactGrab.test.tsx).
import { vi } from 'vitest'
import * as THREE from 'three'
import { Matrix4, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three'
import type { Camera } from 'three'
import { act, advance, createRoot, extend } from '@react-three/fiber'
import type { RootState } from '@react-three/fiber'
import { noEvents } from '@react-three/xr'
import { CombinedPointer, createGrabPointer, createRayPointer } from '@pmndrs/pointer-events'
import { bindPointerXRInputSourceEvent } from '@pmndrs/xr/internals'
import Simulator from './Simulator'
import { bindCanvasPushToTalk } from './pointerPushToTalk'
import { simulatorCamera } from './placement'
import type { ArtifactView } from './artifact'
import type { ArtifactPlacement } from './artifactPlacement'

export type Point = [number, number, number]
// The Steam Frame canvas, measured live: 641x543 CSS px.
const frame = { width: 641, height: 543 }
// Node has no MouseEvent, and @pmndrs/pointer-events maps only MouseEvents to canvas coordinates.
export class DomPointerEvent extends Event {
  declare readonly pointerId: number; declare readonly pointerType: string; declare readonly button: number
  stopped = false
  constructor(type: string, init: Record<string, number | string>) {
    super(type, { bubbles: true, cancelable: true })
    for (const [key, value] of Object.entries(init)) Object.defineProperty(this, key, { value })
  }
  stopPropagation() { this.stopped = true; super.stopPropagation() }
  stopImmediatePropagation() { this.stopped = true; super.stopImmediatePropagation() }
}
vi.stubGlobal('MouseEvent', DomPointerEvent)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
// The Simulator's Canvas renders continuously, which PointerEvents' default batching follows. Keep that frameloop,
// but run frames only when a test advances one.
vi.stubGlobal('requestAnimationFrame', () => 0)
vi.stubGlobal('cancelAnimationFrame', () => {})
// What <Canvas> registers. Node resolves R3F to CommonJS, so pass the ES module three that the pointer-events
// library patches, and give the root a camera and scene from it too: one three everywhere, as in the browser bundle.
extend(THREE as unknown as Parameters<typeof extend>[0])
export type PointerOptions = { id?: number; button?: number; pointerType?: string; wait?: number }

export async function stageSimulator(artifact: ArtifactView, artifactPlacement: ArtifactPlacement) {
  const canvas = Object.assign(new EventTarget(), { tagName: 'CANVAS', style: {}, ownerDocument: new EventTarget(), clientWidth: frame.width, clientHeight: frame.height, getBoundingClientRect: () => ({ left: 0, top: 0, width: frame.width, height: frame.height }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false })
  // Stands in for WebGLRenderer, which brings world matrices up to date as it renders.
  const gl = { domElement: canvas, shadowMap: {}, xr: { enabled: false, isPresenting: false, addEventListener() {}, removeEventListener() {}, setAnimationLoop() {}, getReferenceSpace: () => null }, render(scene: Scene, camera: Camera) { scene.updateMatrixWorld(); camera.updateMatrixWorld() }, setSize() {}, setPixelRatio() {}, dispose() {} }
  const root = createRoot(canvas as unknown as HTMLCanvasElement)
  const camera = new PerspectiveCamera(simulatorCamera.fov, frame.width / frame.height, 0.1, 1000); camera.position.set(...simulatorCamera.position)
  await root.configure({ gl: gl as never, events: noEvents, camera, scene: new Scene(), size: { width: frame.width, height: frame.height, top: 0, left: 0 }, frameloop: 'always', dpr: 1 })
  const handlers = { onArtifactPage: vi.fn(), onArtifactClose: vi.fn(), onArtifactAdjust: vi.fn(), onArtifactPlace: vi.fn(), onPushToTalkStart: vi.fn(), onPushToTalkStop: vi.fn() }
  let state!: RootState
  let time = 0
  // Staged XR controllers: each frame their spaces take the XRFrame pose, then @react-three/xr's root CombinedPointer
  // moves their pointers, before the scene's own frame callbacks run with the same XRFrame.
  const controllers: Array<() => void> = [], unbind: Array<() => void> = []
  const pointers = new CombinedPointer(true)
  const frameAt = (xrFrame?: XRFrame) => {
    if (controllers.length) { for (const sync of controllers) sync(); pointers.move(state.scene, { timeStamp: time }) }
    advance(time += 16, true, xrFrame && state, xrFrame)
  }
  const render = async (view = artifact, placement = artifactPlacement) => {
    await act(async () => { state = root.render(<Simulator state="idle" artifact={view} artifactPlacement={placement} {...handlers} />).getState() })
    // Lets the page texture finish loading, then renders a frame so OrbitControls aims the camera.
    await act(async () => {})
    frameAt()
  }
  await render()
  // App's real canvas push-to-talk: pointerdown on window in the bubble phase, release in the capture phase.
  const app = new Map<string, (event: DomPointerEvent) => void>()
  const ptt = { start: vi.fn(), stop: vi.fn() }
  bindCanvasPushToTalk({ addEventListener: (type: string, listener: (event: DomPointerEvent) => void) => app.set(type, listener), removeEventListener() {} } as unknown as Window, { current: false }, ptt.start, ptt.stop)
  const send = (type: 'pointermove' | 'pointerdown' | 'pointerup', at: Vector3, { id = 1, button = 0, pointerType = 'mouse', wait = 16 }: PointerOptions = {}) => {
    const { x, y } = at.clone().project(state.camera)
    const event = new DomPointerEvent(type, { pointerId: id, pointerType, button, clientX: (x + 1) / 2 * frame.width, clientY: (1 - y) / 2 * frame.height, timeStamp: time += wait })
    if (type === 'pointerup') app.get(type)?.(event)
    canvas.dispatchEvent(event)
    // Unless consumed, the press bubbles on to App's window listener and OrbitControls' document listeners.
    if (!event.stopped) { if (type === 'pointerdown') app.get(type)?.(event); canvas.ownerDocument.dispatchEvent(event) }
    return event
  }
  const press = (from: Vector3, options?: PointerOptions) => { send('pointermove', from, options); return send('pointerdown', from, options) }
  const drag = (from: Vector3, to: Vector3, options?: PointerOptions) => {
    const down = press(from, options); send('pointermove', to, options); frameAt()
    return { down, up: send('pointerup', to, options) }
  }
  // The panel root: Next sits in the control group directly beneath it.
  const panel = () => state.scene.getObjectByName('Next')!.parent!.parent!
  const at = (point: Point, offset: Point = [0, 0, 0]) => panel().localToWorld(new Vector3(...point)).add(new Vector3(...offset))
  const xrEvent = () => ({ timeStamp: time += 16, button: 0, inputSource: {} })
  // A Steam Frame controller as the Frame's Chromium OpenXR runtime delivers it (XR_VALVE_frame_controller_interaction):
  // trigger as select and grip as squeeze session events, and poses only through XRFrame.getPose against the session's
  // reference space. It also drives the pointers @react-three/xr's DefaultXRController gives every controller: a
  // select-bound ray (the default, ignoring hits nearer than 0.2 m) and a squeeze-bound 7 cm grip sphere, combined so
  // only the one with the nearest hit is enabled.
  const controller = (session: EventTarget, reference: object, handedness: 'left' | 'right' = 'right') => {
    const inputSource = { handedness, targetRayMode: 'tracked-pointer', gamepad: {}, targetRaySpace: {}, gripSpace: {} }
    // Grip and target ray share one pose here: the hand position and the ray from it.
    const pose = new Matrix4()
    const getPose = (space: object, from: object) => from === reference && (space === inputSource.targetRaySpace || space === inputSource.gripSpace) ? { transform: { matrix: pose.toArray() } } : undefined
    const xrFrame = { session, getPose } as unknown as XRFrame
    const spaces = [new Object3D(), new Object3D()].map(space => Object.assign(space, { matrixAutoUpdate: false }))
    const sync = () => { for (const space of spaces) { space.matrix.copy(pose); Object.assign(space, { transformReady: true }) } }
    const pointerState = { type: 'controller', inputSource, events: [] }
    const grip = createGrabPointer(() => state.camera, { current: spaces[0] }, pointerState, {})
    const ray = createRayPointer(() => state.camera, { current: spaces[1] }, pointerState, { minDistance: 0.2 })
    const combined = new CombinedPointer(false); combined.register(grip); combined.register(ray, true); pointers.register(combined)
    unbind.push(bindPointerXRInputSourceEvent(grip, session as XRSession, inputSource as unknown as XRInputSource, 'squeeze', []))
    unbind.push(bindPointerXRInputSourceEvent(ray, session as XRSession, inputSource as unknown as XRInputSource, 'select', []))
    controllers.push(sync)
    const dispatch = (type: string) => session.dispatchEvent(Object.assign(new Event(type), { inputSource, frame: xrFrame }))
    return {
      // Holds the controller at `from` with its target ray aimed at `to`, then renders a frame.
      aim(from: Vector3, to: Vector3) { pose.lookAt(from, to, new Vector3(0, 1, 0)).setPosition(from); frameAt(xrFrame) },
      press: (button: 'select' | 'squeeze') => dispatch(`${button}start`),
      release: (button: 'select' | 'squeeze') => dispatch(`${button}end`),
    }
  }
  return { handlers, ptt, render, send, press, drag, panel, at, frame: frameAt, xrEvent, controller, scene: () => state.scene, camera: () => state.camera, unmount: () => { for (const done of unbind) done(); return act(async () => root.unmount()) } }
}
