import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Create .env from .env.example once, readable only by its owner. An existing .env, or a symlink at that path, is
// never opened for writing, so credentials already filled in can never be overwritten.
export async function initEnv(root) {
  let example
  try { example = await readFile(join(root, '.env.example')) }
  catch { throw new Error('.env.example not found; run this from the repository root.') }
  try { await writeFile(join(root, '.env'), example, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code === 'EEXIST') return 'exists'; throw error }
  return 'created'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await initEnv(fileURLToPath(new URL('..', import.meta.url)))
    console.log(result === 'created' ? 'Created .env from .env.example with owner-only permissions. Fill in your values, then run npm run doctor.' : '.env already exists; left unchanged.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
