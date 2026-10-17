# Production operation

`npm run prod` is the everyday way to run RealHermes, especially with a headset. It builds once, then serves the built app and `/api` from one loopback origin (default `http://127.0.0.1:5173`). It starts and owns a headless Hermes audio backend and, optionally, keeps a reverse SSH tunnel to the headset. There is no Vite dev server, hot reload or proxy. App behavior is the same as in development.

## Before you start

- Dependencies are installed with `npm ci` (including development dependencies, which the build and the `tsx` runtime need).
- `HERMES_PYTHON` points at the Python interpreter inside your Hermes installation, or that interpreter is `python3` on `PATH`. The bootstrap needs Hermes' dashboard and audio dependencies and configured speech providers. `npm run doctor` checks that it can import `hermes_bootstrap`.
- The Hermes gateway is running and managed by you. Put `HERMES_API_KEY` (or `API_SERVER_KEY`) and, if needed, `HERMES_CHAT_BASE_URL` in your shell or `.env`. Without a key the app and audio still work, but chat returns 503. A configured key is not proof that the gateway is reachable.
- The app port and the audio port are free and different. The defaults, 5173 and 9119, are the same ones `npm run dev:full` uses, so stop your development servers first or choose other ports.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REALHERMES_PORT` | `5173` | Loopback port for the app and API |
| `REALHERMES_AUDIO_PORT` | `9119` | Loopback port of the owned audio backend |
| `HERMES_PYTHON` | `python3` | Interpreter with Hermes installed |
| `REALHERMES_TUNNEL` | `0` | `1` enables the reverse SSH tunnel |
| `REALHERMES_SSH_ALIAS` | `frame` | SSH alias, hostname or IPv4 address of the headset |
| `REALHERMES_FRAME_PORT` | `5173` | Loopback port on the headset |
| `REALHERMES_LOG_FILE` | `~/.hermes/logs/realhermes-relay.log` | The relay's sanitized artifact diagnostics (JSON lines) |

Approved folders and Poppler are configured as in development; see [configuration.md](configuration.md). They reach only the app process, never the audio child or SSH.

## Start and readiness

```sh
npm run prod
# with automatic headset reconnects:
REALHERMES_TUNNEL=1 npm run prod
```

The command builds, then runs the launcher in the foreground; keep the terminal open. To restart an already built version without rebuilding, run `node scripts/production.mjs` from the repository root.

The launcher:

1. validates its settings and checks both ports, refusing to start (and stopping nothing) if either is busy;
2. generates a new random audio session token, kept only in memory and in the two child environments;
3. starts exactly two processes, the Hermes audio backend and the production server;
4. waits up to 30 seconds for real local checks: `/api/ready` must report a running app with audio configured, and the audio backend's `/api/host/identity` must accept the session token;
5. prints `Local services ready: http://127.0.0.1:<port>; chat configured|not configured; audio configured; upstream connectivity not probed.`

This proves that the local processes are up and that the token is accepted. It does not prove that the speech providers, the chat gateway or a live voice turn work. If readiness fails, or any required child exits (even with status 0), the launcher stops what it started and exits with status 1.

## Connecting a headset over SSH

The headset reaches the app at its own loopback address through a reverse SSH tunnel. That keeps the browser in a secure context, which microphone access and WebXR require, without exposing anything to your network.

1. Enable an SSH server on the headset using its operating system's developer options, and make sure you can log in from the host with a key.
2. Add an alias to `~/.ssh/config` on the host, with your own values:

   ```text
   Host frame
     HostName <headset-hostname-or-ip>
     User <headset-user>
     IdentityFile ~/.ssh/<your-key>
   ```

3. Connect once interactively (`ssh frame true`) to verify and record the host key. The launcher uses batch mode and will not prompt.
4. Make sure the headset's SSH server allows remote forwarding (`AllowTcpForwarding` must not be `no`) and binds forwards to loopback (`GatewayPorts no`, the default). Do not add other forwards or `SendEnv` options for this alias.
5. Start with the tunnel and your alias:

   ```sh
   REALHERMES_TUNNEL=1 REALHERMES_SSH_ALIAS=frame npm run prod
   ```

6. On the headset, open `http://127.0.0.1:5173`, or `http://127.0.0.1:<REALHERMES_FRAME_PORT>` if you changed it. The host's app port can differ from the headset port. Never put a host path or a token in the headset URL.

