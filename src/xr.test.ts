import { expect, it, vi } from 'vitest'
vi.mock('@react-three/xr', () => ({ createXRStore: (options: unknown) => ({ options }) }))
import { xrStore } from './xr'
it('uses native capability gating without automatic XR emulation', () => { expect(xrStore).toEqual({ options: { emulate: false } }) })
