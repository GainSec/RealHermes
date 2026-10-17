import { expect, it } from 'vitest'
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import { groundOffset } from './model'
it('places centered model feet on the ground without changing the animated scene', () => {
  const scene = new Group(); scene.add(new Mesh(new BoxGeometry(1, 2, 1), new MeshBasicMaterial()))
  expect(groundOffset(scene)).toBe(1); expect(scene.position.y).toBe(0)
})
