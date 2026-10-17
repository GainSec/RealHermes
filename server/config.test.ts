import { expect, it } from 'vitest'

it('maps separate upstream environment settings and prefers HERMES_API_KEY', async () => {
  const { relayOptionsFromEnv } = await import('./config.ts')
  const home = '/home/example'
  expect(relayOptionsFromEnv({ HERMES_CHAT_BASE_URL: 'http://chat', HERMES_API_KEY: 'preferred', API_SERVER_KEY: 'fallback', HERMES_AUDIO_BASE_URL: 'http://audio', HERMES_AUDIO_SESSION_TOKEN: 'session', HERMES_BASE_URL: 'http://obsolete' }, { home })).toEqual({ chatBaseUrl: 'http://chat', apiKey: 'preferred', audioBaseUrl: 'http://audio', audioSessionToken: 'session' })
  expect(relayOptionsFromEnv({ API_SERVER_KEY: 'fallback', HERMES_API_KEY: '' }, { home }).apiKey).toBe('fallback')
  expect(relayOptionsFromEnv({}, { home })).toEqual({ chatBaseUrl: undefined, apiKey: undefined, audioBaseUrl: undefined, audioSessionToken: undefined })
})

it('dials the gateway bind address that pairs with the API_SERVER_KEY fallback when no chat URL is set', async () => {
  const { relayOptionsFromEnv } = await import('./config.ts')
  expect(relayOptionsFromEnv({ API_SERVER_KEY: 'k', API_SERVER_HOST: '192.0.2.10', API_SERVER_PORT: '8642' }).chatBaseUrl).toBe('http://192.0.2.10:8642')
  expect(relayOptionsFromEnv({ HERMES_CHAT_BASE_URL: 'http://chat', API_SERVER_HOST: '192.0.2.10' }).chatBaseUrl).toBe('http://chat')
  expect(relayOptionsFromEnv({ HERMES_CHAT_BASE_URL: '', API_SERVER_HOST: ' 0.0.0.0 ' }).chatBaseUrl).toBe('http://127.0.0.1:8642')
  expect(relayOptionsFromEnv({ API_SERVER_HOST: '::' }).chatBaseUrl).toBe('http://[::1]:8642')
  expect(relayOptionsFromEnv({ API_SERVER_HOST: '2001:db8::5', API_SERVER_PORT: '9000' }).chatBaseUrl).toBe('http://[2001:db8::5]:9000')
  expect(relayOptionsFromEnv({ API_SERVER_PORT: '9000' }).chatBaseUrl).toBe('http://127.0.0.1:9000')
  expect(relayOptionsFromEnv({ API_SERVER_HOST: 'gateway.example', API_SERVER_PORT: 'nope' }).chatBaseUrl).toBe('http://gateway.example:8642')
})

it('streams chat to the gateway that the launching environment configured', async () => {
  const { relayOptionsFromEnv } = await import('./config.ts')
  const { createApp } = await import('./app.ts')
  const { default: request } = await import('./test-request.ts')
  const urls: string[] = []
  const app = createApp({ ...relayOptionsFromEnv({ API_SERVER_KEY: 'k', API_SERVER_HOST: '192.0.2.10', API_SERVER_PORT: '8642' }), fetch: async url => { urls.push(String(url)); throw new Error('Unreachable') } })
  await request(app).post('/api/hermes/chat/stream').send({ text: 'Hello Hermes' })
  expect(urls).toEqual(['http://192.0.2.10:8642/v1/responses'])
})



it('approves local artifact folders only from the explicit server setting', async () => {
  const { relayOptionsFromEnv } = await import('./config.ts')
  const home = '/home/example'
  expect(relayOptionsFromEnv({ REALHERMES_LOCAL_ARTIFACT_ROOTS: '/home/example/Pictures/mascots:/Volumes/Shared/Art/' }, { home }).artifactOptions).toEqual({ localRoots: ['/home/example/Pictures/mascots', '/Volumes/Shared/Art'] })
  expect(relayOptionsFromEnv({}, { home }).artifactOptions).toBeUndefined()
  for (const value of ['/', '/home', '/home/example', 'Pictures/mascots', '/home/example/.hermes']) expect(() => relayOptionsFromEnv({ REALHERMES_LOCAL_ARTIFACT_ROOTS: value }, { home })).toThrow('Invalid REALHERMES_LOCAL_ARTIFACT_ROOTS')
})

it('gives PDF artifacts the Poppler tools found in the server environment', async () => {
  const { relayOptionsFromEnv } = await import('./config.ts')
  const tools = { pdfinfo: '/opt/poppler/bin/pdfinfo', pdftoppm: '/opt/poppler/bin/pdftoppm' }
  const searched: Array<string | undefined> = []
  const findPoppler = (env: NodeJS.ProcessEnv) => { searched.push(env.PATH); return tools }
  expect(relayOptionsFromEnv({ PATH: '/opt/poppler/bin:/usr/bin' }, { findPoppler }).artifactOptions).toEqual({ poppler: tools })
  expect(searched).toEqual(['/opt/poppler/bin:/usr/bin'])
  expect(relayOptionsFromEnv({ REALHERMES_LOCAL_ARTIFACT_ROOTS: '/srv/realhermes/approved' }, { home: '/home/example', findPoppler }).artifactOptions).toEqual({ localRoots: ['/srv/realhermes/approved'], poppler: tools })
  expect(relayOptionsFromEnv({ PATH: '/usr/bin' }, { findPoppler: () => undefined }).artifactOptions).toBeUndefined()
  // An explicit directory that cannot be used fails startup instead of silently disabling PDFs.
  expect(() => relayOptionsFromEnv({ REALHERMES_POPPLER_DIR: 'relative/bin' })).toThrow('Invalid REALHERMES_POPPLER_DIR')
})
