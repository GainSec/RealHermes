import { expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { adjustArtifact, artifactHome, artifactPosition, canAdjustArtifact, grabArtifact, placeArtifact, showArtifact, turnArtifactPage } from './artifactPlacement'
import type { ArtifactAdjustment, ArtifactPlacement } from './artifactPlacement'
import { defaultPlacement, simulatorCamera } from './placement'
const view = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 3, sourceUrl: 'https://example.com/a.pdf', page: 1 }
// Where an artifact opens for the default avatar placement (height 0, distance 2).
const home: ArtifactPlacement = { home: [1.05, 1.2, -2.6], x: 0, y: 0, z: 0, scale: 1 }
const press = (placement: ArtifactPlacement, adjustment: ArtifactAdjustment, times = 1) => Array.from({ length: times }).reduce<ArtifactPlacement>(current => adjustArtifact(current, adjustment), placement)
// The Frame wearer: standing at the origin of the local-floor XR space, eyes about 1.6 m up, looking along -z.
const eyes = new Vector3(0, 1.6, 0)
const centre = (placement: ArtifactPlacement) => new Vector3(...artifactPosition(placement))
const sightOf = (placement: ArtifactPlacement) => centre(placement).sub(eyes).normalize()

it('opens beside the character, seeded once from the avatar placement, and offsets from there', () => {
  expect(artifactHome({ height: 0.5, distance: 3 })).toEqual({ home: [1.05, 1.7, -3.6], x: 0, y: 0, z: 0, scale: 1 })
  const [x, y, z] = artifactPosition({ ...home, x: -0.4, y: 0.2, z: 0.3 })
  expect(x).toBeCloseTo(0.65); expect(y).toBeCloseTo(1.4); expect(z).toBeCloseTo(-2.3)
})
it('moves left/right/up/down, nearer/farther along the line of sight, and resizes in fixed steps', () => {
  expect(adjustArtifact(home, 'left')).toEqual({ ...home, x: -0.2 }); expect(adjustArtifact(home, 'right')).toEqual({ ...home, x: 0.2 })
  expect(adjustArtifact(home, 'up')).toEqual({ ...home, y: 0.2 }); expect(adjustArtifact(home, 'down')).toEqual({ ...home, y: -0.2 })
  for (const [adjustment, step] of [['nearer', -0.3], ['farther', 0.3]] as const) {
    const moved = adjustArtifact(home, adjustment)
    expect(centre(moved).distanceTo(eyes) - centre(home).distanceTo(eyes)).toBeCloseTo(step, 2); expect(sightOf(moved).angleTo(sightOf(home))).toBeLessThan(0.01); expect(moved.scale).toBe(1)
  }
  expect(adjustArtifact(home, 'larger')).toEqual({ ...home, scale: 1.25 }); expect(adjustArtifact(home, 'smaller')).toEqual({ ...home, scale: 0.75 })
})
it('clamps every control to its bounds and lands exactly on step multiples', () => {
  expect(press(home, 'left', 20).x).toBe(-1.2); expect(press(home, 'right', 20).x).toBe(0.6)
  expect(press(home, 'up', 20).y).toBe(0.6); expect(press(home, 'down', 20).y).toBe(-0.6)
  // Nearest: the centre 0.45 m in front of the wearer (z -0.45); farthest: 1.5 m behind where it opened.
  expect(press(home, 'nearer', 20).z).toBe(2.15); expect(press(home, 'farther', 20).z).toBe(-1.5)
  expect(press(home, 'larger', 20).scale).toBe(2); expect(press(home, 'smaller', 20).scale).toBe(0.5)
  // Plain float accumulation would give -0.6000000000000001 here; depth steps also stay in whole centimetres.
  expect(press(home, 'left', 3).x).toBe(-0.6)
  for (const { x, y, z } of [press(home, 'nearer', 3), press(home, 'farther', 3)]) for (const offset of [x, y, z]) expect(offset).toBe(Math.round(offset * 100) / 100)
})
it('brings the panel straight toward the wearer with repeated Nearer, 0.3 m a press, to a readable book-like 0.45 m in front of them', () => {
  const presses = Array.from({ length: 20 }).reduce<ArtifactPlacement[]>(steps => [...steps, adjustArtifact(steps.at(-1)!, 'nearer')], [home])
  const distances = presses.map(placement => centre(placement).distanceTo(eyes))
  // Along the wearer's line of sight to where it opened, so it stays where they were looking and keeps facing them.
  for (const placement of presses) { expect(sightOf(placement).angleTo(sightOf(home))).toBeLessThan(0.03); expect(placement.scale).toBe(1) }
  for (let index = 1; index <= 7; index++) expect(distances[index - 1] - distances[index]).toBeCloseTo(0.3, 1)
  const reading = presses[8]
  expect(artifactPosition(reading)[2]).toBeCloseTo(-0.45, 9); expect(distances[8]).toBeLessThan(0.5)
  // The old bound stopped it 1.7 m out; now it stops at reading distance and never comes into the wearer's face.
  expect(presses.at(-1)).toEqual(reading); expect(canAdjustArtifact(reading, 'nearer')).toBe(false)
  // Recovery: Farther takes it back out the same way, and Reset returns it to where it opened.
  const back = press(reading, 'farther')
  expect(centre(back).distanceTo(eyes) - distances[8]).toBeCloseTo(0.3, 2); expect(sightOf(back).angleTo(sightOf(home))).toBeLessThan(0.03)
  expect(adjustArtifact(reading, 'reset')).toEqual(home)
})
it('reports which controls can still change the placement', () => {
  const corner = { ...home, x: -1.2, y: 0.6, z: -1.5, scale: 2 }
  for (const adjustment of ['left', 'up', 'farther', 'larger'] as const) expect(canAdjustArtifact(corner, adjustment)).toBe(false)
  for (const adjustment of ['right', 'down', 'nearer', 'smaller', 'reset'] as const) expect(canAdjustArtifact(corner, adjustment)).toBe(true)
  expect(canAdjustArtifact(home, 'reset')).toBe(false); expect(canAdjustArtifact({ ...home, scale: 1.25 }, 'reset')).toBe(true)
})
it('resets to where the artifact opened, not to wherever the avatar is now', () => {
  const opened = artifactHome({ height: 0.5, distance: 3 })
  const moved = (['left', 'up', 'nearer', 'larger'] as const).reduce<ArtifactPlacement>((current, adjustment) => adjustArtifact(current, adjustment), opened)
  expect(adjustArtifact(moved, 'reset')).toEqual({ home: [1.05, 1.7, -3.6], x: 0, y: 0, z: 0, scale: 1 })
})
it('keeps the placement while paging one artifact and resets it when a different artifact opens', () => {
  const opened = showArtifact(null, view, { height: 0, distance: 2 })!
  expect(opened).toEqual({ view, placement: home })
  const moved = { ...opened, placement: { ...home, x: -0.4, scale: 1.5 } }
  const paged = turnArtifactPage(moved, 1)!
  expect(paged.view.page).toBe(2); expect(paged.placement).toEqual({ ...home, x: -0.4, scale: 1.5 })
  expect(turnArtifactPage(paged, -1)!.placement).toEqual({ ...home, x: -0.4, scale: 1.5 }); expect(turnArtifactPage(null, 1)).toBeNull()
  // The avatar has moved since; only a different artifact opens at the new home.
  expect(showArtifact(paged, { ...view, page: 1 }, { height: 1, distance: 4 })!.placement).toEqual({ ...home, x: -0.4, scale: 1.5 })
  const next = showArtifact(paged, { ...view, id: 'b'.repeat(32) }, { height: 1, distance: 4 })!
  expect(next).toEqual({ view: { ...view, id: 'b'.repeat(32) }, placement: { home: [1.05, 2.2, -4.6], x: 0, y: 0, z: 0, scale: 1 } })
  expect(showArtifact(next, null, { height: 1, distance: 4 })).toBeNull()
})
it('can never lose the panel: at every movement bound its centre stays in the visible Steam Frame canvas', () => {
  // Same measured Frame canvas and DOM overlays as the panel layout test.
  const width = 641, height = 543, heading = 62, footer = 144
  const camera = new PerspectiveCamera(simulatorCamera.fov, width / height)
  camera.position.set(...simulatorCamera.position); camera.lookAt(...simulatorCamera.target); camera.updateMatrixWorld()
  for (const horizontal of ['left', 'right'] as const) for (const vertical of ['up', 'down'] as const) for (const depth of ['nearer', 'farther'] as const) {
    const placement = press(press(press(artifactHome(defaultPlacement), horizontal, 20), vertical, 20), depth, 20)
    const centre = new Vector3(...artifactPosition(placement)).project(camera)
    const top = (1 - centre.y) / 2 * height
    expect(Math.abs(centre.x)).toBeLessThanOrEqual(1); expect(top).toBeGreaterThanOrEqual(heading); expect(top).toBeLessThanOrEqual(height - footer)
  }
})
it('places a grabbed panel at its offset from home in whole millimetres, so handle float noise never reaches the placement', () => {
  expect(grabArtifact(home, [1.35, 1, -2.3], 1.5)).toEqual({ ...home, x: 0.3, y: -0.2, z: 0.3, scale: 1.5 })
  expect(grabArtifact(home, [1.05 + 1e-9, 1.2, -2.6], 1.0000001)).toEqual(home)
  expect(grabArtifact(home, [1.05 - 1e-9, 1.2 - 1e-9, -2.6 - 1e-9], 1)).toEqual(home)
})
it('clamps a grab to the same bounds as the buttons and follows it again once it is back inside', () => {
  // Pulled into or past the wearer's face, the panel stops at the reading distance, 0.45 m in front of them.
  expect(grabArtifact(home, [9, 9, 9], 9)).toEqual({ ...home, x: 0.6, y: 0.6, z: 2.15, scale: 2 })
  expect(artifactPosition(grabArtifact(home, [0.1, 1.5, -0.2], 1))[2]).toBeCloseTo(-0.45, 9)
  expect(grabArtifact(home, [-9, -9, -9], 0.1)).toEqual({ ...home, x: -1.2, y: -0.6, z: -1.5, scale: 0.5 })
  expect(grabArtifact(home, [1.25, 1.3, -2.5], 1.2)).toEqual({ ...home, x: 0.2, y: 0.1, z: 0.1, scale: 1.2 })
})
it('moves only the grabbed artifact, keeps that placement through paging and buttons, and resets it to home', () => {
  const opened = showArtifact(null, view, defaultPlacement)!
  const grabbed = placeArtifact(opened, view.id, { ...home, x: -0.35, z: 0.42, scale: 1.7 })!
  expect(grabbed).toEqual({ view, placement: { ...home, x: -0.35, z: 0.42, scale: 1.7 } })
  // A late update from a grab of an artifact that has since been replaced or closed changes nothing.
  expect(placeArtifact(grabbed, 'b'.repeat(32), home)).toBe(grabbed); expect(placeArtifact(null, view.id, home)).toBeNull()
  const paged = turnArtifactPage(grabbed, 1)!
  expect(paged.view.page).toBe(2); expect(paged.placement).toEqual({ ...home, x: -0.35, z: 0.42, scale: 1.7 })
  // Buttons continue from wherever the grab left the panel; Reset returns it to where it opened.
  expect(adjustArtifact(paged.placement, 'right')).toEqual({ ...home, x: -0.15, z: 0.42, scale: 1.7 })
  expect(adjustArtifact(paged.placement, 'larger').scale).toBe(1.95)
  expect(canAdjustArtifact(paged.placement, 'reset')).toBe(true); expect(adjustArtifact(paged.placement, 'reset')).toEqual(home)
  expect(showArtifact(paged, { ...view, id: 'b'.repeat(32) }, defaultPlacement)!.placement).toEqual(home)
})
