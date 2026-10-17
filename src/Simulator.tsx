import { Component, Suspense, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Html, OrbitControls, Text, useAnimations, useGLTF } from '@react-three/drei'
import { noEvents, PointerEvents, XR } from '@react-three/xr'
import type { Group } from 'three'
import type { RefObject } from 'react'
import { controllerTargetsArtifact } from './artifactController'
import { startIdle } from './animation'
import { groundOffset } from './model'
import type { State } from './conversation'
import { xrStore } from './xr'
import { defaultPlacement, simulatorCamera } from './placement'
import type { Placement } from './placement'
import { ControllerPushToTalk } from './ControllerPushToTalk'
import { ArtifactPanel } from './ArtifactPanel'
import type { ArtifactView } from './artifact'
import type { ArtifactAdjustment, ArtifactPlacement } from './artifactPlacement'
function SpatialPushToTalk({ artifactRoot, onStart, onStop }: { artifactRoot: RefObject<Group | null>; onStart: () => void; onStop: () => void }) {
  const gl = useThree(state => state.gl)
  return <ControllerPushToTalk onStart={onStart} onStop={onStop} isArtifactTarget={event => {
    const { origin, originReferenceSpace } = xrStore.getState()
    return controllerTargetsArtifact(event, originReferenceSpace ?? gl.xr.getReferenceSpace(), artifactRoot.current, origin)
  }} />
}
function Avatar({ placement }: { placement: Placement }) {
  const { scene, animations } = useGLTF('/models/realhermes-idle.glb')
  const group = useRef<Group>(null)
  const offset = useMemo(() => groundOffset(scene), [scene])
  const { actions, names } = useAnimations(animations, group)
  useEffect(() => startIdle(names, actions), [actions, names])
  return <group position={[0, placement.height, -placement.distance]}><group ref={group} position={[0, offset, 0]}><primitive object={scene} /></group></group>
}
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div role="alert" className="scene-error">The simulator could not load. Text and voice are still available.</div> : this.props.children }
}
export default function Simulator({ state, placement = defaultPlacement, onPushToTalkStart, onPushToTalkStop, artifact, artifactPlacement, onArtifactPage, onArtifactClose, onArtifactAdjust, onArtifactPlace }: { artifact?: ArtifactView | null; artifactPlacement?: ArtifactPlacement; onArtifactPage?: (delta: number) => void; onArtifactClose?: () => void; onArtifactAdjust?: (adjustment: ArtifactAdjustment) => void; onArtifactPlace?: (id: string, placement: ArtifactPlacement) => void; state: State; placement?: Placement; onPushToTalkStart?: () => void; onPushToTalkStop?: () => void }) {
  const artifactRoot = useRef<Group>(null)
  const statusColor = state === 'working' ? '#efc477' : state === 'error' ? '#e67878' : state === 'listening' ? '#81d6b7' : state === 'speaking' ? '#a99bff' : state === 'thinking' ? '#79b8ff' : '#d8e6e9'
  return <SceneBoundary><Canvas events={noEvents} camera={{ position: [...simulatorCamera.position], fov: simulatorCamera.fov }} aria-label="RealHermes avatar simulator">
    {/* Mouse and touch use the pointer events that XR inputs and grab handles use. Unbatched, each runs inside its
        browser event, so an artifact press is consumed before App's PTT and before drei's OrbitControls, which
        connects to the canvas after this. Clicks keep the browser's no-time-limit desktop behaviour. */}
    <PointerEvents batchEvents={false} clickThresholdMs={Infinity} />
    <XR store={xrStore}>
      {onPushToTalkStart && onPushToTalkStop && <SpatialPushToTalk artifactRoot={artifactRoot} onStart={onPushToTalkStart} onStop={onPushToTalkStop} />}
      {/* Keyed so a different artifact starts a fresh panel, dropping any grab of the previous one. */}
      {artifact && artifactPlacement && onArtifactPage && onArtifactClose && onArtifactAdjust && onArtifactPlace && <group ref={artifactRoot}><ArtifactPanel key={artifact.id} view={artifact} placement={artifactPlacement} onPage={onArtifactPage} onClose={onArtifactClose} onAdjust={onArtifactAdjust} onPlace={onArtifactPlace} /></group>}
      <ambientLight intensity={1.5} /><directionalLight position={[3, 5, 3]} intensity={2} />
      <Suspense fallback={<Html center>Loading Hermes…</Html>}><Avatar placement={placement} /></Suspense>
      <Text position={[0, placement.height + 2.15, -placement.distance]} fontSize={0.13} color={statusColor} anchorX="center" anchorY="middle">{state.toUpperCase()}</Text>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, -2]}><circleGeometry args={[1.1, 64]} /><meshStandardMaterial color={statusColor} transparent opacity={0.6} /></mesh>
      <OrbitControls target={[...simulatorCamera.target]} enablePan={false} minDistance={1} maxDistance={8} />
    </XR>
  </Canvas></SceneBoundary>
}
