import { expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPoppler } from './poppler.ts'

// Executables present in a stand-in filesystem; discovery never runs a process or a shell.
const installed = (...paths: string[]) => (path: string) => paths.includes(path)

it('uses the first absolute PATH directory that holds both Poppler tools', () => {
  const tools = findPoppler({ PATH: '/opt/partial/bin:/usr/local/bin:/usr/bin' }, installed('/opt/partial/bin/pdfinfo', '/usr/local/bin/pdfinfo', '/usr/local/bin/pdftoppm', '/usr/bin/pdfinfo', '/usr/bin/pdftoppm'))
  expect(tools).toEqual({ pdfinfo: '/usr/local/bin/pdfinfo', pdftoppm: '/usr/local/bin/pdftoppm' })
})
it('never searches empty or relative PATH entries, which resolve against the working directory', () => {
  const tools = findPoppler({ PATH: ':.:bin:/usr/bin' }, installed('pdfinfo', 'pdftoppm', 'bin/pdfinfo', 'bin/pdftoppm', '/usr/bin/pdfinfo', '/usr/bin/pdftoppm'))
  expect(tools).toEqual({ pdfinfo: '/usr/bin/pdfinfo', pdftoppm: '/usr/bin/pdftoppm' })
})
it('leaves PDF support off when no PATH directory holds both tools', () => {
  expect(findPoppler({ PATH: '/usr/bin:/opt/bin' }, installed('/usr/bin/pdfinfo', '/opt/bin/pdftoppm'))).toBeUndefined()
  expect(findPoppler({}, installed('/usr/bin/pdfinfo', '/usr/bin/pdftoppm'))).toBeUndefined()
})
it('prefers an explicit REALHERMES_POPPLER_DIR over PATH, and treats a blank one as unset', () => {
  const everywhere = installed('/opt/poppler/bin/pdfinfo', '/opt/poppler/bin/pdftoppm', '/usr/bin/pdfinfo', '/usr/bin/pdftoppm')
  expect(findPoppler({ REALHERMES_POPPLER_DIR: '/opt/poppler/bin/', PATH: '/usr/bin' }, everywhere)).toEqual({ pdfinfo: '/opt/poppler/bin/pdfinfo', pdftoppm: '/opt/poppler/bin/pdftoppm' })
  expect(findPoppler({ REALHERMES_POPPLER_DIR: '  ', PATH: '/usr/bin' }, everywhere)).toEqual({ pdfinfo: '/usr/bin/pdfinfo', pdftoppm: '/usr/bin/pdftoppm' })
})
it.each(['relative/bin', '/opt/poppler/../bin', '/opt/missing', '/opt/half', '/opt/a\u0000b'])('refuses an unusable REALHERMES_POPPLER_DIR %j instead of falling back to PATH', dir => {
  const tools = installed('/opt/half/pdfinfo', '/opt/bin/pdfinfo', '/opt/bin/pdftoppm', 'relative/bin/pdfinfo', 'relative/bin/pdftoppm', '/usr/bin/pdfinfo', '/usr/bin/pdftoppm')
  expect(() => findPoppler({ REALHERMES_POPPLER_DIR: dir, PATH: '/usr/bin' }, tools)).toThrow('Invalid REALHERMES_POPPLER_DIR')
})
it('accepts only executable regular files on the real filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rh-poppler-path-'))
  try {
    const [empty, readable, folders, usable] = ['empty', 'readable', 'folders', 'usable'].map(name => join(root, name))
    for (const dir of [empty, readable, folders, usable]) await mkdir(dir)
    for (const tool of ['pdfinfo', 'pdftoppm']) {
      await writeFile(join(readable, tool), '#!/bin/sh\n', { mode: 0o644 })
      await mkdir(join(folders, tool))
      await writeFile(join(usable, tool), '#!/bin/sh\n'); await chmod(join(usable, tool), 0o755)
    }
    expect(findPoppler({ PATH: [empty, readable, folders].join(':') })).toBeUndefined()
    expect(findPoppler({ PATH: [empty, readable, folders, usable].join(':') })).toEqual({ pdfinfo: join(usable, 'pdfinfo'), pdftoppm: join(usable, 'pdftoppm') })
    expect(() => findPoppler({ REALHERMES_POPPLER_DIR: readable })).toThrow('Invalid REALHERMES_POPPLER_DIR')
  } finally { await rm(root, { recursive: true, force: true }) }
})
