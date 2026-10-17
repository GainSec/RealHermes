import { expect, it } from 'vitest'
import { isCanvasPushToTalkPointer } from './pointerPushToTalk'

it('accepts a primary trigger click delivered to the headset canvas', () => {
  expect(isCanvasPushToTalkPointer({ button: 0, target: { tagName: 'CANVAS' } })).toBe(true)
})

it('ignores secondary buttons and non-canvas UI', () => {
  expect(isCanvasPushToTalkPointer({ button: 1, target: { tagName: 'CANVAS' } })).toBe(false)
  expect(isCanvasPushToTalkPointer({ button: 0, target: { tagName: 'BUTTON' } })).toBe(false)
})

it('uses bubble-phase down and capture-phase release so releasing over a panel ends an existing PTT hold', async () => {
  const { bindCanvasPushToTalk, consumeArtifactPointer } = await import('./pointerPushToTalk')
  const listeners = new Map<string, { handler: (event: any) => void; capture: boolean }>()
  const target = { addEventListener(name: string, handler: any, capture = false) { listeners.set(name, { handler, capture }) }, removeEventListener(name: string) { listeners.delete(name) } }
  const held = { current: false }; let starts = 0; let stops = 0
  const remove = bindCanvasPushToTalk(target, held, () => starts++, () => stops++)
  expect(listeners.get('pointerdown')?.capture).toBe(false)
  expect(listeners.get('pointerup')?.capture).toBe(true); expect(listeners.get('pointercancel')?.capture).toBe(true)
  const down = listeners.get('pointerdown')!.handler
  const pointer = { button: 0, target: { tagName: 'CANVAS' }, stopPropagation() {} }
  consumeArtifactPointer({ nativeEvent: pointer, stopPropagation() {} }); down(pointer)
  expect(starts).toBe(0)
  down({ button: 0, target: { tagName: 'CANVAS' } }); expect(starts).toBe(1); expect(held.current).toBe(true)
  listeners.get('pointerup')!.handler(pointer); expect(stops).toBe(1); expect(held.current).toBe(false)
  remove(); expect(listeners.size).toBe(0)
})
it('does not call preventDefault from a passive R3F pointer listener', async () => {
  const { consumeArtifactPointer } = await import('./pointerPushToTalk')
  let prevented = false
  consumeArtifactPointer({ stopPropagation() {}, nativeEvent: { stopPropagation() {}, preventDefault() { prevented = true } } })
  expect(prevented).toBe(false)
})
