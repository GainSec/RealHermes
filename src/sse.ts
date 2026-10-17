// Shared framing only: neither side forwards unvalidated SSE payloads.
export async function* readSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal, maxEventBytes = 65536) {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let line = ''; let event = ''; let data: string[] = []; let size = 0; let skipLF = false
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      signal?.throwIfAborted()
      const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      for (const char of text) {
        if (skipLF) { skipLF = false; if (char === '\n') continue }
        const point = char.codePointAt(0)!
        size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
        if (size > maxEventBytes) throw new Error('SSE event too large')
        if (char !== '\r' && char !== '\n') { line += char; continue }
        skipLF = char === '\r'
        if (!line) {
          if (data.length) yield { event, data: data.join('\n') }
          event = ''; data = []; size = 0
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon)
          let value = colon < 0 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') event = value
          if (field === 'data') data.push(value)
        }
        line = ''
      }
      if (chunk.done) {
        if (line || data.length) throw new Error('Incomplete SSE event')
        return
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export const maxAnswerCharacters = 8000
