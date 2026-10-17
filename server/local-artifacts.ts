import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import type * as filesystem from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'

export type LocalArtifactKind = 'image' | 'pdf'
// Words from the user's request only; never a path. Discovery happens solely under configured roots.
export type LocalArtifactRequest = { terms: string[]; kinds: LocalArtifactKind[] }
export type LocalScanLimits = { maxDepth: number; maxDirectories: number; maxEntries: number; timeBudgetMs: number }
export const localScanDefaults: LocalScanLimits = { maxDepth: 8, maxDirectories: 2_000, maxEntries: 20_000, timeBudgetMs: 3_000 }
export const localMimes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' }

// Request reading: deterministic and deliberately narrow. Only an explicit local place ("on my file system",
// "from my computer", "my local screenshot") plus a find/show verb and an image/PDF noun is handled here;
// everything else, including web image requests, still goes to Hermes.
const places = String.raw`(?:file[\s-]?system|computer|mac(?:book)?|laptop|machine|(?:hard\s+)?(?:disk|drive)|ssd|files|folders?|directories|desktop|downloads(?:\s+folder)?|documents(?:\s+folder)?|pictures(?:\s+folder)?|photos\s+folder|approved\s+folders?)`
const placeCue = new RegExp(String.raw`\b(?:on|in|from|inside|within|across|off)\s+(?:my|the|this)\s+(?:local\s+)?${places}\b`, 'g')
const localCue = /\blocal(?=\s+(?:files?|images?|pictures?|pics?|photos?|photographs?|screenshots?|drawings?|pdfs?|documents?|copy|copies)\b)|\blocally\b/g
const vocative = /^\s*(?:(?:hey|hi|hello|ok|okay)\s+)?(?:2x4|two[\s-]+by[\s-]+four|hermes)\b[\s,:;.!-]*|[\s,]+(?:2x4|two[\s-]+by[\s-]+four|hermes)[\s?.!]*$/g
const action = /\b(?:find|show|open|display|view|pull\s+up|bring\s+up|let\s+me\s+see|look\s+for|search\s+for|locate|fetch|get|do\s+i\s+have|is\s+there|are\s+there)\b/
const display = /\b(?:show|open|display|view|pull\s+up|bring\s+up|let\s+me\s+see)\b/
const imageNoun = /\b(?:images?|pictures?|pics?|photos?|photographs?|screenshots?|drawings?|artwork|illustrations?|graphics?|renders?|png|jpe?g|webp)\b/
const pdfNoun = /\b(?:pdfs?|documents?)\b/
const fillers = new Set(('a an the of for to on in at by as from with and or but me my mine i im we our you your it its this that these those is are was were be been am ' +
  'can could would will should may might please kindly just also maybe some any all every there here where which what who whose how ' +
  'find show open display view pull bring up let see look looking search locate fetch get got have has had do does did ' +
  'called named titled labeled labelled showing shows depicting featuring about like saved stored kept somewhere anywhere copy copies ' +
  'image images picture pictures pic pics photo photos photograph photographs screenshot screenshots drawing drawings artwork illustration illustrations ' +
  'graphic graphics render renders png jpg jpeg webp pdf pdfs document documents file files thanks thank hey hi hello ok okay').split(' '))
export function parseLocalArtifactRequest(text: string): LocalArtifactRequest | undefined {
  const lower = text.toLowerCase().replace(/[‘’]/g, "'").replace(vocative, ' ')
  const placesNamed = lower.match(placeCue)?.join(' ') ?? ''
  if (!placesNamed && lower.search(localCue) < 0) return undefined
  const rest = lower.replace(placeCue, ' ').replace(localCue, ' ')
  if (!action.test(rest)) return undefined
  const kinds: LocalArtifactKind[] = []
  if (imageNoun.test(rest) || /\b(?:pictures|photos)\b/.test(placesNamed)) kinds.push('image')
  if (pdfNoun.test(rest)) kinds.push('pdf')
  if (!kinds.length && /\bfiles?\b/.test(rest) && display.test(rest)) kinds.push('image', 'pdf')
  if (!kinds.length) return undefined
  const terms = [...new Set(rest.split(/[^a-z0-9]+/).filter(word => word && !fillers.has(word)).map(word => word.slice(0, 40)))].slice(0, 6)
  return { terms, kinds }
}

