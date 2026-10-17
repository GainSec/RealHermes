export type Placement = { height: number; distance: number }
export const defaultPlacement: Placement = { height: 0, distance: 2 }
// Desktop simulator view; artifact layout tests project against this camera.
export const simulatorCamera = { position: [0, 1.5, 2], fov: 45, target: [0, 1, -2] } as const
