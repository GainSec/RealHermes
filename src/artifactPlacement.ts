import type { ArtifactView } from './artifact'
import { changeArtifactPage } from './artifact'
import type { Placement } from './placement'
// An open artifact's own placement: where it opened plus bounded user offsets (metres) and scale.
// It is seeded once from the avatar placement; later avatar changes never move the artifact.
export type ArtifactPlacement = { home: readonly [number, number, number]; x: number; y: number; z: number; scale: number }
export type ArtifactAdjustment = 'left' | 'right' | 'up' | 'down' | 'nearer' | 'farther' | 'smaller' | 'larger' | 'reset'
export type OpenArtifact = { view: ArtifactView; placement: ArtifactPlacement }

// Beside and slightly behind the character so the whole panel fits the Frame's simulator canvas.
export function artifactHome(avatar: Placement): ArtifactPlacement {
  return { home: [1.05, avatar.height + 1.2, -avatar.distance - 0.6], x: 0, y: 0, z: 0, scale: 1 }
}
const steps = { left: ['x', -0.2], right: ['x', 0.2], down: ['y', -0.2], up: ['y', 0.2], smaller: ['scale', -0.25], larger: ['scale', 0.25] } as const
// The Frame wearer stands at the origin of the local-floor XR space, eyes about 1.6 m up, looking along -z.
const eyes = [0, 1.6, 0] as const
// Nearest the panel centre comes: a book's reading distance in front of the wearer, never into their face.
const reading = 0.45
const centimetres = (value: number) => Math.round(value * 100) / 100
// The panel centre stays inside the Frame's simulator view sideways and vertically, and in depth from 1.5 m beyond where
// it opened to the reading distance; the page stays between half and double size.
function boundsFrom([, , homeZ]: readonly [number, number, number]) {
  return { x: [-1.2, 0.6], y: [-0.6, 0.6], z: [-1.5, centimetres(eyes[2] - reading - homeZ)], scale: [0.5, 2] } as const
}
export function adjustArtifact(placement: ArtifactPlacement, adjustment: ArtifactAdjustment): ArtifactPlacement {
  if (adjustment === 'reset') return { home: placement.home, x: 0, y: 0, z: 0, scale: 1 }
  const bounds = boundsFrom(placement.home)
  const bound = (axis: 'x' | 'y' | 'z' | 'scale', value: number) => Math.min(bounds[axis][1], Math.max(bounds[axis][0], centimetres(value)))
  if (adjustment === 'nearer' || adjustment === 'farther') {
    // 0.3 m along the wearer's line of sight to the panel, so it comes toward them where they were looking, stopping on
    // that line at the depth bounds. The panel is always in front of the wearer (sight z < 0).
    const [x, y, z] = artifactPosition(placement), sight = [x - eyes[0], y - eyes[1], z - eyes[2]], distance = Math.hypot(...sight)
    const [homeX, homeY, homeZ] = placement.home
    // How far along the line of sight (1 is the panel now) the depth offset `offsetZ` lies.
    const along = (offsetZ: number) => (homeZ + offsetZ - eyes[2]) / sight[2]
    const t = Math.min(along(bounds.z[0]), Math.max(along(bounds.z[1]), (distance + (adjustment === 'nearer' ? -0.3 : 0.3)) / distance))
    // Whole centimetres, so repeated presses land exactly on the bounds.
    return { ...placement, x: bound('x', eyes[0] + sight[0] * t - homeX), y: bound('y', eyes[1] + sight[1] * t - homeY), z: bound('z', eyes[2] + sight[2] * t - homeZ) }
  }
  const [axis, step] = steps[adjustment]
  return { ...placement, [axis]: bound(axis, placement[axis] + step) }
}
export function canAdjustArtifact(placement: ArtifactPlacement, adjustment: ArtifactAdjustment) {
  const next = adjustArtifact(placement, adjustment)
  return next.x !== placement.x || next.y !== placement.y || next.z !== placement.z || next.scale !== placement.scale
}
export function artifactPosition({ home: [x, y, z], ...offset }: ArtifactPlacement): [number, number, number] {
  return [x + offset.x, y + offset.y, z + offset.z]
}
// Where a grab has put the panel (centre and uniform scale), within the button bounds and to the millimetre.
export function grabArtifact(placement: ArtifactPlacement, [x, y, z]: readonly [number, number, number], scale: number): ArtifactPlacement {
  // `|| 0` turns the -0 that rounding tiny negative noise gives into 0.
  const bound = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, Math.round(value * 1000) / 1000 || 0))
  const [homeX, homeY, homeZ] = placement.home, bounds = boundsFrom(placement.home)
  return { home: placement.home, x: bound(x - homeX, bounds.x), y: bound(y - homeY, bounds.y), z: bound(z - homeZ, bounds.z), scale: bound(scale, bounds.scale) }
}
// A grab ends after a different artifact may have opened or the panel closed; only the grabbed artifact moves.
export function placeArtifact(current: OpenArtifact | null, id: string, placement: ArtifactPlacement): OpenArtifact | null {
  return current?.view.id === id ? { ...current, placement } : current
}
// A different artifact opens at home beside the character; the same artifact keeps its placement.
export function showArtifact(current: OpenArtifact | null, view: ArtifactView | null, avatar: Placement): OpenArtifact | null {
  if (!view) return null
  return current?.view.id === view.id ? { ...current, view } : { view, placement: artifactHome(avatar) }
}
export function turnArtifactPage(current: OpenArtifact | null, delta: number): OpenArtifact | null {
  const view = changeArtifactPage(current?.view ?? null, delta)
  return current && view && { ...current, view }
}
