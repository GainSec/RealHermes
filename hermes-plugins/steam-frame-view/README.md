# steam-frame-view

A Hermes Agent tool plugin that gives Hermes one fresh still of what the Steam Frame wearer currently sees. RealHermes' relay tells Hermes to call it whenever an answer depends on the wearer's view; Hermes then inspects the still with its built-in `vision_analyze` tool.

- Tool: `steam_frame_capture` (no arguments). Returns the internal path, size and timestamp of a new JPEG, or one of a few fixed error messages.
- How: one fixed command over `ssh frame`: Framecorder records one second of the right-eye panel view (`--source panel`, so passthrough is included when active), ffmpeg extracts the middle frame, and only the JPEG bytes come back. Nothing from the conversation or environment reaches the command.
- Bounds: 25 s, 8 MiB, JPEG magic and sane dimensions checked, written atomically into `~/.hermes/cache/steam-frame-view/` (owner-only; newest eight kept).

Install into a Hermes profile and enable:

```sh
cp -R hermes-plugins/steam-frame-view ~/.hermes/plugins/
hermes plugins enable steam-frame-view
```

Requirements: the Hermes machine can `ssh frame` without prompts (alias, key, trusted host key); the headset has `~/.local/bin/framecorder` and `ffmpeg`. Tests: `python3 -m unittest discover hermes-plugins/steam-frame-view/tests`.
