import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('./xr', () => ({ xrStore: {} }))
const simulator = vi.hoisted(() => ({ props: {} as Record<string, unknown> }))
vi.mock('./Simulator', () => ({ default: (props: Record<string, unknown>) => { simulator.props = props; return <div>Simulator</div> }, defaultPlacement: { height: 0, distance: 2 } }))
import App, { PlacementControls } from './App'
it('gives the simulator the artifact handlers its panel needs, grab included, so the panel can render', () => {
  renderToStaticMarkup(<App />)
  for (const handler of ['onArtifactPage', 'onArtifactClose', 'onArtifactAdjust', 'onArtifactPlace']) expect(simulator.props[handler]).toBeTypeOf('function')
})
it('renders accessible text, microphone and explicitly gated XR controls', () => {
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('RealHermes'); expect(html).toContain('Message Hermes'); expect(html).toContain('Start microphone')
  expect(html).toContain('Hold the right controller trigger to talk')
  expect(html).toContain('Enter AR'); expect(html).toContain('Enter VR'); expect(html).toContain('Desktop simulator')
  expect(html).toContain('aria-live="polite"'); expect(html).toContain('disabled=""')
})

it('credits the author in the page footer with a link to gainsec.com', () => {
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('<footer>')
  expect(html).toContain('Made by <a href="https://gainsec.com/" target="_blank" rel="noreferrer">Jon “GainSec” Gaines</a> © 2026')
})

it('shows the existing height, distance, and reset controls', () => {
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('Character height'); expect(html).toContain('Character distance'); expect(html).toContain('Reset placement')
  expect(html).toContain('type="range"')
})

it('height and distance controls update placement and reset restores defaults', () => {
  const change = vi.fn()
  const tree = PlacementControls({ placement: { height: 0.5, distance: 3 }, onChange: change })
  const [height, distance, reset] = tree.props.children
  height.props.children[1].props.onChange({ target: { value: '1' } })
  expect(change).toHaveBeenLastCalledWith({ height: 1, distance: 3 })
  distance.props.children[1].props.onChange({ target: { value: '4' } })
  expect(change).toHaveBeenLastCalledWith({ height: 0.5, distance: 4 })
  reset.props.onClick(); expect(change).toHaveBeenLastCalledWith({ height: 0, distance: 2 })
})

// Where an artifact opens for the default avatar placement (height 0, distance 2).
const opened = { home: [1.05, 1.2, -2.6] as [number, number, number], x: 0, y: 0, z: 0, scale: 1 }
it('shows artifact notices and desktop controls in the stage footer overlay, not below the clipped canvas', async () => {
  const { StageFooter } = await import('./App')
  const artifact = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 2, sourceUrl: 'https://example.com/a.pdf', page: 1 }
  const props = { placement: { height: 0, distance: 2 }, onPlacement: () => {}, supported: { ar: false, vr: false }, onEnter: () => {}, onPage: () => {}, onClose: () => {}, onAdjust: () => {} }
  const viewing = renderToStaticMarkup(<StageFooter {...props} artifact={{ view: artifact, placement: opened }} notice="" />)
  expect(viewing).toContain('class="stage-footer"'); expect(viewing).toContain('Guide · 1 / 2'); expect(viewing).toContain('Close artifact')
  expect(viewing).toContain('aria-label="Reset artifact placement"')
  expect(viewing).not.toContain('Character height')
  const idle = renderToStaticMarkup(<StageFooter {...props} artifact={null} notice="Artifact could not be opened. The answer is still available." />)
  expect(idle).toContain('Character height'); expect(idle).toContain('Enter VR'); expect(idle).not.toContain('Close artifact')
  expect(idle).toMatch(/^<div class="stage-footer"><p class="artifact-notice" role="status">Artifact could not be opened/)
})

it('provides desktop artifact title, bounds paging, and close controls', async () => {
  const { ArtifactDesktopControls } = await import('./App')
  const artifact = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 2, sourceUrl: 'https://example.com/a.pdf', page: 1 }
  const onPage = vi.fn(); const onClose = vi.fn()
  const tree = ArtifactDesktopControls({ artifact, placement: opened, onPage, onClose, onAdjust: () => {} })
  expect(renderToStaticMarkup(tree)).toContain('Guide'); expect(renderToStaticMarkup(tree)).toContain('1 / 2')
  const [, previous, next, close] = tree.props.children
  expect(previous.props.disabled).toBe(true); expect(next.props.disabled).toBe(false)
  next.props.onClick(); expect(onPage).toHaveBeenCalledWith(1)
  close.props.onClick(); expect(onClose).toHaveBeenCalledTimes(1)
})
it('provides equivalent desktop placement controls, disabled where they cannot change anything', async () => {
  const { ArtifactDesktopControls } = await import('./App')
  const artifact = { id: 'a'.repeat(32), kind: 'pdf' as const, title: 'Guide', pageCount: 2, sourceUrl: 'https://example.com/a.pdf', page: 1 }
  const onAdjust = vi.fn(); const onPage = vi.fn(); const onClose = vi.fn()
  const buttons = (placement: typeof opened) => ArtifactDesktopControls({ artifact, placement, onPage, onClose, onAdjust }).props.children.find((child: any) => child?.props?.['aria-label'] === 'Artifact placement').props.children
  const button = (placement: typeof opened, label: string) => buttons(placement).find((child: any) => child.props['aria-label'] === label)
  for (const [label, adjustment] of [['Move artifact left', 'left'], ['Move artifact right', 'right'], ['Move artifact up', 'up'], ['Move artifact down', 'down'], ['Move artifact nearer', 'nearer'], ['Move artifact farther', 'farther'], ['Make artifact smaller', 'smaller'], ['Make artifact larger', 'larger'], ['Reset artifact placement', 'reset']]) {
    const control = button({ ...opened, x: -0.2 }, label)
    expect(control.props.disabled).toBe(false); control.props.onClick(); expect(onAdjust).toHaveBeenLastCalledWith(adjustment)
  }
  expect(onAdjust).toHaveBeenCalledTimes(9); expect(onPage).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
  expect(button(opened, 'Reset artifact placement').props.disabled).toBe(true)
  // At the reading distance, 0.45 m in front of the wearer, Nearer can bring it no closer.
  for (const label of ['Move artifact right', 'Move artifact down', 'Move artifact nearer', 'Make artifact larger']) expect(button({ ...opened, x: 0.6, y: -0.6, z: 2.15, scale: 2 }, label).props.disabled).toBe(true)
  expect(button({ ...opened, x: 0.6, y: -0.6, z: 0.9, scale: 2 }, 'Move artifact nearer').props.disabled).toBe(false)
  const html = renderToStaticMarkup(ArtifactDesktopControls({ artifact, placement: opened, onPage, onClose, onAdjust }))
  for (const text of ['←', '→', '↑', '↓', '>Nearer<', '>Farther<', '>Smaller<', '>Larger<', '>Reset<']) expect(html).toContain(text)
})
