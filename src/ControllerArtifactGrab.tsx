import { useRef } from 'react'
import type { RefObject } from 'react'
import { Box3 } from 'three'
import type { Object3D, Vector3 } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useXRInputSourceEvent } from '@react-three/xr'
import { xrStore } from './xr'
import { controllerHit, controllerPosition } from './artifactController'
import { artifactPosition, grabArtifact } from './artifactPlacement'
import type { ArtifactPlacement } from './artifactPlacement'

type Button = 'select' | 'squeeze'
type Held = { session: XRSession; inputSource: XRInputSource; button: Button; hand: Vector3; from: Vector3; placement: ArtifactPlacement; next: ArtifactPlacement }
// A grip squeezed this close to the panel holds it wherever the controller points: @react-three/xr's grab pointer reach.
const reach = 0.07
const isControl = (object: Object3D | null): boolean => object != null && (object.name === 'Controls' || isControl(object.parent))

// XR controllers hold the panel like a book: the grip (squeeze) with the controller aimed at any part of the panel, its
// controls included, or held against it; or the trigger (select) aimed at the panel away from its controls, which the
// trigger still clicks. @react-three/xr's default controller cannot: its squeeze pointer reaches only 7 cm, and a trigger
// drag swings the panel on the wrist at the ray's length. While held, the panel follows the hand, upright and unscaled,
// within the placement bounds, and stays where it is released.
export function ControllerArtifactGrab({ panel, placement, onPlace }: { panel: RefObject<Object3D | null>; placement: ArtifactPlacement; onPlace: (placement: ArtifactPlacement) => void }) {
  const gl = useThree(state => state.gl)
  const held = useRef<Held | null>(null)
  const space = () => { const { origin, originReferenceSpace } = xrStore.getState(); return { reference: originReferenceSpace ?? gl.xr.getReferenceSpace(), origin } }
  const follow = (frame: XRFrame) => {
    const grab = held.current, target = panel.current, { reference, origin } = space()
    // A grab left by an ended session has nothing to follow.
    if (grab && frame.session !== grab.session) { held.current = null; return }
    const hand = grab && target && reference && controllerPosition(frame, grab.inputSource, reference, origin)
    if (!grab || !target || !hand) return
    grab.next = grabArtifact(grab.placement, grab.from.clone().add(hand).sub(grab.hand).toArray(), grab.placement.scale)
    target.position.set(...artifactPosition(grab.next))
  }
  const start = (button: Button) => (event: XRInputSourceEvent) => {
    const target = panel.current, { reference, origin } = space()
    if (held.current?.session === event.frame.session || !target || !reference || event.inputSource.targetRayMode !== 'tracked-pointer') return
    const hand = controllerPosition(event.frame, event.inputSource, reference, origin), hit = controllerHit(event, reference, target, origin)
    const grabs = button === 'select' ? hit && !isControl(hit) : hit || (hand && new Box3().setFromObject(target).expandByScalar(reach).containsPoint(hand))
    if (hand && grabs) held.current = { session: event.frame.session, inputSource: event.inputSource, button, hand, from: target.position.clone(), placement, next: placement }
  }
  const end = (button: Button) => (event: XRInputSourceEvent) => {
    const grab = held.current
    if (grab?.inputSource !== event.inputSource || grab.button !== button) return
    follow(event.frame); held.current = null
    onPlace(grab.next)
  }
  useXRInputSourceEvent('all', 'squeezestart', start('squeeze'), [placement])
  useXRInputSourceEvent('all', 'selectstart', start('select'), [placement])
  useXRInputSourceEvent('all', 'squeezeend', end('squeeze'), [onPlace])
  useXRInputSourceEvent('all', 'selectend', end('select'), [onPlace])
  useFrame((_state, _delta, frame) => { if (frame) follow(frame) })
  return null
}
