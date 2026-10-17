"""Start only the owned, headless loopback audio backend; never attach/reclaim.

Use the Python interpreter from the Hermes installation (HERMES_PYTHON).
No token arguments, token files, or host rendezvous records are created here.
"""
import os
from pathlib import Path

# This child serves only RealHermes audio. Give it an isolated Hermes home so
# loading the audio backend cannot block on the operator profile's external
# secret sources (for example, a slow 1Password CLI). No credentials are needed.
_operator_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
_audio_home = _operator_home / "cache" / "realhermes-audio-home"
_audio_home.mkdir(mode=0o700, parents=True, exist_ok=True)
os.environ["HERMES_HOME"] = str(_audio_home)

import hermes_bootstrap  # Activates the selected Hermes runtime dependencies.
from hermes_cli import web_server

# Hermes publishes its session token to a host rendezvous file by default.
# This launcher owns this backend directly and does not need that discovery.
# Fail closed on incompatible Hermes versions instead of silently publishing.
if not callable(getattr(web_server, "_publish_host_rendezvous", None)):
    raise RuntimeError("Unsupported Hermes production bootstrap")
web_server._publish_host_rendezvous = lambda *_args, **_kwargs: None
web_server.start_server(
    host="127.0.0.1",
    port=int(os.environ.get("REALHERMES_AUDIO_PORT", "9119")),
    headless=True,
    isolated=True,
    open_browser=False,
)
