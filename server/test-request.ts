import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Duplex } from 'node:stream'
import type { Express } from 'express'
// Exercise the actual Express pipeline without binding a port (restricted CI).
export default function request(app: Express, onResponse?: (res: ServerResponse) => void) {
  const run = (method: string, path: string) => {
    const headers: Record<string, string> = {}; let payload: unknown
    const chain = {
      set(name: string, value: string) { headers[name.toLowerCase()] = value; return chain },
      send(value: unknown) { payload = value; return chain },
      then(resolve: (value: { status: number; body: any; headers: Record<string, string> }) => unknown, reject?: (error: unknown) => unknown) {
        return new Promise<{ status: number; body: any; headers: Record<string, string> }>((done, fail) => {
          const req = new IncomingMessage(new Socket()); req.method = method; req.url = path
          const bytes = Buffer.isBuffer(payload) ? payload : payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload))
          if (payload && !Buffer.isBuffer(payload)) headers['content-type'] = 'application/json'
          headers['content-length'] = String(bytes.length); req.headers = headers
          const res = new ServerResponse(req); const chunks: Buffer[] = []
          const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
          res.assignSocket(socket as Socket)
          res.on('finish', () => {
            const responseHeaders = Object.fromEntries(Object.entries(res.getHeaders()).map(([k, v]) => [k, String(v)]))
            const raw = Buffer.concat(chunks); const body = raw.subarray(raw.indexOf('\r\n\r\n') + 4)
            done({ status: res.statusCode, headers: responseHeaders, body: responseHeaders['content-type']?.includes('json') ? JSON.parse(body.toString()) : body })
          }); res.on('error', fail)
          onResponse?.(res)
          app(req, res); req.push(bytes); req.push(null)
        }).then(resolve, reject)
      },
    }; return chain
  }
  return { get: (path: string) => run('GET', path), post: (path: string) => run('POST', path) }
}
