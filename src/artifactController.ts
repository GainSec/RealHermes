import { Matrix4, Raycaster, Vector3 } from 'three'
import type { Object3D } from 'three'
// An XR space's pose in this frame as a world matrix, through the XR origin.
function worldPose(frame: XRFrame, space: XRSpace, reference: XRReferenceSpace, origin?: Object3D) {
  const pose = frame.getPose(space, reference)
  if (!pose) return undefined
  const matrix = new Matrix4().fromArray(pose.transform.matrix)
  if (origin) { origin.updateWorldMatrix(true, false); matrix.premultiply(origin.matrixWorld) }
  return matrix
}
// The part of the artifact a controller's target ray hits first, if any. XR session events are independent of R3F
// propagation, so they are tested using the same target-ray pose and the real artifact geometry, not a hover flag.
export function controllerHit(event: XRInputSourceEvent, reference: XRReferenceSpace | null | undefined, artifact: Object3D | null, origin?: Object3D) {
  if (!artifact || !artifact.visible || !reference) return undefined
  const matrix = worldPose(event.frame, event.inputSource.targetRaySpace, reference, origin)
  if (!matrix) return undefined
  const raycaster = new Raycaster()
  raycaster.ray.origin.setFromMatrixPosition(matrix)
  raycaster.ray.direction.set(0, 0, -1).transformDirection(matrix)
  artifact.updateWorldMatrix(true, true)
  return raycaster.intersectObject(artifact, true)[0]?.object
}
// XR session selectstart gates push-to-talk on whether the controller aims at the artifact.
export function controllerTargetsArtifact(event: XRInputSourceEvent, reference: XRReferenceSpace | null | undefined, artifact: Object3D | null, origin?: Object3D) {
  return controllerHit(event, reference, artifact, origin) !== undefined
}
// Where a controller is held: its grip, or the origin of its target ray when it has no grip.
export function controllerPosition(frame: XRFrame, inputSource: XRInputSource, reference: XRReferenceSpace, origin?: Object3D) {
  const matrix = worldPose(frame, inputSource.gripSpace ?? inputSource.targetRaySpace, reference, origin)
  return matrix && new Vector3().setFromMatrixPosition(matrix)
}
