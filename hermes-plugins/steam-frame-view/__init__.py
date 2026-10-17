"""steam-frame-view: a Hermes tool that captures what the Steam Frame wearer currently sees."""
from __future__ import annotations

import os
from pathlib import Path

from . import capture

SCHEMA = {
    "name": "steam_frame_capture",
    "description": (
        "Take a fresh still of what the Steam Frame headset wearer is seeing right now: the panel view, "
        "including the real-world passthrough scene when active. Use it whenever an answer depends on "
        "the wearer's current view, then inspect the returned image_path with vision_analyze. Each call "
        "captures a new frame; it takes no arguments."),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def _directory() -> Path:
    # Resolved per call so the active profile's media cache is used (vision_analyze may read cache/).
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "cache" / "steam-frame-view"


def steam_frame_capture(args: dict, **kwargs) -> str:
    """Model arguments are ignored: the device, host and command are fixed."""
    return capture.tool_result(_directory)


def register(ctx):
    ctx.register_tool(name="steam_frame_capture", toolset="steam_frame", schema=SCHEMA, handler=steam_frame_capture,
                      check_fn=lambda: os.access("/usr/bin/ssh", os.X_OK))
