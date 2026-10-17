"""Take one fresh JPEG still of the Steam Frame wearer's panel view and save it privately.

Framecorder's panel source captures what the wearer actually sees, including passthrough.  The
SteamVR V4L2 loopback does not: transparent passthrough pixels appear dark there.  Nothing from
the conversation, model, or environment reaches the command: ssh runs one fixed remote command
on the fixed ``frame`` alias, bounded in time and output size.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import secrets
import select
import signal
import stat
import subprocess
import time
from pathlib import Path

# ssh hands the remote command to the Frame's login shell, so it is a single constant literal.
# A private throwaway directory avoids collisions between concurrent captures and is removed by
# the remote shell's trap.  Only ffmpeg's final JPEG reaches stdout.
REMOTE_COMMAND = (
    "set -eu; d=$(/usr/bin/mktemp -d /tmp/hermes-frame-view.XXXXXX); "
    "trap '/usr/bin/rm -rf -- \"$d\"' EXIT HUP INT TERM; "
    "/home/steamos/.local/bin/framecorder --view eye --source panel --eye right --aspect 16:9 "
    "--width 1280 --fps 5 --codec h264 --bitrate 8 --no-audio --duration 1 --no-perf-log "
    "\"$d/view.mp4\" >/dev/null 2>&1; "
    "/usr/bin/ffmpeg -hide_banner -loglevel error -nostdin -ss 0.5 -i \"$d/view.mp4\" "
    "-frames:v 1 -q:v 3 -f image2pipe -c:v mjpeg -"
)
ARGV = ("/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=1", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
        "-o", "ForkAfterAuthentication=no", "-o", "PermitLocalCommand=no", "-o", "ClearAllForwardings=yes",
        "frame", REMOTE_COMMAND)
TIMEOUT_SECONDS = 25
MAX_BYTES = 8 * 1024 * 1024
KEEP = 8
# A saved file older than the capture that produced it (beyond clock granularity) is not this capture.
CLOCK_SKEW_SECONDS = 2
_SSH_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "TMPDIR")
_NAME = re.compile(r"^capture-\d{8}T\d{9}Z-[0-9a-f]{8}\.jpg$")
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
_FAILED = "Steam Frame view capture failed: "
_INVALID = _FAILED + "the headset returned an invalid image."
_ERRORS = {
    "timeout": _FAILED + "the headset did not respond in time.",
    "unavailable": _FAILED + "the headset view is unavailable (is the Frame awake and SteamVR running?).",
    "invalid": _INVALID, "too_large": _INVALID,
    "storage": _FAILED + "the capture could not be saved.",
}


class CaptureError(Exception):
    """A capture failure; the message is one of the fixed reasons above, never process output."""


def run_bounded(argv, timeout, limit) -> bytes:
    """Run ``argv`` with no shell, returning stdout; kill the whole process group on any failure."""
    process = subprocess.Popen(
        argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
        env={key: os.environ[key] for key in _SSH_ENV if key in os.environ})
    deadline, chunks, size = time.monotonic() + timeout, [], 0
    try:
        descriptor = process.stdout.fileno()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([descriptor], [], [], remaining)[0]:
                raise CaptureError("timeout")
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise CaptureError("too_large")
            chunks.append(chunk)
        try:
            code = process.wait(max(deadline - time.monotonic(), 0.01))
        except subprocess.TimeoutExpired:
            raise CaptureError("timeout") from None
        if code != 0:
            raise CaptureError("unavailable")
        return b"".join(chunks)
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
            process.wait()
        process.stdout.close()


def jpeg_size(data: bytes):
    """(width, height) of a complete JPEG with sane dimensions, else None."""
    if len(data) < 4 or data[:3] != b"\xff\xd8\xff" or data[-2:] != b"\xff\xd9":
        return None
    offset = 2
    while offset + 4 <= len(data) and data[offset] == 0xFF:
        marker = data[offset + 1]
        if marker == 0xFF:  # fill byte
            offset += 1
            continue
        length = int.from_bytes(data[offset + 2:offset + 4], "big")
        if marker == 0xDA or length < 2 or offset + 2 + length > len(data):
            return None
        if marker in _SOF:
            if length < 8:
                return None
            height = int.from_bytes(data[offset + 5:offset + 7], "big")
            width = int.from_bytes(data[offset + 7:offset + 9], "big")
            return (width, height) if 16 <= width <= 8192 and 16 <= height <= 8192 else None
        offset += 2 + length
    return None


def _open_private_directory(directory: Path) -> int:
    """A descriptor for our own 0700 directory; refuses a symlink or a directory owned by someone else."""
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(descriptor)
    if info.st_uid != os.getuid():
        os.close(descriptor)
        raise CaptureError("storage")
    if stat.S_IMODE(info.st_mode) != 0o700:
        os.fchmod(descriptor, 0o700)
    return descriptor


def _save(directory: Path, data: bytes, captured: float) -> str:
    """Write ``data`` atomically under a new name, verify what landed, prune old captures."""
    stamp = datetime.datetime.fromtimestamp(captured, datetime.timezone.utc)
    name = f"capture-{stamp:%Y%m%dT%H%M%S}{stamp.microsecond // 1000:03d}Z-{secrets.token_hex(4)}.jpg"
    temporary = f".{name}.tmp"
    folder = _open_private_directory(directory)
    try:
        try:
            output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=folder)
            try:
                view = memoryview(data)
                while view:
                    view = view[os.write(output, view):]
                os.fsync(output)
            finally:
                os.close(output)
            os.replace(temporary, name, src_dir_fd=folder, dst_dir_fd=folder)
        finally:
            try:
                os.unlink(temporary, dir_fd=folder)
            except FileNotFoundError:
                pass
        try:
            saved = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)
            try:
                info = os.fstat(saved)
                if (not stat.S_ISREG(info.st_mode) or info.st_size != len(data)
                        or info.st_mtime < captured - CLOCK_SKEW_SECONDS or os.read(saved, len(data) + 1) != data):
                    raise CaptureError("storage")
            finally:
                os.close(saved)
        except BaseException:
            os.unlink(name, dir_fd=folder)
            raise
        for old in sorted(entry for entry in os.listdir(folder) if _NAME.match(entry))[:-KEEP]:
            try:
                os.unlink(old, dir_fd=folder)
            except OSError:
                pass
    finally:
        os.close(folder)
    return str(directory / name)


def capture(directory: Path, *, run=run_bounded, clock=time.time) -> dict:
    """Capture, validate and save one still; a metadata or sanitized-error dict."""
    captured = clock()
    try:
        try:
            data = run(ARGV, TIMEOUT_SECONDS, MAX_BYTES)
        except OSError:
            raise CaptureError("unavailable") from None
        size = jpeg_size(data)
        if size is None:
            raise CaptureError("invalid")
        try:
            path = _save(Path(directory), data, captured)
        except OSError:
            raise CaptureError("storage") from None
    except CaptureError as error:
        return {"success": False, "error": _ERRORS.get(str(error), _ERRORS["unavailable"])}
    stamp = datetime.datetime.fromtimestamp(captured, datetime.timezone.utc)
    return {
        "success": True, "image_path": path,
        "captured_at": f"{stamp:%Y-%m-%dT%H:%M:%S}.{stamp.microsecond // 1000:03d}Z",
        "width": size[0], "height": size[1], "size_bytes": len(data),
        "view": "The Steam Frame wearer's current panel view, including real-world passthrough when active.",
        "next_step": ("Inspect it with vision_analyze using image_path. The file is internal: never put its path, "
                      "a link to it or a MEDIA: attachment for it in your reply."),
    }


def tool_result(directory, *, run=run_bounded, clock=time.time) -> str:
    """The tool handler's JSON string (``directory`` may be a callable resolved here); any unexpected
    error becomes the generic unavailable result."""
    try:
        return json.dumps(capture(directory() if callable(directory) else directory, run=run, clock=clock))
    except Exception:
        return json.dumps({"success": False, "error": _ERRORS["unavailable"]})
