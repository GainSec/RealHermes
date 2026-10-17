import { expect, it } from 'vitest'
import { Conversation, capabilities, idleClip } from './conversation'
it('runs text through thinking, speaking, and idle with history', async () => {
  const states: string[] = []; const spoken: string[] = []
  const conversation = new Conversation({ chat: async text => { expect(text).toBe('Hi'); return 'Hello' }, speak: async (text, started) => { spoken.push(text); started() }, transcribe: async () => 'Hi' }, state => states.push(state))
  await conversation.send('Hi')
  expect(states).toEqual(['thinking', 'speaking', 'idle']); expect(spoken).toEqual(['Hello'])
  expect(conversation.messages).toEqual([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }])
})
it('transcribes a recording before sending it', async () => {
  const states: string[] = []
  const conversation = new Conversation({ chat: async () => 'Hello', speak: async (_text, started) => { started() }, transcribe: async () => 'Hi' }, state => states.push(state))
  conversation.listen(); await conversation.recorded(new Blob(['audio']))
  expect(states).toEqual(['listening', 'thinking', 'thinking', 'speaking', 'idle'])
})
it('recovers failures to an error state and prevents overlapping turns', async () => {
  const states: string[] = []
  const conversation = new Conversation({ chat: async () => { throw new Error('Offline') }, speak: async (_text, started) => { started() }, transcribe: async () => '' }, state => states.push(state))
  await expect(conversation.send('Hi')).rejects.toThrow('Offline'); expect(states.at(-1)).toBe('error')
  await expect(conversation.send('Again')).rejects.toThrow('Offline')
})
// Hermes TTS cleanup deletes bare URLs, then rejects text left empty (relay 502 "Hermes request failed").
function hermesSpeech(spoken: string[], failure?: Error) {
  return async (text: string, started: () => void) => {
    if (!/[\p{L}\p{N}]/u.test(text.replace(/https?:\/\/\S+/g, ''))) throw new Error('Hermes request failed')
    if (failure) throw failure
    spoken.push(text); started()
  }
}
it('speaks a useful phrase for URL-only answers while the visible answer and artifact URL stay exact', async () => {
  for (const [answer, phrase] of [['https://images.example.com/gallery/1.webp', "Here's the image."], ['<https://docs.example.com/forms/form.pdf>', "Here's the PDF."], ['[](https://example.com/page)', "Here's the link."]]) {
    const states: string[] = []; const spoken: string[] = []; const completed: string[] = []
    const conversation = new Conversation({ chat: async () => answer, speak: hermesSpeech(spoken), transcribe: async () => '' }, state => states.push(state), reply => { completed.push(reply) })
    await conversation.send('Show me')
    expect(conversation.messages.at(-1)).toEqual({ role: 'assistant', content: answer }); expect(completed).toEqual([answer])
    expect(spoken).toEqual([phrase]); expect(states).toEqual(['thinking', 'speaking', 'idle'])
  }
})
it('passes link-bearing prose to speech unchanged and still surfaces unrelated speech failures', async () => {
  const spoken: string[] = []; const answer = 'Here is the PDF: https://docs.example.com/forms/form.pdf'
  await new Conversation({ chat: async () => answer, speak: hermesSpeech(spoken), transcribe: async () => '' }, () => {}).send('PDF')
  expect(spoken).toEqual([answer])
  const states: string[] = []
  const failing = new Conversation({ chat: async () => 'https://images.example.com/gallery/1.webp', speak: hermesSpeech([], new Error('Speech synthesis failed')), transcribe: async () => '' }, state => states.push(state))
  await expect(failing.send('Image')).rejects.toThrow('Speech synthesis failed'); expect(states.at(-1)).toBe('error')
})
it('gates XR independently and tolerates missing or rejected support', async () => {
  expect(await capabilities()).toEqual({ ar: false, vr: false })
  expect(await capabilities({ isSessionSupported: async mode => mode === 'immersive-ar' })).toEqual({ ar: true, vr: false })
  expect(await capabilities({ isSessionSupported: async () => { throw Error() } })).toEqual({ ar: false, vr: false })
})
it('prefers idle animation and falls back to first clip', () => {
  expect(idleClip(['Walk', 'Idle'])).toBe('Idle'); expect(idleClip(['Armature|idle'])).toBe('Armature|idle'); expect(idleClip(['Rest'])).toBe('Rest'); expect(idleClip([])).toBeUndefined()
})
it('ignores overlapping turns while the first reply is pending', async () => {
  let finish!: (reply: string) => void; let calls = 0
  const conversation = new Conversation({ chat: async () => { calls++; return new Promise<string>(resolve => { finish = resolve }) }, speak: async (_text, started) => { started() }, transcribe: async () => '' }, () => {})
  const first = conversation.send('First'); await conversation.send('Second'); expect(calls).toBe(1)
  finish('Hello'); await first; expect(conversation.messages[0].content).toBe('First')
})

