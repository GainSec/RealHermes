# Configuration

RealHermes is configured only on the server side, through environment variables. The relay and the launchers load `.env` from the repository root with dotenv. Variables already set in your shell take precedence over `.env`. [`.env.example`](../.env.example) lists every setting with placeholders. Create your copy with `npm run setup:env` and check it with `npm run doctor`.

## Rules that apply to every setting

- The browser never receives credentials, upstream URLs, local paths or capture paths. All of them stay in the Node processes.
- Never prefix a credential with `VITE_`: Vite would embed it in the browser bundle. `npm run prod` also strips every `VITE_*` variable from the environments of the processes it starts.
- `.env` and `.env.*` are ignored by git; only `.env.example` is tracked. Keep `.env` readable only by you (`chmod 600 .env`); `npm run doctor` warns otherwise.
- The production launcher gives each child only what it needs. The Hermes audio child never receives the chat key, chat URL or approved folders. The SSH tunnel receives only `PATH`, `HOME`, `USER`, `LOGNAME`, `SSH_AUTH_SOCK`, `LANG`, `LC_ALL`, `TMPDIR` and `SYSTEMROOT`.

## Settings

| Variable | Default | Read by | Purpose |
| --- | --- | --- | --- |
| `HERMES_CHAT_BASE_URL` | Derived from `API_SERVER_HOST`/`API_SERVER_PORT`, else `http://127.0.0.1:8642` | Relay | Root URL of the Hermes gateway API server, without `/v1`. |
| `HERMES_API_KEY` | `API_SERVER_KEY` | Relay | Bearer key for the gateway; must equal its `API_SERVER_KEY`. Without a key, chat routes return 503. |
| `API_SERVER_KEY`, `API_SERVER_HOST`, `API_SERVER_PORT` | none | Relay | Fallbacks for a relay started from the gateway's own environment (see [chat routing](#chat-routing)). |
| `HERMES_AUDIO_BASE_URL` | `http://127.0.0.1:9119` | Relay (`npm run dev`, `npm start`) | Root URL of the Hermes audio backend. `npm run dev:full` and `npm run prod` replace it with their own loopback backend. |
| `HERMES_AUDIO_SESSION_TOKEN` | none | Relay (`npm run dev`, `npm start`) | Must equal the backend's `HERMES_DASHBOARD_SESSION_TOKEN`. Without it, audio routes return 503. The launchers generate a fresh random token instead. |
| `REALHERMES_LOCAL_ARTIFACT_ROOTS` | empty (off) | Relay | Colon-separated approved folders for local images and PDFs; see [approved local folders](#approved-local-folders). |
| `REALHERMES_POPPLER_DIR` | First absolute `PATH` folder containing both `pdfinfo` and `pdftoppm` | Relay | Folder of the Poppler executables; see [PDF rendering](#pdf-rendering). |
| `PORT` | `3001` | Development relay | Loopback port of `npm run dev`/`npm start`. If you change it, change the `/api` proxy target in `vite.config.ts` too. |
| `REALHERMES_PORT` | `5173` | `npm run prod` | Loopback port that serves the built app and `/api`. |
| `REALHERMES_AUDIO_PORT` | `9119` | `npm run prod` | Loopback port of the audio backend the launcher owns; must differ from `REALHERMES_PORT`. |
| `HERMES_PYTHON` | `python3` | `npm run prod` | Python interpreter of your Hermes installation. |
| `REALHERMES_TUNNEL` | `0` | `npm run prod` | `1` enables the reverse SSH tunnel to the headset; any value other than `0` or `1` fails startup. |
| `REALHERMES_SSH_ALIAS` | `frame` | `npm run prod` | SSH host alias, hostname or IPv4 address of the headset: letters, digits, `.`, `_` and `-`, starting with a letter or digit. `user@host` is not accepted. |
| `REALHERMES_FRAME_PORT` | `5173` | `npm run prod` | Loopback port on the headset that forwards to `REALHERMES_PORT`. |
| `TMPDIR` | OS default | Relay | Parent folder of the private artifact caches (`realhermes-artifacts-*`). |
| `REALHERMES_LOG_FILE` | `~/.hermes/logs/realhermes-relay.log` | `npm run prod` | JSON-lines file for the relay's sanitized artifact diagnostics (link host and path, reason codes, page counts); see [production.md](production.md#stop-logs-and-recovery). |
| `HERMES_DASHBOARD_SESSION_TOKEN` | generated | Hermes audio child | Do not set. `npm run dev:full` and `npm run prod` create a new random token per start, hold it only in memory and remove stale values. |

`HERMES_BASE_URL` from early prototypes is ignored; use `HERMES_CHAT_BASE_URL` and `HERMES_AUDIO_BASE_URL`.

### What fails startup

Invalid values fail fast instead of silently disabling a protection. The relay refuses to start with an invalid `REALHERMES_LOCAL_ARTIFACT_ROOTS`, an unusable `REALHERMES_POPPLER_DIR` or an invalid `PORT`/`REALHERMES_PORT`. The production launcher also refuses equal or invalid ports, an invalid `REALHERMES_TUNNEL` and an invalid SSH alias, before starting any process. Missing credentials do not fail startup: the affected routes return 503 and `/api/health` reports `chatConfigured` or `audioConfigured` as `false`.

## Chat routing

Without `HERMES_CHAT_BASE_URL`, a relay started from the gateway's own environment dials the address that gateway binds, taken from `API_SERVER_HOST` and `API_SERVER_PORT`. The wildcard binds `0.0.0.0` and `::` become `127.0.0.1` and `[::1]`, bare IPv6 addresses are bracketed, and an invalid port falls back to `8642`. This pairs the `API_SERVER_KEY` fallback with the gateway it belongs to. Set `HERMES_CHAT_BASE_URL` whenever the gateway runs elsewhere. Every chat request carries only `Authorization: Bearer <key>`.

## Seeing what the wearer sees

RealHermes has no vision setting of its own. Looking is a Hermes tool: the bundled plugin in [`hermes-plugins/steam-frame-view`](../hermes-plugins/steam-frame-view/) adds `steam_frame_capture`, which takes one fresh JPEG still of what the headset wearer currently sees (the Steam Frame panel view, real-world passthrough included) and saves it privately for Hermes' own `vision_analyze` tool. The relay only tells Hermes, in its fixed instructions, that the wearer is in a headset and that it should call that tool whenever an answer depends on their current view. Nothing in the browser or relay classifies the user's words, and no image passes through RealHermes.

To enable it:

1. Copy the plugin into your Hermes profile and enable it: `cp -R hermes-plugins/steam-frame-view ~/.hermes/plugins/ && hermes plugins enable steam-frame-view`, then restart the Hermes gateway.
2. Make sure the machine running Hermes can `ssh frame` without a prompt (an alias in `~/.ssh/config` with key authentication and a trusted host key), and that the headset has `framecorder` in `~/.local/bin` and `ffmpeg` installed. The plugin runs one fixed command on that fixed alias; nothing from the conversation reaches it.
3. Captures land in `~/.hermes/cache/steam-frame-view/` (owner-only, newest eight kept). They are never sent to the browser, and Hermes is told never to put their path in a reply.

The plugin's unit tests run with `python3 -m unittest discover hermes-plugins/steam-frame-view/tests`. Without the plugin, every other feature works; a question about the view is answered from conversation context alone.

## Approved local folders

A request such as "Can you find an image of number one on my file system and show me?" is answered by the relay itself, never by a Hermes filesystem search. This feature is off until you list folders:

```sh
REALHERMES_LOCAL_ARTIFACT_ROOTS=/path/to/approved/pictures:/path/to/approved/documents
```

Rules enforced at startup: absolute, normalized paths only; at most eight; never `/`, your home folder or any parent of it; never a hidden folder such as `~/.ssh` or `~/.hermes`. List only specific folders whose images and PDFs you are willing to see in the headset.

How requests are recognized: a local place ("on my file system", "from my computer", "on my Mac", "in my files", "my local screenshot", ...), a find or show verb (find, show, open, display, pull up, "do I have", ...) and an image, PDF or document noun. With a show or open verb, "file" also counts. Anything else, including "find an image of a cat and show me", goes to Hermes as usual.

How files are matched: words come only from the request. File and folder names are split into words, including camel case and digit suffixes (`NumbixOne`, `numbix1`). Numbers match as digits or words ("one" = "1"), and copy counters such as ` (1)` are ignored. Words of five letters or more may differ by up to two letters when the first three match. One- and two-word requests must match every word; longer requests must match two thirds of them. Ranking prefers more matched words, file-name over folder-name matches, exact over near spellings, the most concise name, originals over copies, the shallowest path, then root order. With no match, the answer says so; it never guesses.

Scan bounds: breadth-first, 8 levels deep, 2,000 folders, 20,000 entries and 3 seconds per request. The scan skips hidden names, symlinks, special files, app and photo-library bundles, and folders such as `node_modules`, `vendor`, `dist`, `build`, `Library` and `site-packages`. It considers only `.png`, `.jpg`, `.jpeg`, `.webp` and `.pdf` files of at most 25 MiB, and re-checks the chosen file when opening it (see [security-privacy.md](security-privacy.md#local-files)).

The answer names only the file, for example `Here’s “Invoice 2026” from your approved folders.`, and the browser receives only an opaque artifact ID, a kind, a title and a page count.

## PDF rendering

PDF pages are rasterized by Poppler. At startup the relay uses `REALHERMES_POPPLER_DIR` if set: an absolute, normalized folder that must contain executable `pdfinfo` and `pdftoppm`, or startup fails. Otherwise it uses the first absolute `PATH` folder that contains both; empty and relative `PATH` entries are never searched. If neither finds the tools, PDF artifacts are refused before anything is cached or run, while images keep working. The tools always run through `execFile` with fixed arguments and no shell, a 10-second timeout and bounded output. Typical locations are `/opt/homebrew/bin` (Homebrew on Apple silicon), `/usr/local/bin` and `/usr/bin` (`poppler-utils` on Debian/Ubuntu). Services started outside a login shell often have a minimal `PATH`; set `REALHERMES_POPPLER_DIR` for them.

## Ports

| Port | Default | Bound by | Notes |
| --- | --- | --- | --- |
| Vite dev server | 5173 | `npm run dev`, `npm run dev:full` | `127.0.0.1` only; proxies `/api` to the relay. |
| Development relay | 3001 (`PORT`) | `npm run dev`, `npm start` | `127.0.0.1` only. |
| Development audio backend | 9119 | `npm run dev:full` | Fixed; startup aborts if it is busy. |
| Production app and API | 5173 (`REALHERMES_PORT`) | `npm run prod` | `127.0.0.1` only; same default as Vite, so do not run both. |
| Production audio backend | 9119 (`REALHERMES_AUDIO_PORT`) | `npm run prod` | `127.0.0.1` only. |
| Headset loopback | 5173 (`REALHERMES_FRAME_PORT`) | Remote end of the tunnel | `127.0.0.1` on the headset. |

`npm run prod` checks both of its ports, and `npm run dev:full` checks 9119, before starting anything. They report a busy port instead of stopping whatever owns it. Vite itself moves to the next free port when 5173 is busy, so read the URL it prints.
