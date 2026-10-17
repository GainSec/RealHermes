export type ArtifactView = { id: string; kind: 'pdf' | 'image'; title: string; pageCount: number; sourceUrl?: string; page: number }
// What the relay sends for a file it has already loaded (from an approved local folder or a verified online link): an opaque ID and display fields, never a path or URL.
export type LocalArtifact = { id: string; kind: 'pdf' | 'image'; title: string; pageCount: number }
export function localArtifactView(data: unknown): ArtifactView | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const { id, kind, title, pageCount, ...extra } = data as Record<string, unknown>
  if (Object.keys(extra).length || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || (kind !== 'pdf' && kind !== 'image') || typeof title !== 'string' || !title || title.length > 160) return
  if (typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 500 || (kind === 'image' && pageCount !== 1)) return
  return { id, kind, title, pageCount, page: 1 }
}
export function extractArtifactUrls(answer: string): string[] {
  const urls = new Set<string>()
  for (const match of answer.matchAll(/https:\/\/(?:\[[^\]\s]+\]|[^\s<>"'`[\]]+)[^\s<>"'`[\]]*/g)) {
    // Preserve query punctuation inside explicit Markdown/angle destinations.
    let candidate = answer[match.index - 1] === '<' ? match[0] : match[0].replace(/[.,;!?]+$/, '')
    let excessClosers = (candidate.match(/\)/g)?.length ?? 0) - (candidate.match(/\(/g)?.length ?? 0)
    while (excessClosers > 0 && candidate.endsWith(')')) { candidate = candidate.slice(0, -1); excessClosers-- }
    try {
      const url = new URL(candidate)
      if (!url.username && !url.password && !url.port && /\.(pdf|png|jpe?g|webp)$/i.test(url.pathname)) {
        url.hash = ''; urls.add(url.href)
      }
    } catch { /* Ignore malformed explicit links. */ }
  }
  return [...urls]
}
export function artifactPageUrl(view: ArtifactView) { return `/api/artifacts/${view.id}/pages/${view.page}` }
export function changeArtifactPage(view: ArtifactView | null, delta: number): ArtifactView | null {
  return view ? { ...view, page: Math.max(1, Math.min(view.pageCount, view.page + delta)) } : null
}
export function closeArtifact() { return null }

// App owns the view. The relay sends an artifact only after it has loaded the file and rendered its first page, so the
// viewer opens exactly that, by opaque ID; it never fetches links from answer text itself.
export function createArtifactViewer(changed: (view: ArtifactView | null) => void, notice: (text: string) => void) {
  return {
    open(_answer: string, artifact?: LocalArtifact) {
      if (!artifact) { notice(''); return }
      const view = localArtifactView(artifact)
      if (view) { changed(view); notice('') } else notice('Artifact could not be opened. The answer is still available.')
    },
    dismiss() { changed(closeArtifact()); notice('') },
  }
}
