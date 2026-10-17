import { useRef } from 'react'
import { useXRInputSourceEvent } from '@react-three/xr'

type ControllerPushToTalkProps = {
  onStart: () => void
  onStop: () => void
  isArtifactTarget?: (event: XRInputSourceEvent) => boolean
}

function isRightController(inputSource: XRInputSource) {
  return inputSource.handedness === 'right'
    && inputSource.targetRayMode === 'tracked-pointer'
    && inputSource.gamepad != null
}

export function ControllerPushToTalk({ onStart, onStop, isArtifactTarget }: ControllerPushToTalkProps) {
  const held = useRef(false)
  useXRInputSourceEvent('all', 'selectstart', event => {
    if (isRightController(event.inputSource) && !isArtifactTarget?.(event)) { held.current = true; onStart() }
  }, [onStart, isArtifactTarget])
  useXRInputSourceEvent('all', 'selectend', event => {
    if (isRightController(event.inputSource) && held.current) { held.current = false; onStop() }
  }, [onStop])
  return null
}
