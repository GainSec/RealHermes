# AGENTS.md: operating RealHermes with an AI agent

This file is for coding and operations agents (Hermes Agent, Claude Code, Codex and similar) that a person points at this repository to install, run, troubleshoot or extend RealHermes. It states what the project is, where things live, which commands are safe, and the rules that keep the security design intact. Humans can read it too; the long-form documentation is under `docs/`.

## What you are working on

RealHermes gives a Hermes Agent a body: **2x4**, an animated 3D companion in a desktop browser or a WebXR headset (built and exercised on a Valve Steam Frame). The person talks by text or push-to-talk voice; 2x4 answers out loud; Hermes can look at what the wearer sees and open PDFs and images as panels in the scene.

Three pieces live here:

| Piece | Code | What it does |
| --- | --- | --- |
| Browser app | `src/` | React + three.js scene, conversation UI, microphone, playback, artifact panel, XR controller input. Talks only to same-origin `/api`. |
| Relay | `server/` | Express on `127.0.0.1`. Holds every credential, forwards chat and audio to Hermes, verifies and renders files Hermes links, searches approved local folders. |
| Launchers | `scripts/` | `npm run dev:full` for development, `npm run prod` for the single-origin production runtime with an owned Hermes audio backend and an optional reverse SSH tunnel to a headset. |

Hermes Agent itself (gateway, model, tools, speech providers) runs separately and is never started, stopped or reconfigured by RealHermes. The bundled Hermes plugin in `hermes-plugins/steam-frame-view/` adds the `steam_frame_capture` tool that lets Hermes see the headset view.

Read in this order when you need depth: `README.md`, `docs/installation.md`, `docs/configuration.md`, `docs/architecture.md`, `docs/troubleshooting.md`, `docs/security-privacy.md`.

## Rules for agents

1. **Never put a credential in the browser.** Everything secret is read by Node from the environment or `.env`. Never create a `VITE_*` variable holding a key, URL or path.
2. **Never kill processes you did not start.** The launchers refuse busy ports instead of freeing them; do the same. No `pkill -f`, no `kill` on Hermes, SteamVR, SSH tunnels or browsers you did not launch.
3. **Never commit `.env`, `dist/`, `node_modules/`, captures, logs or anything under `$TMPDIR/realhermes-artifacts-*`.** `.gitignore` already covers them.
4. **Synthetic fixtures only** in tests and docs: `example.com`, documentation IP ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`), paths like `/home/example`, the fictional mascot "Numbix". No real hostnames, user names, home paths, keys or captured frames.
5. **Keep the boundaries.** Inputs validated and bounded at every route; errors reduced to fixed sanitized messages; no upstream bodies, tool names, paths or URLs forwarded to the browser; Hermes decides when to look, the relay never classifies the user's words.
6. **Test first, then `npm run verify`** before claiming anything works. Manual checks on a real browser or headset are still required for WebGL, microphones, speech and XR sessions; say so when you could not do them.
7. **Do not touch Hermes configuration** (model choice, providers, approvals, the messaging gateway). If a task needs it, tell the person what to change in Hermes and why.

## Install

Prerequisites: Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`, npm, git, `python3`, a running Hermes Agent gateway with its API server enabled (`API_SERVER_ENABLED=true`, `API_SERVER_KEY=<random>`), and for voice the Hermes speech providers plus `ffmpeg` on the Hermes host. Poppler (`pdfinfo`, `pdftoppm`) is optional and enables PDF panels. Full steps per platform: `docs/installation.md`.

```sh
npm ci
npm run setup:env          # copies .env.example to .env, owner-only, never overwrites
# edit .env: HERMES_API_KEY = the gateway's API_SERVER_KEY; HERMES_CHAT_BASE_URL only if not http://127.0.0.1:8642
npm run doctor             # read-only checks; prints no secrets
npm test
```

`npm run doctor` exits 1 only for problems that stop RealHermes from starting (unsupported Node, missing model, invalid setting). Warnings name the feature that would be unavailable.

## Run

| Command | What runs | When |
| --- | --- | --- |
| `npm run dev:full` | Vite on 127.0.0.1:5173, relay on 127.0.0.1:3001, a local `hermes serve` audio backend on 127.0.0.1:9119 with a fresh random token | Development with voice; needs `hermes` on `PATH` |
| `npm run dev` | Vite and relay only | Development against an audio backend you run yourself (`HERMES_AUDIO_BASE_URL`, `HERMES_AUDIO_SESSION_TOKEN`) |
| `npm run prod` | Build, then app and `/api` on one loopback origin (default 5173), an owned headless Hermes audio backend (9119), optional reverse SSH tunnel | Daily use and headsets; see `docs/production.md` |
| `npm start` | Relay only | API work |

Open <http://127.0.0.1:5173>. Health: `curl http://127.0.0.1:5173/api/health` (dev relay: port 3001) reports `chatConfigured` and `audioConfigured`; these are configuration flags, not proof the gateway answers. Production also has `/api/ready`.

Production and `dev:full` default to the same ports, so never run both. Both check their ports first and refuse to start if one is busy.

## Configure

Every setting is a server-side environment variable, documented in `.env.example` and `docs/configuration.md`. The ones that matter most:

| Variable | Purpose |
| --- | --- |
| `HERMES_CHAT_BASE_URL`, `HERMES_API_KEY` (or `API_SERVER_KEY`) | Hermes gateway root (no `/v1`) and bearer key |
| `HERMES_AUDIO_BASE_URL`, `HERMES_AUDIO_SESSION_TOKEN` | Audio backend for `npm run dev` / `npm start` only; the launchers make their own |
| `REALHERMES_LOCAL_ARTIFACT_ROOTS` | Colon-separated approved folders for "show me ... from my computer"; off when empty |
| `REALHERMES_POPPLER_DIR` | Folder with `pdfinfo` and `pdftoppm` when they are not on `PATH` |
| `REALHERMES_PORT`, `REALHERMES_AUDIO_PORT`, `HERMES_PYTHON` | Production ports and the Python of the Hermes installation |
| `REALHERMES_TUNNEL`, `REALHERMES_SSH_ALIAS`, `REALHERMES_FRAME_PORT` | Reverse SSH tunnel to the headset |
| `REALHERMES_LOG_FILE` | Production relay's sanitized artifact diagnostics (default `~/.hermes/logs/realhermes-relay.log`) |

Adding a setting: read it in `server/config.ts` (or the launcher), document it in `.env.example` and `docs/configuration.md`, add a `npm run doctor` check in `scripts/doctor.mjs` if it can be misconfigured, and add tests next to each.

## Let Hermes see the headset

Vision is a Hermes tool, not a relay feature. Install the bundled plugin into the Hermes profile on the machine that runs Hermes:

```sh
cp -R hermes-plugins/steam-frame-view ~/.hermes/plugins/
hermes plugins enable steam-frame-view
# restart the Hermes gateway
```

Requirements: that machine can `ssh frame` without prompts (alias in `~/.ssh/config`, key auth, trusted host key); the headset has `~/.local/bin/framecorder` and `ffmpeg`. Verify with a question that needs the view ("what am I looking at?") and look for a `steam_frame_capture` call in the Hermes trace. Details: `docs/configuration.md#seeing-what-the-wearer-sees`, `hermes-plugins/steam-frame-view/README.md`.

## Troubleshoot

Start with `npm run doctor`, then `docs/troubleshooting.md`, which is organized by the message the person sees. The fastest boundary checks:

| Symptom | First check |
| --- | --- |
| "Hermes chat is not configured" (503) | No key: set `HERMES_API_KEY` to the gateway's `API_SERVER_KEY`, restart |
| "Hermes request failed" on every turn | Wrong gateway URL or key: `curl http://127.0.0.1:8642/health`, then an authenticated `GET /v1/models` with the key |
| "Hermes request timed out" | No relay event for 125 s: a very long tool run or a stuck gateway |
| Text works, nothing spoken | Browser blocked playback, or the audio backend/token is wrong; "Hermes audio is not configured" means no token in `npm run dev` |
| "Microphone returned digital silence" | Headset mic gated by SteamVR standby: wear it, wake it, speak while holding the trigger |
| "I errored out while loading the artifact. Check the logs." | No linked file could be loaded; reasons are JSON lines in the relay log (`REALHERMES_LOG_FILE`) |
| PDFs never open, images do | Poppler missing: install it or set `REALHERMES_POPPLER_DIR`; `npm run doctor` shows what was found |
| Enter AR / Enter VR disabled | Not a secure context (use a loopback URL or the tunnel), no WebXR, or the headset runtime is down |
| Tunnel keeps retrying | Host key or key auth not set up (`ssh <alias> true` once by hand), remote port busy, or forwarding disabled on the headset |
| Hermes answers a visual question without looking | Plugin not enabled or gateway not restarted: `hermes plugins list` |

Headset specifics (secure context, controller mapping, Steam Frame notes): `docs/headset.md`. Production start, readiness, stop, logs and recovery: `docs/production.md`.

## Change the companion model

The character is one glTF binary at `public/models/realhermes-idle.glb`, loaded by `src/Simulator.tsx` from `/models/realhermes-idle.glb`. To use another model:

1. Export a `.glb` in metres, Y up, feet near the origin. The authored scale is kept as is, so a 1.7 m character should be about 1.7 units tall. `groundOffset` in `src/model.ts` lifts the model so its bounding-box bottom sits on the floor, so a slightly off origin is fine.
2. Include an idle animation clip. `idleClip` in `src/conversation.ts` picks the first clip whose name contains "idle" (case-insensitive), otherwise the first clip. Only that one clip plays; there is no lip sync or state-driven animation.
3. Replace the file (keep the name, or change the path in `src/Simulator.tsx` and the model check in `scripts/doctor.mjs`). Keep it well under GitHub's 100 MB file limit; the bundled model is about 38 MB.
4. Check it: `npm run doctor` reports the model, `npm test` covers the scene wiring, then look at it in the desktop simulator (`npm run dev`) and adjust the default placement (`defaultPlacement` in `src/placement.ts`, height 0 m and distance 2 m) and the state label height (`placement.height + 2.15` in `src/Simulator.tsx`) if the character is much taller or shorter.

The bundled 2x4 model and artwork are under the repository's source-available license (see `LICENSE` and the README's license section); a replacement model is under whatever license its author gave it.

## Change the companion's name or standing instructions

The name "2x4" and the standing instructions (identify as 2x4, call `steam_frame_capture` when the answer depends on the wearer's view, reply with a direct public file URL to show a PDF or image) are one string, `realHermesInstructions`, in `server/app.ts`. The tests in `server/app.test.ts`, `server/stream.test.ts` and `server/vision.test.ts` assert the exact string, so update them together. The fixed conversation name (`realhermes-steam-frame-v3` in the same file) is Hermes' durable memory for this surface; bump the suffix when you change the instructions materially, so Hermes does not keep old conclusions.

Language model, speech providers and tool approvals are chosen in Hermes, not here.

## Verify before you say it works

```sh
npm run verify   # tests, lint, type-checked build, the plugin's Python tests, git whitespace checks
```

Then, when the change touches the scene, microphone, speech or XR, exercise it in a real browser or on the headset and report exactly what you checked and what you could not.