// Approved roots are an explicit server setting: specific absolute folders, never the whole disk, the home
// folder or a parent of it, and never a hidden folder such as ~/.ssh or ~/.hermes.
export function parseLocalArtifactRoots(value: string | undefined, home = homedir()): string[] | undefined {
  const entries = (value ?? '').split(':').map(entry => entry.trim()).filter(Boolean)
  if (!entries.length) return undefined
  const invalid = () => new Error('Invalid REALHERMES_LOCAL_ARTIFACT_ROOTS')
  if (entries.length > 8) throw invalid()
  return entries.map(entry => {
    const path = entry.length > 1 ? entry.replace(/\/+$/, '') : entry
    if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path || path === sep || path === home || home.startsWith(path + sep) || path.split(sep).some(part => part.startsWith('.'))) throw invalid()
    return path
  })
}

// Name matching: words from file and folder names, numbers as digits or words, a copy counter ignored,
// and near spellings ("numbix" for "number") only for longer words sharing their first three letters.
const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const copyCounter = /\s*(?:\(\d+\)|\bcopy(?:\s+\d+)?)$/i
function words(name: string) {
  return name.replace(copyCounter, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}
function tokens(word: string) {
  const split = /^([a-z]+)(\d+)$/.exec(word)
  return split ? [word, split[1], split[2]] : [word]
}
function forms(word: string) {
  const values = [word]
  const index = numberWords.indexOf(word)
  if (index >= 0) values.push(String(index))
  else if (/^\d+$/.test(word) && Number(word) < numberWords.length) values.push(numberWords[Number(word)])
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) values.push(word.slice(0, -1))
  return values
}
function distance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = row
  }
  return previous[b.length]
}
const close = (a: string, b: string) => a.length >= 5 && b.length >= 5 && a.slice(0, 3) === b.slice(0, 3) && distance(a, b) <= 2
// 2 when a token equals one of the wanted forms, 1 when it is a near spelling, else 0.
function level(wanted: string[], list: string[], fuzzy = true) {
  const found = list.map(forms)
  if (found.some(values => values.some(value => wanted.includes(value)))) return 2
  return fuzzy && found.some(values => values.some(value => wanted.some(form => close(form, value)))) ? 1 : 0
}
export type LocalCandidate = { root: string; rootIndex: number; segments: string[]; mime: string; matched: number; score: number; extra: number; copy: boolean }
function rank(request: LocalArtifactRequest, root: string, rootIndex: number, segments: string[], mime: string): LocalCandidate | undefined {
  const { terms } = request
  if (!terms.length) return
  const name = segments.at(-1)!
  const base = name.slice(0, name.length - extname(name).length)
  const fileWords = words(base)
  const fileTokens = fileWords.flatMap(tokens); const folderTokens = segments.slice(0, -1).flatMap(words).flatMap(tokens)
  // A file-name match outranks a folder-name match; an exact word outranks a near spelling.
  const quality = (wanted: string[], fuzzy = true) => { const file = level(wanted, fileTokens, fuzzy); return file ? file + 2 : level(wanted, folderTokens, fuzzy) }
  const scores = terms.map(term => quality(forms(term)))
  // Adjacent words written together ("numberone") count only as an exact join.
  for (let index = 0; index + 1 < terms.length; index++) {
    const joined = quality(forms(terms[index]).flatMap(first => forms(terms[index + 1]).map(second => first + second)), false)
    if (joined) { scores[index] = Math.max(scores[index], joined); scores[index + 1] = Math.max(scores[index + 1], joined) }
  }
  const matched = scores.filter(Boolean).length
  if (matched < (terms.length <= 2 ? terms.length : Math.ceil(terms.length * 2 / 3))) return
  const wanted = terms.flatMap(forms)
  const extra = fileWords.filter(word => !level(wanted, tokens(word))).length
  return { root, rootIndex, segments, mime, matched, score: scores.reduce((total, value) => total + value, 0), extra, copy: copyCounter.test(base) }
}
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
// Most words matched, then best matches, then the most concise name, an original before its copies, shallowest, first root.
function best(candidates: LocalCandidate[]) {
  return candidates.sort((a, b) => b.matched - a.matched || b.score - a.score || a.extra - b.extra || Number(a.copy) - Number(b.copy) || a.segments.length - b.segments.length || a.rootIndex - b.rootIndex || order(a.segments.join('/'), b.segments.join('/')))
}

