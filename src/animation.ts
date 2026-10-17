import { idleClip } from './conversation'
type Action = { reset: () => { play: () => unknown }; stop: () => unknown }
export function startIdle(names: string[], actions: Record<string, Action | null | undefined>) {
  const name = idleClip(names); const action = name ? actions[name] : undefined
  action?.reset().play()
  return () => { action?.stop() }
}