The tunnel runs `ssh -N -T` with `BatchMode=yes`, `ExitOnForwardFailure=yes`, `ConnectTimeout=10`, `ServerAliveInterval=10`, `ServerAliveCountMax=3`, connection sharing disabled, `ForkAfterAuthentication=no` and `PermitLocalCommand=no`. It forwards `127.0.0.1:<headset port>` to `127.0.0.1:<app port>` and nothing else: the audio backend and the gateway stay on the host.

For development servers, run an equivalent tunnel yourself, for example `ssh -N -R 127.0.0.1:5173:127.0.0.1:5173 frame`. Do not run a manual tunnel on the same headset port as the launcher.

### Reconnects

The tunnel starts after local readiness. If the headset sleeps, reboots or disconnects, local services keep running. Keepalives detect silent drops. After an SSH process exits, the launcher waits for it to close and retires its process group with a 3-second grace period. It then retries after 1, 2, 4, 8, 16 and then every 30 seconds, so 4 to 33 seconds pass between attempts, and only one attempt runs at a time. A connection that lasted at least 60 seconds resets the delay. Status lines say "connecting" or "retrying"; the launcher does not probe the headset. When the headset is back, reload its page. A busy headset port causes retries, not a takeover: stop whatever owns it yourself, or choose another `REALHERMES_FRAME_PORT`.

## Health checks

On the host (substitute your port):

```sh
curl --fail http://127.0.0.1:5173/api/health      # {"status":"ok","chatConfigured":...,"audioConfigured":...}
curl --fail http://127.0.0.1:5173/api/ready       # {"appRunning":true,...,"upstreamConnectivity":"not-probed"}
curl -I http://127.0.0.1:5173/                    # the app shell, with security headers
curl -i http://127.0.0.1:5173/api/no-such-route   # a JSON 404, never the app shell
```

On the headset, `http://127.0.0.1:<headset port>/api/health` answers through the tunnel. These endpoints report configuration only; they expose no credentials, URLs or paths. `/api/ready` returns 503 while the server shuts down. Check real chat and voice from the app itself.

## Stop, logs and recovery

- **Stop:** press Ctrl-C in the launcher terminal, or send `SIGTERM` to the launcher. Stopping is idempotent and cancels readiness checks and retries at once. Only the launcher's own process groups receive `SIGTERM`, escalated to `SIGKILL` after 3 seconds. The production server closes connections and deletes its artifact cache. Exit codes: 130 (`SIGINT`), 143 (`SIGTERM`), 1 (startup or service failure). Do not use `hermes serve --stop` or broad `pkill` commands for this workflow.
- **Logs:** the launcher terminal is the log. It shows startup, readiness, configuration status, tunnel attempts and delays, failures and shutdown. You may redirect it to a file. Child output is deliberately suppressed because Hermes and SSH diagnostics can contain secrets or paths, so diagnose a failing child outside the running session, for example with `npm run doctor` or by starting Hermes by hand. Never dump an environment that contains credentials. The production app separately appends its own sanitized artifact diagnostics to `REALHERMES_LOG_FILE` (default `~/.hermes/logs/realhermes-relay.log`, created `0600` in a `0700` folder): one JSON line per link attempt with the host, path, a reason code such as `http_404` and verified page counts, never queries, headers, bodies or tokens. That file is what the in-headset answer "I errored out while loading the artifact. Check the logs." refers to.
- **Recovery:** for a local failure, check the build, the ports and `HERMES_PYTHON`, then restart. For a tunnel failure, check the headset's power and network, the alias, its key and host key, and the headset port, and leave the launcher running to reconnect. A forced kill can leave an old artifact cache in `$TMPDIR`; the next start creates a fresh one and never reuses old IDs.

## Development versus production

| | Development | Production |
| --- | --- | --- |
| Command | `npm run dev` / `npm run dev:full` | `npm run prod` |
| Origin | Vite on 5173 proxying `/api` to the relay on 3001 | One Express origin on `REALHERMES_PORT` |
| Audio backend | Yours (`dev`) or `hermes serve` on 9119 (`dev:full`) | Owned headless backend on `REALHERMES_AUDIO_PORT` |
| Headset tunnel | Manual | Optional, owned, reconnecting |
| Child output | Shown | Suppressed |
| Security headers | Vite defaults | Production policy ([security-privacy.md](security-privacy.md#browser-hardening)) |

Never run development and production on the same ports. Running the launcher under launchd or systemd is not covered by this guide. If you do it, set `PATH` (or `REALHERMES_POPPLER_DIR`) and `HERMES_PYTHON` explicitly, because service managers start with a minimal environment.