// Bounded breadth-first scan of approved roots: never hidden, system, vendor or build folders, app/library
// bundles, symlinks or special files; only real folders whose resolved path is still inside the root.
const skippedFolders = new Set(['node_modules', 'bower_components', 'vendor', '__pycache__', 'site-packages', 'venv', 'dist', 'build', 'coverage', 'target', 'library', 'system', 'applications', 'pods', 'deriveddata'])
const bundle = /\.(?:app|bundle|framework|photoslibrary|plugin|kext|xcarchive)$/i
type ScanOptions = { fs: typeof filesystem; signal: AbortSignal; limits: LocalScanLimits; now: () => number }
export async function findLocalArtifacts(roots: string[], request: LocalArtifactRequest, { fs, signal, limits, now }: ScanOptions) {
  const found: LocalCandidate[] = []
  let directories = 0; let entries = 0
  const deadline = now() + limits.timeBudgetMs
  for (const [rootIndex, configured] of roots.entries()) {
    const root = await fs.realpath(configured).catch(() => undefined)
    if (!root) continue
    const queue: string[][] = [[]]
    while (queue.length) {
      if (directories >= limits.maxDirectories || entries >= limits.maxEntries || now() >= deadline) return best(found)
      signal.throwIfAborted()
      const segments = queue.shift()!
      const path = join(root, ...segments)
      if (await fs.realpath(path).catch(() => undefined) !== path) continue
      directories++
      const listing: Dirent[] = []
      try { for await (const entry of await fs.opendir(path)) { listing.push(entry); if (++entries >= limits.maxEntries) break } }
      catch { continue }
      for (const entry of listing.sort((a, b) => order(a.name, b.name))) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          if (segments.length < limits.maxDepth && !skippedFolders.has(entry.name.toLowerCase()) && !bundle.test(entry.name)) queue.push([...segments, entry.name])
          continue
        }
        const mime = entry.isFile() ? localMimes[extname(entry.name).toLowerCase()] : undefined
        if (!mime || !request.kinds.includes(mime === 'application/pdf' ? 'pdf' : 'image')) continue
        const candidate = rank(request, root, rootIndex, [...segments, entry.name], mime)
        if (candidate) found.push(candidate)
      }
    }
  }
  return best(found)
}

// Read the chosen file without following a final symlink, then prove the opened file is still that path inside
// the root (a parent swapped for a symlink after the scan resolves elsewhere) and did not change while read.
export async function readLocalArtifact(fs: typeof filesystem, { root, segments }: LocalCandidate, maxBytes: number) {
  const path = join(root, ...segments)
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('Artifact unavailable')
    const real = await fs.realpath(path)
    const named = await fs.stat(real)
    if (real !== path || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('Artifact unavailable')
    const bytes = Buffer.alloc(stat.size + 1); let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) throw new Error('Artifact unavailable')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}

export type LocalArtifactResult =
  | { status: 'unconfigured' } | { status: 'none' } | { status: 'unavailable'; title: string }
  | { status: 'found'; matches: number; metadata: { id: string; kind: 'pdf' | 'image'; title: string; pageCount: number } }
// The spoken/visible answer for a local request: names only the chosen file, never a folder or path.
export function localArtifactAnswer(request: LocalArtifactRequest, result: LocalArtifactResult | undefined) {
  const what = request.kinds.length > 1 ? 'an image or PDF' : request.kinds[0] === 'pdf' ? 'a PDF' : 'an image'
  const shown = (title: string) => `“${title.replace(/\.(?:png|jpe?g|webp|pdf)$/i, '')}”`
  if (!result) return 'I couldn’t search your approved folders just now. Please ask again.'
  if (result.status === 'unconfigured') return 'Local file search isn’t set up yet. Add approved folders in the RealHermes server settings.'
  if (result.status === 'unavailable') return `I found ${shown(result.title)} but couldn’t open it. It may be too large or not a valid ${result.title.toLowerCase().endsWith('.pdf') ? 'PDF' : 'image'}.`
  if (result.status === 'found') {
    const more = result.matches > 1 ? ` It was the closest of ${result.matches} matches.` : ''
    return `Here’s ${result.metadata.kind === 'pdf' ? 'the PDF ' : ''}${shown(result.metadata.title)} from your approved folders.${more}`
  }
  return request.terms.length ? `I couldn’t find ${what} matching “${request.terms.join(' ')}” in your approved folders.` : `Tell me what ${what === 'a PDF' ? 'the PDF is' : 'the image shows'} or what it’s called, and I’ll look in your approved folders.`
}
