import { Box3 } from 'three'
import type { Object3D } from 'three'
export function groundOffset(scene: Object3D) { const box = new Box3().setFromObject(scene); return box.isEmpty() ? 0 : -box.min.y }
