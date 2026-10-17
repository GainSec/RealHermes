# Development

How the code is organized is described in [architecture.md](architecture.md#source-layout). This page covers working on it: commands, tests, conventions and CI.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact locked dependencies. |
| `npm run dev` | Vite with hot reload on 127.0.0.1:5173 plus the relay on 127.0.0.1:3001 (`tsx watch`). |
| `npm run dev:full` | `npm run dev` plus a local `hermes serve` audio backend on 127.0.0.1:9119. |
| `npm test` | All tests once (Vitest). |
| `npx vitest run server/config.test.ts` | One test file; `npx vitest` watches. |
| `npm run lint` | oxlint (`.oxlintrc.json`). |
| `npm run build` | Type-check the client (`tsc -b`) and the server (`tsconfig.server.json`, strict), then the Vite production bundle in `dist/`. |
| `npm run verify` | The release gates: tests, lint, build, the Hermes plugin's Python tests and git whitespace checks (`scripts/verify.sh`). |
| `npm run doctor` | Read-only environment checks. |
| `npm run setup:env` | Create `.env` from `.env.example` if it does not exist. |

## Tests

The suite runs without network access, without Hermes and without binding ports, so it works in restricted CI sandboxes.

- **Relay:** real Express routing through an in-memory HTTP harness (`server/test-request.ts`), with injected `fetch`, DNS, transports, process runners, filesystems and clocks. It covers credential separation, routing, streaming, timeouts, sanitized errors, the artifact handoff (verification before `done`, dead-link recovery, `reset`), tool starts reported only as `working`, local file discovery (symlink, hidden, size, magic and parent-swap cases), SSRF and DNS rebinding boundaries, cache limits and response headers.
- **Transport:** real TLS and HTTP/2 servers on loopback with throwaway certificates generated at test time (`server/test-certificate.ts`), so no private key is stored in the repository.
- **Poppler:** unit tests use fake executables. `server/artifact-poppler.test.ts` renders a real two-page PDF when `pdfinfo` and `pdftoppm` are found the same way the server finds them, and is skipped otherwise.
- **Hermes plugin:** `hermes-plugins/steam-frame-view/tests` are Python `unittest` tests with a stand-in command runner; run `python3 -m unittest discover hermes-plugins/steam-frame-view/tests`. They never run SSH.
- **Launchers:** injected spawn, kill, ports, probes and fake timers. No test starts Hermes, SSH or a real child process. `scripts/hermes-production.test.ts` runs `python3` against stand-in Hermes modules, so `python3` must be on `PATH`.
- **Browser:** relay client, conversation states, SSE parsing and artifact logic as unit tests. The scene runs the real Simulator, panel, grab handles, OrbitControls and the pointer events from `@react-three/xr` in a real React Three Fiber root (`src/simulatorStage.tsx`), driven by DOM pointer events and staged XR controller sessions. Only WebGL, the model file, Troika text and the WebXR session are replaced.

WebGL rendering, real microphones, live Hermes integration and headset sessions need manual checks on the target browser or device.

## Conventions

- **Test first.** Write a failing test that names the behavior, watch it fail for the expected reason, then make it pass. Bug fixes start with a reproducing test.
- **Inject, don't mock globally.** Server and launcher code takes its dependencies (fetch, DNS, filesystem, clock, spawn, runners) as options; extend those seams rather than patching modules.
- **Fail closed and stay quiet.** Validate shapes and bounds at every boundary, return fixed sanitized messages, and never echo upstream bodies, keys, URLs, tool arguments or paths.
- **Server-only configuration.** New settings are read in `server/config.ts` (or the launchers), documented in `.env.example` and [configuration.md](configuration.md), and checked by `npm run doctor` when they can be misconfigured.
- **Synthetic fixtures only.** Use `example.com` and other reserved names, the documentation address ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`, paths such as `/home/example` or `/srv/realhermes`, and invented names (the tests use a fictional mascot, "Numbix"). Never commit real hostnames, addresses, user names, paths, keys or captured frames. The SSRF tests deliberately list private and reserved ranges (`10.0.0.0/8`, `192.168.0.0/16` and so on) as addresses that must be refused.
- **Keep docs in step.** User-visible behavior changes update the relevant page under `docs/`.

## Release gate

`scripts/verify.sh` is the single gate: run `npm ci`, then `npm run verify`. The script runs the tests, lint, build and the plugin's Python tests. It then checks every committed file for whitespace errors against the empty tree (`git diff --check`), plus any unstaged or staged changes. It needs Node.js, npm, git, `python3`, and Poppler for the real PDF test. There is no hosted CI; run it locally before publishing.

### Running the gate in a Linux container

With Docker, from a committed checkout:

```sh
docker run --rm -v "$PWD:/src:ro" node:22-bookworm sh -c '
  git config --global --add safe.directory /src/.git &&
  git clone -q /src /work && cd /work &&
  apt-get update -qq && apt-get install -y -qq --no-install-recommends poppler-utils >/dev/null &&
  npm ci --no-audit --no-fund && npm run verify'
```

This clones only committed files into the container, so local `node_modules`, `.env` and other ignored files never enter it.

## Release checklist

Before publishing a release candidate:

1. `npm ci && npm run verify` passes (and the container recipe above, for Linux).
2. `npm run doctor` gives no failures on a prepared machine.
3. No secrets or private data are in tracked files. Review `git ls-files`, and search them for credentials, private keys, personal paths, private hostnames and addresses outside the documented test ranges.
4. No generated or local files are tracked: `dist/`, `node_modules/`, `.env`, captures, caches and logs are all git-ignored.
5. `public/models/realhermes-idle.glb` is present and loads in the desktop simulator.
6. Documentation links resolve, and changed behavior is reflected in `docs/`.
