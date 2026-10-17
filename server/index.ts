import 'dotenv/config'
import { createApp } from './app.ts'
import { relayOptionsFromEnv } from './config.ts'
const port = Number(process.env.PORT ?? 3001)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
const app = createApp(relayOptionsFromEnv(process.env))
app.listen(port, '127.0.0.1', () => { console.log(`RealHermes relay listening on http://127.0.0.1:${port}`) })
