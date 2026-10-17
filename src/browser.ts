import type { Services } from './conversation'
import { localArtifactView } from './artifact'
import type { LocalArtifact } from './artifact'
import { readSSE, maxAnswerCharacters } from './sse'
// One 16-bit step. SteamVR standby gates the Frame's microphones, so recordings
// decode to exact zeros; at or below this there is no microphone signal at all.
const digitalSilence = 2 ** -15
type DecodedAudio = { numberOfChannels: number; getChannelData: (channel: number) => Float32Array }
export async function recordingPeak(audio: Blob, decode: (data: ArrayBuffer) => Promise<DecodedAudio> = data => new OfflineAudioContext(1, 1, 48_000).decodeAudioData(data)) {
  try {
    const decoded = await decode(await audio.arrayBuffer())
    let peak = 0
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) for (const sample of decoded.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample))
    return peak
  } catch { return undefined }
}
export function browserServices(fetcher: typeof fetch = fetch, peak: (audio: Blob) => Promise<number | undefined> = recordingPeak): Services {
  async function post(path: string, body: BodyInit, type: string, signal: AbortSignal = AbortSignal.timeout(65_000)) {
    const response = await fetcher(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': type }, body, signal })
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ?? 'Relay request failed') }
    return response
  }
  async function textResponse(response: Response) {
    const data = await response.json(); if (typeof data.text !== 'string') throw new Error('Invalid relay response'); return data.text as string
  }
  return {
    chat: async (text, onWorking, onArtifact) => {
      // Only the words go to Hermes: it decides for itself when the answer needs the wearer's current view.
      // The relay reports progress at least every 120 s (each Hermes request and each file check), so 125 s of
      // silence means it is gone; a long, still-progressing turn (a file link being checked or retried) stays alive.
      const deadline = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const quiet = () => { clearTimeout(timer); timer = setTimeout(() => deadline.abort(new Error('Hermes request timed out')), 125_000) }
      quiet()
      try {
        const response = await post('hermes/chat/stream', JSON.stringify({ text }), 'application/json', deadline.signal)
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Invalid relay stream')
        let answer = ''; let final: string | undefined; let done = false; let artifact: LocalArtifact | undefined
        for await (const frame of readSSE(response.body, deadline.signal)) {
          quiet()
          const data = JSON.parse(frame.data)
          if (!data || typeof data !== 'object' || Array.isArray(data) || done) throw new Error('Invalid relay stream')
          const keys = Object.keys(data)
          if (frame.event === 'error') throw new Error('Hermes request failed')
          if (frame.event === 'working' && keys.length === 0 && final === undefined) { onWorking?.(); continue }
          // The relay superseded the text so far (a file link it could not load); only what follows can be the answer.
          if (frame.event === 'reset' && keys.length === 0 && final === undefined && artifact === undefined) { answer = ''; continue }
          if (frame.event === 'artifact' && artifact === undefined && final === undefined) {
            const view = localArtifactView(data)
            if (!view) throw new Error('Invalid relay stream')
            artifact = { id: view.id, kind: view.kind, title: view.title, pageCount: view.pageCount }; continue
          }
          if (frame.event === 'text' && keys.length === 1 && typeof data.delta === 'string' && final === undefined) {
            answer += data.delta
            if (answer.length > maxAnswerCharacters) throw new Error('Relay answer too large')
            continue
          }
          if (frame.event === 'answer' && keys.length === 1 && typeof data.text === 'string' && data.text.trim() && data.text.length <= maxAnswerCharacters && final === undefined) {
            if (data.text !== answer) throw new Error('Invalid relay answer')
            final = data.text; continue
          }
          if (frame.event === 'done' && keys.length === 0 && final !== undefined) { done = true; continue }
          throw new Error('Invalid relay stream')
        }
        if (!done || final === undefined) throw new Error('Incomplete relay stream')
        // Only a complete answer may open its artifact.
        if (artifact) onArtifact?.(artifact)
        return final
      } finally { clearTimeout(timer) }
    },
    transcribe: async audio => {
      // Uploading silence returns a filtered STT hallucination, hiding a muted microphone.
      if ((await peak(audio) ?? 1) <= digitalSilence) throw new Error('Microphone returned digital silence. Wear the headset (standby mutes the Frame microphone) and speak while holding the trigger.')
      const mime_type = audio.type || 'audio/webm'
      const bytes = new Uint8Array(await audio.arrayBuffer())
      let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte)
      const data_url = `data:${mime_type};base64,${btoa(binary)}`
      return textResponse(await post('audio/transcribe', JSON.stringify({ data_url, mime_type }), 'application/json'))
    },
    speak: async (text, started) => {
      const data = await (await post('audio/speak', JSON.stringify({ text }), 'application/json')).json()
      if (typeof data.mime_type !== 'string' || !data.mime_type.startsWith('audio/') || typeof data.data_url !== 'string' || !data.data_url.startsWith(`data:${data.mime_type};base64,`) || !data.data_url.split(',')[1]) throw new Error('Invalid relay audio')
      const encoded = data.data_url.split(',')[1]
      try { if (btoa(atob(encoded)) !== encoded) throw Error() } catch { throw new Error('Invalid relay audio') }
      const audio = new Audio(data.data_url)
      try { await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve(); audio.onerror = () => reject(new Error('Audio playback failed'))
        audio.play().then(started, reject)
      }) } finally { audio.pause() }
    },
  }
}
export async function recordMicrophone(done: (blob: Blob) => void, error: (error: Error) => void) {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Microphone recording is unavailable. Use text instead.')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => stream.getTracks().forEach(track => track.stop())
  try {
    const recorder = new MediaRecorder(stream); const chunks: Blob[] = []; let cancelled = false
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    recorder.onstop = () => { clearTimeout(timer); release(); if (!cancelled) done(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })) }
    recorder.onerror = () => { cancelled = true; clearTimeout(timer); release(); error(new Error('Microphone recording failed')) }
    recorder.start()
    const stop = () => { if (recorder.state !== 'inactive') recorder.stop() }
    const timer = setTimeout(stop, 60_000)
    return { stop, cancel() { cancelled = true; clearTimeout(timer); stop(); release() } }
  } catch (cause) { release(); throw cause }
}
