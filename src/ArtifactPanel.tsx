import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Text } from '@react-three/drei'
import { Handle } from '@react-three/handle'
import { DoubleSide } from 'three'
import type { Group, Texture } from 'three'
import { loadArtifactTexture } from './artifactTexture'
import type { ArtifactView } from './artifact'
import { artifactPageUrl } from './artifact'
import { artifactPosition, canAdjustArtifact, grabArtifact } from './artifactPlacement'
import type { ArtifactAdjustment, ArtifactPlacement } from './artifactPlacement'
import { consumeArtifactPointer } from './pointerPushToTalk'
import { ControllerArtifactGrab } from './ControllerArtifactGrab'
type Props = { view: ArtifactView; placement: ArtifactPlacement; onPage: (delta: number) => void; onClose: () => void; onAdjust: (adjustment: ArtifactAdjustment) => void }
// XR grab pointers (a squeezed controller or a pinch near a control) pass over controls, so they never click them.
const notGrabbable = { deny: 'grab' } as const

export function ArtifactImage({ view }: { view: ArtifactView }) {
  const url = artifactPageUrl(view)
  const [loaded, setLoaded] = useState<{ url: string; texture: Texture } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController(); let current: Texture | undefined; let cancelled = false
    setFailed(null)
    const timer = setTimeout(() => controller.abort(), 35_000)
    void loadArtifactTexture(view, controller.signal).then(texture => {
      current = texture
      if (cancelled) texture.dispose()
      else { setFailed(null); setLoaded({ url, texture }) }
    }).catch(() => { if (!cancelled) setFailed(url) }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); current?.dispose() }
    // The opaque URL uniquely identifies the image and page.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  if (failed === url) return <Text fontSize={0.075} maxWidth={1.4} color="#ffc6a0" textAlign="center">Page unavailable. Try another page or close.</Text>
  if (!loaded || loaded.url !== url) return <Text fontSize={0.09} color="#d8e6e9">Loading page…</Text>
  const image = loaded.texture.image as ImageBitmap
  const scale = Math.min(1.5 / image.width, 1.35 / image.height)
  // Raised to clear the two control rows below it.
  return <mesh position={[0, 0.08, 0.02]}><planeGeometry args={[image.width * scale, image.height * scale]} /><meshBasicMaterial map={loaded.texture} side={DoubleSide} toneMapped={false} /></mesh>
}
// Placement row, left to right: name, adjustment, width, gap before, and arrow direction (radians) for moves.
const placementRow = (() => {
  let right = -0.81
  const row: Array<[string, ArtifactAdjustment, number, number, number?]> = [['Left', 'left', 0.11, 0, Math.PI], ['Right', 'right', 0.11, 0.01, 0], ['Up', 'up', 0.11, 0.01, Math.PI / 2], ['Down', 'down', 0.11, 0.01, -Math.PI / 2], ['Nearer', 'nearer', 0.2, 0.03], ['Farther', 'farther', 0.22, 0.01], ['Smaller', 'smaller', 0.23, 0.03], ['Larger', 'larger', 0.2, 0.01], ['Reset', 'reset', 0.18, 0.03]]
  return row.map(([name, adjustment, width, gap, arrow]) => { right += gap + width; return { name, adjustment, width, arrow, x: right - width / 2 } })
})()
export function ArtifactControls({ view, placement, onPage, onClose, onAdjust }: Props) {
  const control = (name: string, x: number, y: number, width: number, enabled: boolean, action: () => void, label: (color: string) => ReactNode) => <mesh key={name} name={name} position={[x, y, 0.04]} pointerEventsType={notGrabbable} onPointerDown={consumeArtifactPointer} onClick={event => { consumeArtifactPointer(event); if (enabled) action() }}>
    <boxGeometry args={[width, 0.18, 0.025]} /><meshBasicMaterial color={enabled ? '#345c72' : '#26333b'} />
    {label(enabled ? '#ffffff' : '#8c9aa3')}
  </mesh>
  const text = (label: string, fontSize: number) => (color: string) => <Text position={[0, 0, 0.02]} fontSize={fontSize} color={color}>{label}</Text>
  // Drawn rather than typed, so arrows never depend on fetching a symbol font.
  const arrow = (angle: number) => (color: string) => <mesh position={[0, 0, 0.02]} rotation={[0, 0, angle]}><circleGeometry args={[0.04, 3]} /><meshBasicMaterial color={color} /></mesh>
  // Named so a controller trigger aimed here clicks the control rather than grabbing the panel.
  return <group name="Controls">
    {control('Previous', -0.61, -0.725, 0.4, view.page > 1, () => onPage(-1), text('Previous', 0.064))}
    <Text position={[-0.25, -0.725, 0.04]} fontSize={0.064} color="#bdd0df">{`${view.page} / ${view.pageCount}`}</Text>
    {control('Next', 0.11, -0.725, 0.4, view.page < view.pageCount, () => onPage(1), text('Next', 0.064))}
    {control('Close', 0.63, -0.725, 0.36, true, onClose, text('Close', 0.064))}
    {placementRow.map(({ name, adjustment, width, arrow: angle, x }) => control(name, x, -0.95, width, canAdjustArtifact(placement, adjustment), () => onAdjust(adjustment), angle === undefined ? text(name, 0.055) : arrow(angle)))}
  </group>
}
export function ArtifactPanel({ view, placement, onPage, onClose, onAdjust, onPlace }: Props & { onPlace: (id: string, placement: ArtifactPlacement) => void }) {
  // This panel's own ref: once it unmounts the ref is empty, so an unfinished grab cannot move a newer panel.
  const ref = useRef<Group>(null)
  // Panel and controls move and scale together as one object from where the artifact opened.
  return <group ref={ref} position={artifactPosition(placement)} scale={placement.scale} onPointerDown={consumeArtifactPointer} onClick={consumeArtifactPointer}>
    {/* For mouse, touch and pen, the surface, title and page are the grab handle; the controls sit outside it. One
        primary press moves the whole panel and two scale it, within the button bounds. It never rotates, so the page
        stays upright facing the user. Presses carry on to the group above, which keeps them from canvas PTT and the
        camera orbit. XR controller presses (session events, with an input source) are ControllerArtifactGrab's. */}
    <Handle targetRef={ref} rotate={false} scale={{ uniform: true }} filter={event => event.button === 0 && !('inputSource' in event.nativeEvent)} stopPropagation={false} apply={(state, target) => {
      const next = grabArtifact(placement, state.current.position.toArray(), state.current.scale.x)
      target.position.set(...artifactPosition(next)); target.scale.setScalar(next.scale)
      if (state.last) onPlace(view.id, next)
    }}>
      <mesh name="Surface"><planeGeometry args={[1.72, 2.18]} /><meshBasicMaterial color="#12232e" side={DoubleSide} /></mesh>
      <Text position={[0, 0.92, 0.04]} fontSize={0.08} maxWidth={1.52} color="#ffffff" textAlign="center">{view.title.length > 60 ? `${view.title.slice(0, 57)}…` : view.title}</Text>
      <ArtifactImage key={view.id} view={view} />
    </Handle>
    <ArtifactControls view={view} placement={placement} onPage={onPage} onClose={onClose} onAdjust={onAdjust} />
    <ControllerArtifactGrab panel={ref} placement={placement} onPlace={next => onPlace(view.id, next)} />
  </group>
}
