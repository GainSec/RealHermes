const artifactPointers = new WeakSet<object>()

// R3F stopPropagation only stops its own scene traversal. Also consume the
// original DOM event before the canvas pointer bubbles to App's window listener.
export function consumeArtifactPointer(event: { stopPropagation: () => void; nativeEvent: object & { stopPropagation?: () => void; stopImmediatePropagation?: () => void; preventDefault?: () => void } }) {
  artifactPointers.add(event.nativeEvent)
  event.stopPropagation()
  event.nativeEvent.stopPropagation?.()
  // drei connects OrbitControls to the canvas after the Simulator's PointerEvents, so only this keeps an artifact press
  // from also starting a camera orbit. XR session events (with inputSource) are left alone: the
  // @react-three/xr input and PTT listeners on the session must still receive them.
  if (!('inputSource' in event.nativeEvent)) event.nativeEvent.stopImmediatePropagation?.()
}

export type PushToTalkPointer = {
  defaultPrevented?: boolean
  button: number
  target: EventTarget | { tagName?: string } | null
}

export function isCanvasPushToTalkPointer(event: PushToTalkPointer) {
  return !artifactPointers.has(event) && !event.defaultPrevented && event.button === 0
    && 'tagName' in (event.target ?? {})
    && (event.target as { tagName?: string }).tagName === 'CANVAS'
}

export function bindCanvasPushToTalk(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, held: { current: boolean }, onStart: () => void, onStop: () => void) {
  const down = (event: PointerEvent) => {
    if (held.current || !isCanvasPushToTalkPointer(event)) return
    held.current = true; onStart()
  }
  const up = () => {
    if (!held.current) return
    held.current = false; onStop()
  }
  target.addEventListener('pointerdown', down)
  // A hold started outside the panel must still end if release hits a control.
  target.addEventListener('pointerup', up, true)
  target.addEventListener('pointercancel', up, true)
  return () => {
    target.removeEventListener('pointerdown', down)
    target.removeEventListener('pointerup', up, true)
    target.removeEventListener('pointercancel', up, true)
  }
}
