# Troubleshooting

Start with `npm run doctor`. It is read-only, prints no secret values, and names most configuration problems directly. The sections below follow the messages you will see in the app or the terminal.

## Microphone

**"Microphone returned digital silence. Wear the headset (standby mutes the Frame microphone) and speak while holding the trigger."**
The recording contained no signal above one 16-bit step, so it was not uploaded. A transcription service given pure silence tends to invent words. Common causes:

- The headset is in standby or not being worn, so SteamVR gates its microphones. Put it on, wake it and try again.
- The operating system's input device is muted or set to a different microphone.
- You released the trigger or button before speaking.

**"Microphone recording is unavailable. Use text instead."** The page is not in a secure context, or the browser has no `MediaRecorder`. Use a loopback URL (`http://127.0.0.1:...`) or the tunnel described in [headset.md](headset.md#secure-context-first).

**Permission errors** come from the browser. Allow microphone access for the origin in its site settings and reload.

**"No speech detected"** means Hermes transcribed the recording to an empty string. Speak closer to the microphone, or check the speech-to-text provider configured in Hermes.

## Chat and gateway routing

**"Hermes chat is not configured"** (HTTP 503): the relay has no key. Set `HERMES_API_KEY` to the gateway's `API_SERVER_KEY` (or start the relay where `API_SERVER_KEY` is set) and restart.

**"Hermes request failed" on every turn**: the relay reached no gateway, reached the wrong one, or used the wrong key. Check from the host without putting the key on the command line:

```sh
curl -sS http://127.0.0.1:8642/health
printf 'Authorization: Bearer %s\n' "$HERMES_API_KEY" | curl -sS -o /dev/null -w '%{http_code}\n' -H @- http://127.0.0.1:8642/v1/models
```

`200` means the URL and key work; `401` means the key does not match `API_SERVER_KEY`; a connection error means nothing is listening at that address. Typical routing mistakes:

- The gateway listens on a LAN address (`API_SERVER_HOST=192.0.2.10`, say) while the relay dials `127.0.0.1`. Set `HERMES_CHAT_BASE_URL=http://192.0.2.10:8642`, or start the relay from the gateway's environment without `HERMES_CHAT_BASE_URL`, so it derives the address ([configuration.md](configuration.md#chat-routing)).
- The gateway binds `0.0.0.0`: it is reachable at `127.0.0.1`, which is what the relay derives.
- `HERMES_CHAT_BASE_URL` includes `/v1`. Use the root URL only.
- The gateway is not running, or its API server is not enabled (`API_SERVER_ENABLED=true`).

`/api/health` and `/api/ready` report only whether a key is configured, never whether the gateway answers.

**"Hermes request timed out"** in the browser: the relay sent no event for 125 seconds. One Hermes request is bounded to 120 seconds and the file checks of a turn to 150 seconds, so this usually means a very long tool run or a stuck gateway. Ask again, or narrow the request.

## Audio and speech

**"Hermes audio is not configured"** (HTTP 503): in `npm run dev` or `npm start` you must supply `HERMES_AUDIO_BASE_URL` and `HERMES_AUDIO_SESSION_TOKEN` (the backend's `HERMES_DASHBOARD_SESSION_TOKEN`). `npm run dev:full` and `npm run prod` provide their own.

**"Hermes request failed" for voice only**: the token does not match, the backend is not running, or your Hermes version lacks the audio routes RealHermes uses ([installation.md](installation.md#hermes-agent-compatibility)). Check Hermes' speech providers and ffmpeg on the Hermes host.

**Text appears but nothing is spoken**: the browser blocked playback ("Audio playback failed"). Interact with the page once, check the output device, then use **Retry**.

## Seeing what you see

Looking is done by Hermes through the bundled `steam_frame_capture` plugin ([configuration.md](configuration.md#seeing-what-the-wearer-sees)). Its failures come back as part of Hermes' answer, in fixed wording:

| Message | Meaning | What to check |
| --- | --- | --- |
| `... the headset view is unavailable (is the Frame awake and SteamVR running?).` | SSH, Framecorder or ffmpeg on the headset failed | `ssh frame true` works without a prompt from the Hermes machine; the headset is awake with SteamVR running; `~/.local/bin/framecorder` and `ffmpeg` exist on the headset |
| `... the headset did not respond in time.` | No still within 25 seconds | Headset asleep, network, or a very slow capture |
| `... the headset returned an invalid image.` | The bytes were not a sane JPEG | Framecorder or ffmpeg versions; try the capture command from `capture.py` by hand |
| `... the capture could not be saved.` | `~/.hermes/cache/steam-frame-view/` is not writable by the Hermes user, or is a symlink | Fix ownership and permissions |

If Hermes answers a visual question without looking at all, the plugin is probably not enabled or the gateway was not restarted after enabling it: `hermes plugins list` should show `steam-frame-view` enabled, and the Hermes trace for the turn should contain a `steam_frame_capture` call.

## Headset tunnel

| Terminal message | Meaning |
| --- | --- |
| `Tunnel connecting; remote availability not probed.` | An SSH attempt started. Verify on the headset by loading the page. |
| `Tunnel closed; retiring owned group before retry.` / `Tunnel unavailable; retry in Ns. Local services remain running.` | SSH exited; the launcher retries with backoff up to 30 s. |
| `Tunnel attempt failed; waiting for process close before retry.` | `ssh` could not be started or reported an error. |

Common causes:

- **Host key or authentication.** The launcher uses `BatchMode=yes`, so it never prompts. Run `ssh <alias> true` yourself once to accept the host key and confirm key login.
- **Headset port already in use.** With `ExitOnForwardFailure=yes`, a busy remote port ends each attempt. Stop the other tunnel or server on the headset, or choose another `REALHERMES_FRAME_PORT`.
- **Forwarding disabled on the headset.** Its SSH server needs `AllowTcpForwarding` enabled for remote forwards.
- **Headset asleep or offline.** Local services keep running; reload the headset page when it is back.
- **Invalid alias.** `REALHERMES_SSH_ALIAS` must be an SSH config alias, hostname or IPv4 address. Put `user@` details in `~/.ssh/config`.

On the headset, `http://127.0.0.1:<port>/api/health` returning JSON confirms the tunnel end to end.

## Artifacts (PDFs and images)

**"I errored out while loading the artifact. Check the logs."** Hermes linked a PDF or image, but none of its links (up to three, plus two rounds of asking Hermes for another source) could be loaded. In production the reasons are in `~/.hermes/logs/realhermes-relay.log` (or `REALHERMES_LOG_FILE`), one JSON line per attempt with the link's host, path and a reason code such as `http_404`, `unsupported_type` or `pdf_unsupported`; in development they go to the relay's terminal. Inspect a logged link from the host:

```sh
curl -sSIL 'https://example.com/path/file.pdf'
```

The link must:

- be `https://` on the standard port, with no credentials, and the path must end in `.pdf`, `.png`, `.jpg`, `.jpeg` or `.webp`;
- resolve only to public addresses (private, loopback, link-local and reserved addresses are refused), and redirect at most four times, staying on HTTPS;
- be served as `application/pdf`, `image/png`, `image/jpeg` or `image/webp`, or as `application/octet-stream` with a matching extension, and the bytes must really be that type (an HTML login or preview page fails);
- arrive without content encoding: the relay asks for `identity` and refuses compressed bodies;
- stay within 25 MiB and 30 seconds; images within 8,192 pixels per side and 16 megapixels; PDFs within 500 pages.

HTTP/2-only servers are supported, and so are servers that require a `User-Agent`. Pages behind logins or cookies cannot be fetched. Only one acquisition runs at a time; the relay waits for the cache to be free within the turn's budget.

**PDFs never open, while images do**: Poppler is missing or not found. Install `poppler` (macOS) or `poppler-utils` (Debian/Ubuntu), or set `REALHERMES_POPPLER_DIR`; `npm run doctor` shows what was found.

**"Page unavailable. Try another page or close."** That page failed to render or load. Other pages remain usable. After ten minutes, or a relay restart, the cached artifact is gone; ask again to reopen it.

## Local files

| Answer | Meaning |
| --- | --- |
| `Local file search isn’t set up yet. ...` | `REALHERMES_LOCAL_ARTIFACT_ROOTS` is empty. |
| `I couldn’t find an image matching “...” in your approved folders.` | No name matched well enough; try the words in the file or folder name. |
| `I found “...” but couldn’t open it. ...` | The match was too large, not a valid image or PDF, changed while being read, or was replaced by a symlink. For PDFs, check Poppler. |
| `I couldn’t search your approved folders just now. Please ask again.` | Another artifact operation was running, or the scan failed. |

If the relay refuses to start with `Invalid REALHERMES_LOCAL_ARTIFACT_ROOTS`, the list contains `/`, your home folder or a parent of it, a hidden folder, a relative or non-normalized path, or more than eight entries.

## WebXR and controllers

- **Enter AR / Enter VR are disabled**: the page is not in a secure context, the browser lacks WebXR, or the headset runtime is not running. The desktop simulator still works.
- **The trigger does not start talking**: only the right controller's trigger is push-to-talk, and only when it is not aimed at the artifact panel and no turn is in progress (`thinking`, `working` or `speaking`).
- **The panel will not move**: in XR, squeeze the grip while aiming at the panel, or drag the page itself (not a control) with the trigger. On a desktop, drag with the primary mouse button. The panel stops at its placement bounds; **Reset** returns it to where it opened.
- **Text labels are missing in the scene**: in-world text needs fonts from `cdn.jsdelivr.net`; check network access from the headset.
- **The avatar takes long to appear**: the 2x4 model is about 38 MB and loads once per page load.

## Startup and ports

| Message | Fix |
| --- | --- |
| `Required loopback port N unavailable; stop its owner yourself or configure another port.` | Something already uses that port, often your development servers. Stop it yourself, or set `REALHERMES_PORT` / `REALHERMES_AUDIO_PORT`. |
| `Unable to launch dev:full. Ensure port 9119 is free and Hermes is installed on PATH.` | Free 9119, and put `hermes` on `PATH`. |
| `Required audio service exited.` | The Hermes bootstrap failed: check `HERMES_PYTHON` with `npm run doctor`. Hermes versions without the required hook fail with `Unsupported Hermes production bootstrap` when you run `HERMES_PYTHON scripts/hermes-production.py` by hand. |
| `Required app service exited.` | Usually an invalid setting (`Invalid REALHERMES_LOCAL_ARTIFACT_ROOTS`, `Invalid REALHERMES_POPPLER_DIR`) or a missing build; run `npm run doctor`, then `npm run build`. |
| `Local readiness timed out.` | The services did not become ready within 30 seconds; check the Hermes installation and ports. |
| `Production build unavailable` (when starting the production server directly) | `dist/index.html` is missing; run `npm run build`. `npm run prod` always builds first. |

npm 11 may print `install scripts not yet covered by allowScripts` for `esbuild` and `fsevents` during `npm ci`. RealHermes works without them; see [installation.md](installation.md#3-get-realhermes).
