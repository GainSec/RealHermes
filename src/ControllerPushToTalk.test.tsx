import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const subscriptions = vi.hoisted(() => [] as Array<{
  event: string
  handler: (event: { inputSource: { handedness: string; targetRayMode: string; gamepad?: object } }) => void
}>)

vi.mock('@react-three/xr', () => ({
  useXRInputSourceEvent: (_source: string, event: string, handler: (event: never) => void) => {
    subscriptions.push({ event, handler: handler as never })
  },
}))

import { ControllerPushToTalk } from './ControllerPushToTalk'

it('uses the right tracked controller trigger as hold-to-talk', () => {
  const start = vi.fn()
  const stop = vi.fn()
  renderToStaticMarkup(<ControllerPushToTalk onStart={start} onStop={stop} />)

  const selectStart = subscriptions.find(subscription => subscription.event === 'selectstart')!
  const selectEnd = subscriptions.find(subscription => subscription.event === 'selectend')!
  const rightController = { inputSource: { handedness: 'right', targetRayMode: 'tracked-pointer', gamepad: {} } }

  selectStart.handler(rightController)
  expect(start).toHaveBeenCalledOnce()
  selectEnd.handler(rightController)
  expect(stop).toHaveBeenCalledOnce()
})

it('ignores left controllers, gaze, and screen taps', () => {
  const start = vi.fn()
  const stop = vi.fn()
  renderToStaticMarkup(<ControllerPushToTalk onStart={start} onStop={stop} />)

  const selectStart = subscriptions.find(subscription => subscription.event === 'selectstart')!
  const selectEnd = subscriptions.find(subscription => subscription.event === 'selectend')!
  const ignored = [
    { inputSource: { handedness: 'left', targetRayMode: 'tracked-pointer', gamepad: {} } },
    { inputSource: { handedness: 'right', targetRayMode: 'gaze' } },
    { inputSource: { handedness: 'none', targetRayMode: 'screen' } },
  ]

  for (const event of ignored) {
    selectStart.handler(event)
    selectEnd.handler(event)
  }
  expect(start).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
})

it('suppresses XR selectstart over an artifact and preserves release for holds started elsewhere', () => {
  const start = vi.fn(); const stop = vi.fn(); let targeted = true
  renderToStaticMarkup(<ControllerPushToTalk onStart={start} onStop={stop} isArtifactTarget={() => targeted} />)
  const selectStart = subscriptions.at(-2)!; const selectEnd = subscriptions.at(-1)!
  const right = { inputSource: { handedness: 'right', targetRayMode: 'tracked-pointer', gamepad: {} } }
  selectStart.handler(right); selectEnd.handler(right)
  expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  targeted = false; selectStart.handler(right); expect(start).toHaveBeenCalledOnce()
  targeted = true; selectEnd.handler(right); expect(stop).toHaveBeenCalledOnce()
})
