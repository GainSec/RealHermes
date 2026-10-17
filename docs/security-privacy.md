# Security and privacy

RealHermes connects a browser, which may be in a headset, to an agent that can run tools on your behalf. Its design keeps credentials, files and network reach on the server side, behind narrow validated routes. This page describes those boundaries, what data goes where, and the risks that remain. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Trust boundaries

| Boundary | What crosses it | Protections |
| --- | --- | --- |
| Browser → relay | Text, recorded audio, artifact IDs and page numbers | Same-origin `/api` only; strict shape, size and type validation; JSON bodies only; text ≤ 8,000 characters; audio ≤ 10 MiB; artifact requests ≤ 8 KiB and refused when `Sec-Fetch-Site` is `cross-site`; sanitized errors. |
| Relay → Hermes gateway | Turn text and fixed identity/capability instructions; after a dead link, one bounded recovery prompt naming the failed URL and reason | Bearer key held only by the relay; fixed conversation name; timeouts; only sanitized events back to the browser. |
| Hermes → headset | One fixed SSH command per `steam_frame_capture` call | The bundled plugin accepts no arguments, uses a fixed alias and command, bounds time and output, validates the JPEG and keeps it owner-only in the Hermes cache. |
| Relay → Hermes audio backend | Recorded audio for transcription, answer text for speech | Session token held only by the relay or launcher; validated audio in both directions. |
| Relay → the internet | HTTPS requests for the PDF or image links in an answer (at most three per answer, plus up to two recovery rounds) | DNS answers validated and pinned; private, reserved, loopback, link-local and special-use addresses refused; redirects re-validated; no credentials, cookies or local data sent; strict size, time, MIME and magic-byte limits. |
| Relay → local files | Images and PDFs under approved folders | Explicit requests only; `O_NOFOLLOW` opens; regular-file, size and type checks; bounded scans; no path ever leaves the relay. |
| Relay → Poppler | One cached PDF file per call | Fixed executables found at startup; `execFile` with fixed arguments, no shell; 10-second timeout; bounded output; server-chosen file names. |
| Host → headset | The app and API over one forwarded loopback port | Reverse SSH tunnel with batch mode, key authentication, no connection sharing or local commands; only the app port is forwarded. |

## Credentials

- The gateway key (`HERMES_API_KEY` or `API_SERVER_KEY`) and the audio session token exist only in server environments. They are never sent to the browser, logged or written to disk by RealHermes. `.env` is git-ignored.
- `npm run dev:full` and `npm run prod` generate a new random 256-bit audio session token per start and pass it only to the processes that need it. The production bootstrap also stops Hermes from publishing that token to its host rendezvous file, and refuses to start on a Hermes version where it cannot.
- Sanitized errors never include upstream bodies, URLs, keys, tool names, tool arguments or local paths.

## Network exposure

Every RealHermes listener binds `127.0.0.1`: the Vite dev server, the development relay, the production server and the owned audio backend. Nothing is exposed to your LAN. A headset reaches the app through a reverse SSH tunnel that binds only the headset's own loopback interface. Do not change these binds or put the relay behind a public proxy: the relay has no user authentication of its own (see [residual risks](#residual-risks)).

## What leaves your machine

