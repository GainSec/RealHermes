import { expect, it, vi } from 'vitest'
import { startIdle } from './animation'
it('autoplays the idle clip and stops it on cleanup', () => {
  const play = vi.fn(); const stop = vi.fn(); const reset = vi.fn(() => ({ play }))
  const cleanup = startIdle(['Walk', 'Idle'], { Idle: { reset, stop } })
  expect(reset).toHaveBeenCalledOnce(); expect(play).toHaveBeenCalledOnce()
  cleanup(); expect(stop).toHaveBeenCalledOnce()
})
it('autoplays the bundled unnamed animation and tolerates no clips', () => {
  const play = vi.fn(); const stop = vi.fn()
  startIdle(['Animation'], { Animation: { reset: () => ({ play }), stop } })
  expect(play).toHaveBeenCalledOnce(); expect(() => startIdle([], {})()).not.toThrow()
})
