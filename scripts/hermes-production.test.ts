import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
it('bootstraps owned Hermes without attachment, rendezvous/token publication or external CLI lifecycle actions', () => {
  const result = execFileSync('python3', ['-c', `
import builtins, runpy, sys, types
seen = []
original_import = builtins.__import__
def tracked_import(name, *args, **kwargs):
    if name == 'hermes_bootstrap':
        seen.append(name)
        return types.ModuleType(name)
    return original_import(name, *args, **kwargs)
builtins.__import__ = tracked_import
web = types.ModuleType('hermes_cli.web_server')
web._publish_host_rendezvous = lambda *a: print('SECRET_WRITTEN')
web.start_server = lambda **k: (web._publish_host_rendezvous('127.0.0.1', k['port']), print('BOOTSTRAPPED', bool(seen)), print(k))
pkg = types.ModuleType('hermes_cli'); pkg.web_server = web
sys.modules['hermes_cli'] = pkg; sys.modules['hermes_cli.web_server'] = web
runpy.run_path('scripts/hermes-production.py', run_name='__main__')
`], { env: { ...process.env, REALHERMES_AUDIO_PORT: '23456', HERMES_DASHBOARD_SESSION_TOKEN: 'ephemeral-secret' }, encoding: 'utf8' })
  expect(result).not.toMatch(/SECRET_WRITTEN|ephemeral-secret/)
  expect(result).toContain('BOOTSTRAPPED True')
  expect(result).toContain("'host': '127.0.0.1'"); expect(result).toContain("'port': 23456"); expect(result).toContain("'headless': True")
})
