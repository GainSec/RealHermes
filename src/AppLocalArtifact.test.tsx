import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('./xr', () => ({ xrStore: {} }))
vi.mock('./Simulator', () => ({ default: () => <div>Simulator</div> }))
const captured = vi.hoisted(() => ({ completed: undefined as undefined | ((answer: string, artifact?: unknown) => unknown), open: vi.fn() }))
vi.mock('./conversation', async importOriginal => ({ ...await importOriginal<typeof import('./conversation')>(), Conversation: class {
  messages = []
  constructor(_services: unknown, _changed: unknown, completed: typeof captured.completed) { captured.completed = completed }
} }))
vi.mock('./artifact', async importOriginal => ({ ...await importOriginal<typeof import('./artifact')>(), createArtifactViewer: () => ({ open: captured.open, dismiss: () => {}, cancel: () => {} }) }))
import App from './App'
it('hands a completed answer’s local artifact to the in-world viewer', () => {
  renderToStaticMarkup(<App />)
  const artifact = { id: 'a'.repeat(32), kind: 'image', title: 'Numbix One.png', pageCount: 1 }
  captured.completed!('Here.', artifact)
  expect(captured.open).toHaveBeenCalledExactlyOnceWith('Here.', artifact)
})
