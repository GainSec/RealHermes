---
name: realhermes-operator
description: Use when asked to install, run, troubleshoot or extend RealHermes (the 2x4 WebXR companion for Hermes Agent).
version: 1.0.0
author: GainSec
license: CC0-1.0
metadata:
  hermes:
    tags: [realhermes, hermes-agent, webxr, steam-frame, operations]
---

# RealHermes operator

## When to use

The person wants RealHermes installed, started, checked, fixed or changed: the browser app plus loopback relay that gives a Hermes Agent a 3D companion (2x4) on a desktop or in a WebXR headset.

## Workflow

1. Locate the checkout (the folder containing `AGENTS.md` and `package.json` with `"name": "realhermes"`). Read `AGENTS.md` fully before acting; it holds the rules, commands and file map. Do not improvise from memory.
2. Install or check: `npm ci`, `npm run setup:env`, then `npm run doctor`. Fix what doctor reports before starting anything. Never print or paste the contents of `.env`.
3. Run with the mode the person wants: `npm run dev:full` (development with voice), `npm run dev` (development with an external audio backend), `npm run prod` (daily use and headsets). Both production and `dev:full` default to ports 5173 and 9119: never run both, and never kill whatever holds a busy port; report it instead.
4. Troubleshoot by boundary, using the symptom table in `AGENTS.md` and then `docs/troubleshooting.md`. Check `/api/health`, then the gateway (`curl http://127.0.0.1:8642/health`), then audio, then the artifact log (`REALHERMES_LOG_FILE`), then the headset (secure context, tunnel, SteamVR awake).
5. For headset vision, install the bundled plugin from `hermes-plugins/steam-frame-view/` into the Hermes profile and enable it (`hermes plugins enable steam-frame-view`), then restart the gateway and confirm a `steam_frame_capture` call appears for a visual question.
6. For changes (new setting, new companion model, new name), follow the matching section of `AGENTS.md`: write the failing test first, keep credentials server-side, keep fixtures synthetic, update `.env.example` and `docs/`.
7. Before reporting success, run `npm run verify` and state plainly which manual checks (scene, microphone, speech, XR) you could not perform.

## Hard rules

- No credentials in `VITE_*` variables or anywhere the browser can read.
- No killing processes the launchers did not start; no `pkill -f`.
- No commits of `.env`, `dist/`, `node_modules/`, captures or logs.
- No changes to Hermes' own configuration (model, providers, approvals, gateway); tell the person what to change in Hermes instead.

## Install this skill

Copy this folder into the Hermes skills tree, for example `cp -R hermes-skills/realhermes-operator ~/.hermes/skills/software-development/`, and it becomes available to the agent on its next session.