it('stays thinking while synthesizing and clears errors on retry without reload', async () => {
  const states: string[] = []; let fail = true
  const conversation = new Conversation({ chat: async () => 'Hello', transcribe: async () => 'Hi', speak: async (_text, started) => {
    expect(states.at(-1)).toBe('thinking')
    if (fail) throw Error('Synthesis failed')
    started(); expect(states.at(-1)).toBe('speaking')
  } }, state => states.push(state))
  await expect(conversation.send('Hi')).rejects.toThrow('Synthesis failed')
  expect(states).toEqual(['thinking', 'error'])
  conversation.retry(); expect(states.at(-1)).toBe('idle')
  fail = false; await conversation.send('Again')
  expect(states.slice(-3)).toEqual(['thinking', 'speaking', 'idle'])
  expect(states).not.toContain('working')
})

it('orders real tool working before playable speech and remains retryable', async () => {
  const states: string[] = []; let fail = true
  const conversation = new Conversation({ chat: async (_text, working) => {
    expect(states.at(-1)).toBe('thinking'); working?.(); expect(states.at(-1)).toBe('working')
    if (fail) throw Error('Tool failed')
    return 'Done'
  }, speak: async (_text, started) => {
    expect(states.at(-1)).toBe('working'); started(); expect(states.at(-1)).toBe('speaking')
  }, transcribe: async () => 'Hi' }, state => states.push(state))
  await expect(conversation.send('Hi')).rejects.toThrow('Tool failed')
  expect(states).toEqual(['thinking', 'working', 'error'])
  conversation.retry(); fail = false; await conversation.send('Again')
  expect(states.slice(-5)).toEqual(['idle', 'thinking', 'working', 'speaking', 'idle'])
})

it('refuses to start listening over an in-flight turn, so its state and microphone stay consistent', async () => {
  const states: string[] = []; let finish!: (reply: string) => void
  const conversation = new Conversation({ chat: () => new Promise<string>(resolve => { finish = resolve }), speak: async (_text, started) => { started() }, transcribe: async () => '' }, state => states.push(state))
  const turn = conversation.send('What is this?')
  expect(conversation.listen()).toBe(false); expect(states).toEqual(['thinking'])
  finish('A desk.'); await turn
  expect(conversation.listen()).toBe(true); expect(states).toEqual(['thinking', 'speaking', 'idle', 'listening'])
})

it('gives a local artifact found during a turn to the viewer only with the completed answer', async () => {
  const artifact = { id: 'a'.repeat(32), kind: 'image' as const, title: 'Numbix One.png', pageCount: 1 }
  const completed: unknown[][] = []
  const speak = async (_text: string, started: () => void) => { started() }
  await new Conversation({ chat: async (_text, _working, found) => { found?.(artifact); return 'Here.' }, speak, transcribe: async () => '' }, () => {}, (...args) => { completed.push(args) }).send('Show me Numbix One from my computer')
  expect(completed).toEqual([['Here.', artifact]])
  const failing = new Conversation({ chat: async (_text, _working, found) => { found?.(artifact); throw new Error('Incomplete relay stream') }, speak, transcribe: async () => '' }, () => {}, (...args) => { completed.push(args) })
  await expect(failing.send('Show me Numbix One from my computer')).rejects.toThrow('Incomplete relay stream')
  expect(completed).toHaveLength(1)
})
