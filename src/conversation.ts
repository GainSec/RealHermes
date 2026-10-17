import { extractArtifactUrls } from './artifact'
import type { LocalArtifact } from './artifact'
export type State = 'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'error'
// Hermes TTS deletes bare URLs, so a URL-only answer leaves nothing to say and synthesis fails.
// Speak a short description instead; the visible answer and artifact URL stay unchanged.
export function spokenText(answer: string) {
  if (!/https?:\/\//.test(answer) || /[\p{L}\p{N}]/u.test(answer.replace(/https?:\/\/\S+/g, ''))) return answer
  const url = extractArtifactUrls(answer)[0]
  return !url ? "Here's the link." : /\.pdf$/i.test(new URL(url).pathname) ? "Here's the PDF." : "Here's the image."
}
export type Message = { role: 'user' | 'assistant'; content: string }
export type Services = { chat: (text: string, onWorking?: () => void, onArtifact?: (artifact: LocalArtifact) => void) => Promise<string>; speak: (text: string, started: () => void) => Promise<void>; transcribe: (audio: Blob) => Promise<string> }
type Completed = (answer: string, artifact?: LocalArtifact) => void | Promise<void>
export class Conversation {
  messages: Message[] = []
  private busy = false
  private services: Services
  private changed: (state: State) => void
  private completed?: Completed
  constructor(services: Services, changed: (state: State) => void, completed?: Completed) { this.services = services; this.changed = changed; this.completed = completed }
  async send(text: string) {
    if (this.busy || !text.trim()) return
    this.busy = true; this.changed('thinking')
    const messages: Message[] = [...this.messages, { role: 'user', content: text.trim() }]
    try {
      let artifact: LocalArtifact | undefined
      const reply = await this.services.chat(text.trim(), () => this.changed('working'), found => { artifact = found })
      this.messages = [...messages, { role: 'assistant', content: reply }]
      // Viewing is best effort and never delays speech or changes conversation state.
      try { void Promise.resolve(artifact ? this.completed?.(reply, artifact) : this.completed?.(reply)).catch(() => {}) } catch { /* Keep the answer and speech available. */ }
      await this.services.speak(spokenText(reply), () => this.changed('speaking')); this.changed('idle')
    } catch (error) { this.changed('error'); throw error } finally { this.busy = false }
  }
  retry() { if (!this.busy) this.changed('idle') }
  // A turn in flight keeps its own state; the caller must not record over it.
  listen() { if (this.busy) return false; this.changed('listening'); return true }
  async recorded(audio: Blob) {
    if (this.busy) return
    this.busy = true; this.changed('thinking')
    try { const text = await this.services.transcribe(audio); this.busy = false; if (!text.trim()) throw new Error('No speech detected'); await this.send(text) }
    catch (error) { this.changed('error'); throw error } finally { this.busy = false }
  }
}
export async function capabilities(xr?: { isSessionSupported: (mode: 'immersive-ar' | 'immersive-vr') => Promise<boolean> }) {
  const supported = async (mode: 'immersive-ar' | 'immersive-vr') => { try { return await xr?.isSessionSupported(mode) ?? false } catch { return false } }
  const [ar, vr] = await Promise.all([supported('immersive-ar'), supported('immersive-vr')]); return { ar, vr }
}
export function idleClip(names: string[]) { return names.find(name => /idle/i.test(name)) ?? names[0] }
