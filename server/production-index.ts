import 'dotenv/config'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createProductionApp, attachProductionLifecycle, createFileLog } from './production.ts'
import { relayOptionsFromEnv } from './config.ts'
const port = Number(process.env.REALHERMES_PORT ?? 5173)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid production port')
const log = createFileLog(process.env.REALHERMES_LOG_FILE || join(homedir(), '.hermes', 'logs', 'realhermes-relay.log'))
const { app, dispose } = createProductionApp({ ...relayOptionsFromEnv(process.env), log, distPath: fileURLToPath(new URL('../dist', import.meta.url)) })
const server = app.listen(port, '127.0.0.1')
attachProductionLifecycle(server, dispose)
server.once('error', () => { void dispose(); process.exitCode = 1 })
