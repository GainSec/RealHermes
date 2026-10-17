import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

// Absolute paths of the two Poppler executables that count and rasterize PDF pages. They are found once at
// startup and later run with execFile and fixed arguments, never through a shell.
export type PopplerTools = { pdfinfo: string; pdftoppm: string }
export function isExecutableFile(path: string) {
  try { if (!statSync(path).isFile()) return false; accessSync(path, constants.X_OK); return true } catch { return false }
}
const toolsIn = (dir: string): PopplerTools => ({ pdfinfo: join(dir, 'pdfinfo'), pdftoppm: join(dir, 'pdftoppm') })
// An explicit REALHERMES_POPPLER_DIR must hold both tools, or startup fails; otherwise use the first absolute PATH
// directory that does. Empty and relative PATH entries resolve against the working directory, so they are skipped.
// No tools leaves PDF artifacts unavailable while images keep working.
export function findPoppler(env: { PATH?: string; REALHERMES_POPPLER_DIR?: string }, isExecutable: (path: string) => boolean = isExecutableFile): PopplerTools | undefined {
  const usable = (tools: PopplerTools) => isExecutable(tools.pdfinfo) && isExecutable(tools.pdftoppm)
  const configured = env.REALHERMES_POPPLER_DIR?.trim()
  if (configured) {
    const dir = configured.length > 1 ? configured.replace(/\/+$/, '') : configured
    const tools = toolsIn(dir)
    if (!isAbsolute(dir) || dir.includes('\0') || resolve(dir) !== dir || !usable(tools)) throw new Error('Invalid REALHERMES_POPPLER_DIR')
    return tools
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const tools = toolsIn(dir)
    if (usable(tools)) return tools
  }
}