| Data | Destination | When |
| --- | --- | --- |
| Turn text and conversation context | Hermes, and the model provider Hermes is configured to use | Every chat turn (local file requests excepted) |
| One headset still (JPEG) | Hermes and its model provider, through Hermes' own vision tool | Each time Hermes calls `steam_frame_capture`, which it does when an answer depends on what you see |
| Recorded audio and answer text | The Hermes audio backend and its speech providers, which may be cloud services | Voice turns and spoken replies |
| Whatever Hermes tools send | Wherever those tools reach | When Hermes decides to use a tool; governed by your Hermes configuration |
| HTTPS requests for PDFs or images | The hosts named in the answer | After an answer with a supported link; at most three links per answer and two recovery rounds |
| Font requests | `cdn.jsdelivr.net` | When in-world text needs fonts (Troika's Unicode font resolution in the browser) |

Local file requests ("show me ... from my computer") are answered by the relay itself and are not sent to Hermes.

## What is stored

- **Hermes** stores the shared conversation `realhermes-steam-frame-v3` according to its own configuration, including the recovery prompts the relay sends after dead links. The capture plugin keeps the newest eight stills in `~/.hermes/cache/steam-frame-view/`, owner-only.
- **RealHermes** stores only the artifact cache: owner-only folders under `$TMPDIR/realhermes-artifacts-*`, holding at most eight artifacts and 100 MiB. Entries expire after ten minutes, and the cache is deleted on shutdown (a forced kill can leave files behind; they are never reused). In production the relay also appends sanitized artifact diagnostics (JSON lines: link host and path, reason codes, page counts; never queries, headers, bodies or tokens) to `~/.hermes/logs/realhermes-relay.log`, created owner-only. There is no other database, log file or telemetry.
- **The browser** keeps the visible conversation in memory only; a reload clears it.
- **Logs:** the production launcher prints sanitized status lines only and suppresses child output, because Hermes and SSH diagnostics can contain secrets or paths. Development commands pass child output through to your terminal.

## Vision

Only Hermes decides to look, by calling `steam_frame_capture`; the browser cannot request a capture, choose a path or receive the image. Each call takes one fresh still, so there is no continuous upload. The still is the Steam Frame panel view and includes the real-world passthrough scene when passthrough is active; Hermes is told so, and told never to put the capture's path in a reply. A headset that is asleep or not running SteamVR makes the tool fail with a fixed message instead of describing an old frame.

## Local files

Local discovery is off until you approve specific folders; startup refuses `/`, your home folder or a parent of it, and hidden folders. Within approved folders, the relay:

- searches only names, using words from the request (a request can never name a path);
- skips hidden entries, symlinks, special files, bundles and vendor or build folders, and follows a folder only if its resolved path is still inside the approved folder;
- opens the chosen file without following a final symlink, then confirms that the open file is still that exact path inside the folder (same device and inode), that it is a regular file of at most 25 MiB, and that it did not change while being read;
- validates the bytes like a web artifact (MIME, magic bytes, image dimensions, PDF page count) and serves the cached copy by opaque ID.

Paths, folder names, directory listings and `file://` URLs are never sent to the browser or to Hermes. The answer names only the chosen file.

## Browser hardening

The production origin sends `Content-Security-Policy` (`default-src 'self'`, no framing, no plugins, `form-action 'self'`; network access limited to the origin and the font CDN), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY` and a `Permissions-Policy` that allows the microphone and WebXR only for the origin. Artifact pages carry their own `default-src 'none'; sandbox` policy. Unknown API routes return JSON 404s, never the app shell. The Vite development server does not send these production headers.

## Process safety

The launchers never kill a process they did not start, never use broad `pkill`-style commands, and never manage the Hermes messaging gateway. They check required ports first and report busy ones. They signal only the process groups they created, escalating to `SIGKILL` after a 3-second grace period. `npm run doctor` and `npm run setup:env` are read-only and no-overwrite respectively.

## Residual risks

- **Local callers are trusted.** The relay does not authenticate requests and does not check the `Host` header. Any process or user on the same machine that can reach `127.0.0.1` can chat with your Hermes agent through it, including its tools. A web page that rebinds its DNS name to `127.0.0.1` might reach it from your browser; current browsers increasingly block this, but do not rely on that. Run RealHermes only on a single-user machine you trust. A `Host` allowlist is not implemented.
- **Hermes is powerful.** The gateway API gives the agent its full toolset. RealHermes limits what it forwards, but it does not sandbox Hermes; configure Hermes' tools and approvals accordingly.
- **The tunnel trusts your SSH setup.** Host-key verification and key management are yours. Anyone who can log in to the headset can reach the forwarded port on its loopback interface.
- **Third-party content.** Artifacts are fetched from links that Hermes chose. Rasterization and magic-byte checks keep scripts, links and forms inert, but the content itself is whatever the source served.
- **Font CDN.** In-world text may load fonts from `cdn.jsdelivr.net`, which then sees your IP address and the requested font files.
