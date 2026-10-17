import { useEffect, useRef, useState } from 'react'
import Simulator from './Simulator'
import { defaultPlacement } from './placement'
import type { Placement } from './placement'
import { xrStore } from './xr'
import { capabilities, Conversation } from './conversation'
import type { State } from './conversation'
import { browserServices, recordMicrophone } from './browser'
import { bindCanvasPushToTalk } from './pointerPushToTalk'
import { createArtifactViewer } from './artifact'
import type { ArtifactView } from './artifact'
import { adjustArtifact, canAdjustArtifact, placeArtifact, showArtifact, turnArtifactPage } from './artifactPlacement'
import type { ArtifactAdjustment, ArtifactPlacement, OpenArtifact } from './artifactPlacement'
import './App.css'

export function PlacementControls({ placement, onChange }: { placement: Placement; onChange: (placement: Placement) => void }) {
  return <div className="placement-controls">
    <label>Character height <input aria-label="Character height" type="range" min="-1" max="2" step="0.05" value={placement.height} onChange={event => onChange({ ...placement, height: Number(event.target.value) })} /></label>
    <label>Character distance <input aria-label="Character distance" type="range" min="0.5" max="6" step="0.1" value={placement.distance} onChange={event => onChange({ ...placement, distance: Number(event.target.value) })} /></label>
    <button type="button" onClick={() => onChange({ ...defaultPlacement })}>Reset placement</button>
  </div>
}
// Visible text and accessible name of each placement button, matching the in-world controls.
const placementButtons: Array<[ArtifactAdjustment, string, string]> = [['left', '←', 'Move artifact left'], ['right', '→', 'Move artifact right'], ['up', '↑', 'Move artifact up'], ['down', '↓', 'Move artifact down'], ['nearer', 'Nearer', 'Move artifact nearer'], ['farther', 'Farther', 'Move artifact farther'], ['smaller', 'Smaller', 'Make artifact smaller'], ['larger', 'Larger', 'Make artifact larger'], ['reset', 'Reset', 'Reset artifact placement']]
export function ArtifactDesktopControls({ artifact, placement, onPage, onClose, onAdjust }: { artifact: ArtifactView; placement: ArtifactPlacement; onPage: (delta: number) => void; onClose: () => void; onAdjust: (adjustment: ArtifactAdjustment) => void }) {
  return <div className="artifact-controls" aria-label="Artifact controls">
    <span>{artifact.title} · {artifact.page} / {artifact.pageCount}</span>
    <button type="button" disabled={artifact.page <= 1} onClick={() => onPage(-1)}>Previous page</button>
    <button type="button" disabled={artifact.page >= artifact.pageCount} onClick={() => onPage(1)}>Next page</button>
    <button type="button" onClick={onClose}>Close artifact</button>
    <div className="artifact-placement" role="group" aria-label="Artifact placement">{placementButtons.map(([adjustment, text, label]) => <button key={adjustment} type="button" aria-label={label} disabled={!canAdjustArtifact(placement, adjustment)} onClick={() => onAdjust(adjustment)}>{text}</button>)}</div>
  </div>
}
// The canvas fills the clipped stage, so stage controls and notices must live in this overlay.
export function StageFooter({ artifact, notice, placement, onPlacement, supported, onEnter, onPage, onClose, onAdjust }: { artifact: OpenArtifact | null; notice: string; placement: Placement; onPlacement: (placement: Placement) => void; supported: { ar: boolean; vr: boolean }; onEnter: (mode: 'ar' | 'vr') => void; onPage: (delta: number) => void; onClose: () => void; onAdjust: (adjustment: ArtifactAdjustment) => void }) {
  return <div className="stage-footer">
    {notice && <p className="artifact-notice" role="status">{notice}</p>}
    {artifact ? <ArtifactDesktopControls artifact={artifact.view} placement={artifact.placement} onPage={onPage} onClose={onClose} onAdjust={onAdjust} /> : <><PlacementControls placement={placement} onChange={onPlacement} /><p>Meet Hermes in your space.</p><div className="xr-controls"><button disabled={!supported.ar} onClick={() => onEnter('ar')}>Enter AR</button><button disabled={!supported.vr} onClick={() => onEnter('vr')}>Enter VR</button></div><small>{supported.ar || supported.vr ? 'Choose a mode to enter an immersive session.' : 'AR / VR unavailable on this device. Explore with the desktop simulator.'}</small></>}
  </div>
}
function App() {
  const [placement, setPlacement] = useState<Placement>(defaultPlacement)
  const [state, setState] = useState<State>('idle')
  const [input, setInput] = useState(''); const [error, setError] = useState('')
  const [supported, setSupported] = useState({ ar: false, vr: false })
  const [artifact, setArtifact] = useState<OpenArtifact | null>(null)
  const [artifactNotice, setArtifactNotice] = useState('')
  // The viewer outlives renders; a newly opened artifact starts beside the avatar's current placement.
  const avatarPlacement = useRef(placement)
  useEffect(() => { avatarPlacement.current = placement }, [placement])
  const [artifactViewer] = useState(() => createArtifactViewer(view => setArtifact(current => showArtifact(current, view, avatarPlacement.current)), setArtifactNotice))
  const [conversation] = useState(() => new Conversation(browserServices(), setState, (answer, artifact) => { if (mounted.current) return artifactViewer.open(answer, artifact) }))
  const pageArtifact = (delta: number) => setArtifact(current => turnArtifactPage(current, delta))
  const adjustArtifactPlacement = (adjustment: ArtifactAdjustment) => setArtifact(current => current && { ...current, placement: adjustArtifact(current.placement, adjustment) })
  const grabArtifactPlacement = (id: string, placement: ArtifactPlacement) => setArtifact(current => placeArtifact(current, id, placement))
  const recording = useRef<Awaited<ReturnType<typeof recordMicrophone>> | null>(null)
  const controllerPttHeld = useRef(false)
  const canvasPttHeld = useRef(false)
  const mounted = useRef(true); const [startingMic, setStartingMic] = useState(false)
  useEffect(() => {
    mounted.current = true
    void capabilities(window.isSecureContext ? navigator.xr : undefined).then(result => { if (mounted.current) setSupported(result) })
    return () => { mounted.current = false; recording.current?.cancel() }
  }, [])
  const fail = (cause: unknown) => { if (mounted.current) { setError(cause instanceof Error ? cause.message : 'Something went wrong'); setState('error') } }
  const busy = startingMic || ['listening', 'thinking', 'working', 'speaking'].includes(state)
  async function send() { if (busy || !input.trim()) return; const text = input; setInput(''); setError(''); try { await conversation.send(text) } catch (cause) { fail(cause) } }
  function stopMicrophone() {
    recording.current?.stop()
    recording.current = null
  }
  async function startMicrophone(requireControllerHold = false) {
    if (recording.current || busy) return
    setError(''); setStartingMic(true)
    try {
      const recorder = await recordMicrophone(blob => { recording.current = null; if (mounted.current) void conversation.recorded(blob).catch(fail) }, fail)
      if (!mounted.current || (requireControllerHold && !controllerPttHeld.current) || !conversation.listen()) { recorder.cancel(); return }
      recording.current = recorder
    } catch (cause) { fail(cause) } finally { if (mounted.current) setStartingMic(false) }
  }
  function microphone() {
    if (recording.current) stopMicrophone()
    else void startMicrophone()
  }
  function pushToTalkStart() {
    controllerPttHeld.current = true
    void startMicrophone(true)
  }
  function pushToTalkStop() {
    controllerPttHeld.current = false
    stopMicrophone()
  }
  useEffect(() => {
    return bindCanvasPushToTalk(window, canvasPttHeld, pushToTalkStart, pushToTalkStop)
    // Only the busy transition changes the capture gate; refs carry active recorder state.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])
  async function enter(mode: 'ar' | 'vr') { setError(''); try { if (mode === 'ar') await xrStore.enterAR(); else await xrStore.enterVR() } catch (cause) { fail(cause) } }
  return <main>
    <header><a className="brand" href="/">RH <span>RealHermes</span></a><span className="eyebrow">A presence, beyond the screen</span></header>
    <div className="workspace">
      <section className="stage" aria-label="Simulator">
        <div className="stage-heading"><span className="eyebrow">Desktop simulator</span><span className={`status ${state}`} role="status" aria-live="polite">● {state}</span></div>
        <Simulator state={state} placement={placement} onPushToTalkStart={pushToTalkStart} onPushToTalkStop={pushToTalkStop} artifact={artifact?.view} artifactPlacement={artifact?.placement} onArtifactPage={pageArtifact} onArtifactClose={artifactViewer.dismiss} onArtifactAdjust={adjustArtifactPlacement} onArtifactPlace={grabArtifactPlacement} />
        <StageFooter artifact={artifact} notice={artifactNotice} placement={placement} onPlacement={setPlacement} supported={supported} onEnter={mode => void enter(mode)} onPage={pageArtifact} onClose={artifactViewer.dismiss} onAdjust={adjustArtifactPlacement} />
      </section>
      <section className="conversation" aria-label="Conversation">
        <span className="eyebrow">Your companion</span><h1>A little closer<br />to Hermes.</h1><p className="intro">Start a conversation. Type a thought, or use your voice.</p>
        <div className="messages" role="log" aria-live="polite">{conversation.messages.length ? conversation.messages.map((message, index) => <article key={index} className={message.role}><small>{message.role === 'user' ? 'You' : 'Hermes'}</small><p>{message.content}</p></article>) : <p className="empty">Say hello. Hermes is ready when you are.</p>}</div>
        {error && <div><p role="alert" className="error">{error}</p><button type="button" onClick={() => { conversation.retry(); setError(''); setState('idle') }}>Retry</button></div>}
        <form onSubmit={event => { event.preventDefault(); void send() }}><label htmlFor="message">Message Hermes</label><textarea id="message" value={input} maxLength={8000} disabled={busy} onChange={event => setInput(event.target.value)} placeholder="What’s on your mind?" /><div className="composer-actions"><button type="button" disabled={startingMic || (busy && state !== 'listening')} onClick={() => void microphone()}>{state === 'listening' ? 'Stop microphone' : 'Start microphone'}</button><button className="primary" type="submit" disabled={busy || !input.trim()}>Send ↗</button></div></form>
        <small className="hint">Hold the right controller trigger to talk, then release to send. The on-screen microphone button also works.</small>
      </section>
    </div><footer>RealHermes <span>Text · Voice · Spatial presence</span><span className="credit">Made by <a href="https://gainsec.com/" target="_blank" rel="noreferrer">Jon “GainSec” Gaines</a> © 2026</span></footer>
  </main>
}
export default App
