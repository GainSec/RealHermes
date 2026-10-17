# Installation

This guide takes a fresh macOS or Linux machine to a running RealHermes. Settings are explained in [configuration.md](configuration.md); running with a headset is covered in [production.md](production.md) and [headset.md](headset.md).

## Supported platforms

| Platform | Status |
| --- | --- |
| macOS on Apple silicon | Reference environment. Developed and run end to end with Hermes Agent and a Steam Frame headset. |
| macOS on Intel | Expected to work; not exercised. |
| Linux (Debian/Ubuntu family) | `npm ci`, the full test suite (including real Poppler PDF rendering), lint and the production build are exercised in Debian 12 containers on Node.js 22 and 24. The complete Hermes and headset loop has not been exercised on Linux. |
| Windows | Not supported. The launchers manage POSIX process groups; WSL2 is untested. |

## Requirements

| Requirement | Needed for | Notes |
| --- | --- | --- |
| Node.js `^22.12.0`, `^24.0.0` or `>=26.0.0`, with npm | Everything | Declared in `package.json` `engines`. Exercised with Node.js 22, 24 and 26 and npm 10 and 11. |
| git | Cloning, `npm run verify` | |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) gateway with its API server enabled | Chat, tools, vision | Runs separately; RealHermes never starts or reconfigures it. |
| The bundled `steam-frame-view` Hermes plugin, SSH access to the headset, `framecorder` and `ffmpeg` on the headset | Letting Hermes see the headset view (optional) | See step 7. |
| Hermes speech-to-text and text-to-speech providers | Voice | Configured in Hermes, not in RealHermes. |
| ffmpeg on the machine running Hermes | Voice | Hermes voice features use ffmpeg for audio conversion. RealHermes itself does not call it. |
| Python interpreter of your Hermes installation | `npm run prod` | Set `HERMES_PYTHON` to it. |
| `hermes` command on `PATH` | `npm run dev:full` | |
| Poppler (`pdfinfo` and `pdftoppm`) | PDF artifacts (optional) | Without it, PDFs are unavailable and images still work. |
| OpenSSH client | Headset reverse tunnel (optional) | The headset must run an SSH server you can log in to with a key. |
| A WebXR browser in a secure context | VR / AR | The desktop simulator works in any modern browser. See [headset.md](headset.md). |
| About 40 MB of disk for the repository | | Mostly the 2x4 model. Dependencies are installed separately by npm. |

## 1. Install system packages

