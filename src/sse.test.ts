import { expect, it, vi } from 'vitest'
import { readSSE } from './sse'
function source(wire: string) {
  const bytes = new TextEncoder().encode(wire)
  return new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } })
}
it.each(['\n', '\r', '\r\n'])('parses multiline data and comments across single-byte chunks (%j)', async newline => {
  const wire = [': keepalive', 'event: text', 'data: {', 'data: "delta":"😀"}', '', ''].join(newline)
  const frames = []
  for await (const frame of readSSE(source(wire))) frames.push(frame)
  expect(frames).toEqual([{ event: 'text', data: '{\n"delta":"😀"}' }])
})
it('cancels the reader when the consumer stops early', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {}\n\n')) }, cancel })
  for await (const frame of readSSE(body)) { expect(frame.data).toBe('{}'); break }
  expect(cancel).toHaveBeenCalledOnce()
})
