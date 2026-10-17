import { expect, it } from 'vitest'
import { Group, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three'
import { controllerTargetsArtifact } from './artifactController'
it('hit-tests the actual XR controller ray against the artifact, allowing PTT when aimed elsewhere', () => {
  const panel = new Group(); panel.position.set(1.3, 1.2, -2)
  panel.add(new Mesh(new PlaneGeometry(1.72, 2.18), new MeshBasicMaterial()))
  const reference = {} as XRReferenceSpace
  const event = (x: number) => ({ inputSource: { targetRaySpace: {} }, frame: { getPose: (_space: XRSpace, received: XRReferenceSpace) => {
    expect(received).toBe(reference)
    return { transform: { matrix: new Matrix4().makeTranslation(x, 1.2, 0).toArray() } }
  } } }) as unknown as XRInputSourceEvent
  expect(controllerTargetsArtifact(event(1.3), reference, panel)).toBe(true)
  expect(controllerTargetsArtifact(event(0), reference, panel)).toBe(false)
  expect(controllerTargetsArtifact(event(1.3), reference, null)).toBe(false)
  expect(controllerTargetsArtifact(event(1.3), null, panel)).toBe(false)
})
it('accounts for the XR origin transform without changing avatar placement', () => {
  const panel = new Group(); panel.position.set(4, 1.2, -2); panel.add(new Mesh(new PlaneGeometry(1.7, 2), new MeshBasicMaterial()))
  const origin = new Group(); origin.position.x = 4
  const event = { inputSource: { targetRaySpace: {} }, frame: { getPose: () => ({ transform: { matrix: new Matrix4().makeTranslation(0, 1.2, 0).toArray() } }) } } as unknown as XRInputSourceEvent
  expect(controllerTargetsArtifact(event, {} as XRReferenceSpace, panel, origin)).toBe(true)
})