macOS, with [Homebrew](https://brew.sh):

```sh
brew install node git poppler ffmpeg
node --version          # must satisfy ^22.12.0 || ^24.0.0 || >=26.0.0
```

Debian or Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y git poppler-utils ffmpeg python3 openssh-client
```

Distribution Node.js packages are often older than 22.12. Install a supported Node.js from [nodejs.org](https://nodejs.org/) or with a version manager, then check `node --version`.

## 2. Prepare Hermes Agent

Install Hermes Agent by following its documentation, then:

1. Enable the gateway's API server. The Hermes [API server documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) uses `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<a long random value>` in the Hermes environment, then `hermes gateway`. By default it listens on `127.0.0.1:8642`. Generate a key with `openssl rand -hex 32`.
2. Check that it answers: `curl http://127.0.0.1:8642/health` should return `{"status": "ok"}`.
3. Configure speech providers and install ffmpeg as described in the Hermes [voice documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode) (`stt.provider`, `tts.provider`).

RealHermes reuses the gateway key you chose; it does not need, read or change any other Hermes credential.

## 3. Get RealHermes

```sh
git clone https://github.com/gainsec/realhermes.git realhermes
cd realhermes
npm ci
```

`npm ci` installs exactly the versions in `package-lock.json`, including the development dependencies that the build and the `tsx` runtime need. npm 11 may report that `esbuild` and `fsevents` install scripts are not covered by `allowScripts`. RealHermes builds and runs without those scripts, and you can approve them with `npm install-scripts approve <package>` if you prefer.

## 4. Configure

```sh
npm run setup:env
```

This copies `.env.example` to `.env` with owner-only permissions. If `.env` already exists, or the path is a symlink, it leaves it unchanged. Then edit `.env`:

- `HERMES_API_KEY`: the gateway's `API_SERVER_KEY`.
- `HERMES_CHAT_BASE_URL`: only if the gateway is not on `http://127.0.0.1:8642`.
- `HERMES_PYTHON`: for `npm run prod`, the Python inside your Hermes installation.
- Optional: `REALHERMES_LOCAL_ARTIFACT_ROOTS`, `REALHERMES_POPPLER_DIR` and the tunnel settings.

[configuration.md](configuration.md) documents every setting.

## 5. Check

```sh
npm run doctor
npm test
```

`npm run doctor` is read-only. It checks the Node.js version, the 2x4 model, the build, chat and audio settings (without printing secrets), Poppler, approved folders, the Hermes Python, `hermes`, ffmpeg, the launcher and tunnel settings, free ports and `.env` permissions. It exits with status 1 only for problems that stop RealHermes from starting or working as configured, such as an unsupported Node.js version, a missing model or an invalid setting. Warnings name the feature that would be unavailable.

## 6. Run

- Desktop development with local voice: `npm run dev:full`, then open <http://127.0.0.1:5173>.
- Development against an audio backend you run yourself: set `HERMES_AUDIO_BASE_URL` and `HERMES_AUDIO_SESSION_TOKEN`, then `npm run dev`.
- Daily use and headsets: `npm run prod`; see [production.md](production.md).

## 7. Optional: let Hermes see the headset view

Copy the bundled plugin into your Hermes profile, enable it and restart the gateway:

```sh
cp -R hermes-plugins/steam-frame-view ~/.hermes/plugins/
hermes plugins enable steam-frame-view
```

The plugin runs one fixed command over `ssh frame`, so the machine running Hermes needs a `frame` alias in `~/.ssh/config` with key authentication and an already trusted host key, and the headset needs `~/.local/bin/framecorder` and `ffmpeg`. Check it with a question that needs the view, such as "what am I looking at?", and look for a `steam_frame_capture` call in the Hermes trace. Details and failure messages are in [configuration.md](configuration.md#seeing-what-the-wearer-sees) and [troubleshooting.md](troubleshooting.md#seeing-what-you-see).

## Hermes Agent compatibility

RealHermes was developed in October 2026 against a Hermes Agent installation of that time. It depends on these Hermes interfaces:

| Interface | Used by | Status in the Hermes documentation |
| --- | --- | --- |
| Gateway API server `POST /v1/responses` with `input`, `instructions`, a named `conversation` and `stream: true` (Responses-style SSE events) and bearer authentication with `API_SERVER_KEY` | Chat, tool state, artifact recovery prompts | Documented in the API server guide |
| Hermes plugins (`plugin.yaml` with a `register(ctx)` entry point exposing a tool) and the built-in `vision_analyze` tool | Letting Hermes see the headset view | Plugin API documented; `vision_analyze` is a built-in tool |
| Dashboard web server audio routes: `POST /api/audio/transcribe` (`{ data_url, mime_type }` → `{ transcript }`) and `POST /api/audio/speak` (`{ text }` → `{ data_url, mime_type }`), authenticated with an `X-Hermes-Session-Token` header that matches `HERMES_DASHBOARD_SESSION_TOKEN` | Voice | Not described in the public dashboard documentation at the time of writing |
| `GET /api/host/identity` returning `{ ok: true, protocolVersion: 1, pid }` | `npm run prod` readiness check | Not described in the public documentation |
| `hermes serve --skip-build --host 127.0.0.1 --port 9119` | `npm run dev:full` | Not described in the public documentation |
| Python modules `hermes_bootstrap` and `hermes_cli.web_server` with `start_server(host, port, headless, isolated, open_browser)` and `_publish_host_rendezvous` | `npm run prod` (`scripts/hermes-production.py`) | Internal Hermes API |

If your Hermes version lacks the audio routes, text chat, vision and artifacts still work, and voice fails with a visible error. `scripts/hermes-production.py` checks for the internal hook it needs and refuses to start (`Unsupported Hermes production bootstrap`) instead of falling back to publishing its session token.

## Updating and uninstalling

- Update: `git pull`, then `npm ci`. Rebuild with `npm run build` (or `npm run prod`, which builds first).
- Uninstall: stop RealHermes and delete the repository folder. RealHermes installs nothing globally. Its only other files are the temporary artifact caches (`$TMPDIR/realhermes-artifacts-*`), which are deleted on shutdown. Hermes, Poppler, ffmpeg and Node.js are separate installations.
