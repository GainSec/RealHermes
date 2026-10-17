"""Capture core: fixed command, bounded process, validated private atomic JPEG, sanitized failures."""
import json
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import capture  # noqa: E402


def jpeg(width=1920, height=1080, *, eoi=True):
    """A minimal JPEG shaped like ffmpeg's: SOI, COM, SOF0, SOS, entropy data, EOI."""
    sof = b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    sos = b"\xff\xda\x00\x0c\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00"
    return b"\xff\xd8" + b"\xff\xfe\x00\x08Lavc61" + sof + sos + b"\x12\x34\x56" + (b"\xff\xd9" if eoi else b"")


class Recorder:
    def __init__(self, result):
        self.calls, self.result = [], result

    def __call__(self, argv, timeout, limit):
        self.calls.append((argv, timeout, limit))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sfv-test-")).resolve()
        self.directory = self.root / "steam-frame-view"

    def tearDown(self):
        for path in sorted(self.root.rglob("*"), reverse=True):
            path.unlink() if path.is_file() or path.is_symlink() else path.rmdir()
        self.root.rmdir()

    def files(self):
        return sorted(p.name for p in self.directory.iterdir()) if self.directory.exists() else []

    def test_runs_one_fixed_ssh_command_with_time_and_size_bounds(self):
        run = Recorder(jpeg())
        capture.capture(self.directory, run=run)
        capture.capture(self.directory, run=run)
        self.assertEqual(len(run.calls), 2)
        self.assertEqual(run.calls[0], run.calls[1])  # nothing per-call (or per-request) reaches the command
        argv, timeout, limit = run.calls[0]
        self.assertEqual(argv[0], "/usr/bin/ssh")
        self.assertIn("BatchMode=yes", argv)
        remote = argv[-1]
        self.assertEqual(argv[-2], "frame")
        self.assertIn("/home/steamos/.local/bin/framecorder", remote)
        self.assertIn("--source panel", remote)
        self.assertIn("--duration 1", remote)
        self.assertIn("/usr/bin/ffmpeg", remote)
        self.assertNotIn("/dev/video99", remote)
        self.assertEqual((timeout, limit), (25, 8 * 1024 * 1024))

    def test_saves_a_private_atomic_jpeg_and_returns_metadata(self):
        result = capture.capture(self.directory, run=Recorder(jpeg(1920, 1080)), clock=lambda: 1_760_000_000.25)
        self.assertTrue(result["success"])
        path = Path(result["image_path"])
        self.assertEqual(path.parent, self.directory)
        self.assertRegex(path.name, r"^capture-20251009T085320250Z-[0-9a-f]{8}\.jpg$")
        self.assertEqual(path.read_bytes(), jpeg(1920, 1080))
        self.assertEqual((result["width"], result["height"], result["size_bytes"]), (1920, 1080, len(jpeg())))
        self.assertEqual(result["captured_at"], "2025-10-09T08:53:20.250Z")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        self.assertEqual(self.files(), [path.name])  # no temp file left behind
        self.assertIn("vision_analyze", result["next_step"])

    def test_rejects_anything_but_a_complete_sane_jpeg_and_keeps_nothing(self):
        for data in [b"", b"not a jpeg", jpeg(eoi=False), jpeg(0, 1080), jpeg(1920, 0), jpeg(20000, 1080), b"\xff\xd8\xff\xd9", b"\xff\xd8\xff\xe0\x00\x02" + b"\xff\xd9"]:
            result = capture.capture(self.directory, run=Recorder(data))
            self.assertEqual(result, {"success": False, "error": "Steam Frame view capture failed: the headset returned an invalid image."}, data[:16])
            self.assertEqual(self.files(), [])

    def test_sanitizes_capture_failures(self):
        cases = [
            (capture.CaptureError("timeout"), "Steam Frame view capture failed: the headset did not respond in time."),
            (capture.CaptureError("too_large"), "Steam Frame view capture failed: the headset returned an invalid image."),
            (capture.CaptureError("unavailable"), "Steam Frame view capture failed: the headset view is unavailable (is the Frame awake and SteamVR running?)."),
            (OSError("/home/example/.ssh/id_ed25519 permission denied"), "Steam Frame view capture failed: the headset view is unavailable (is the Frame awake and SteamVR running?)."),
        ]
        for error, message in cases:
            text = capture.tool_result(self.directory, run=Recorder(error))
            self.assertEqual(json.loads(text), {"success": False, "error": message})
            self.assertNotIn(".ssh", text)
        self.assertEqual(self.files(), [])

    def test_tool_result_is_json_and_never_raises(self):
        self.assertEqual(json.loads(capture.tool_result(self.directory, run=Recorder(RuntimeError("boom /secret")))),
                         {"success": False, "error": "Steam Frame view capture failed: the headset view is unavailable (is the Frame awake and SteamVR running?)."})
        self.assertTrue(json.loads(capture.tool_result(self.directory, run=Recorder(jpeg())))["success"])

    def test_rejects_a_capture_whose_file_is_not_fresh(self):
        result = capture.capture(self.directory, run=Recorder(jpeg()), clock=lambda: time.time() + 3600)
        self.assertEqual(result, {"success": False, "error": "Steam Frame view capture failed: the capture could not be saved."})
        self.assertEqual(self.files(), [])

    def test_refuses_a_symlinked_capture_directory(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.directory.symlink_to(elsewhere)
        result = capture.capture(self.directory, run=Recorder(jpeg()))
        self.assertEqual(result, {"success": False, "error": "Steam Frame view capture failed: the capture could not be saved."})
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_keeps_only_the_newest_captures(self):
        names = []
        for second in range(capture.KEEP + 3):
            names.append(Path(capture.capture(self.directory, run=Recorder(jpeg()), clock=lambda s=second: time.time() + s * 0.001)["image_path"]).name)
        self.assertEqual(self.files(), sorted(names)[-capture.KEEP:])


class BoundedRunTests(unittest.TestCase):
    def test_returns_stdout_of_a_successful_process(self):
        self.assertEqual(capture.run_bounded(("/bin/echo", "frame"), 5, 1024), b"frame\n")

    def test_kills_a_process_that_outlives_the_deadline(self):
        started = time.monotonic()
        with self.assertRaises(capture.CaptureError) as caught:
            capture.run_bounded(("/bin/sleep", "30"), 0.5, 1024)
        self.assertEqual(str(caught.exception), "timeout")
        self.assertLess(time.monotonic() - started, 5)

    def test_stops_reading_past_the_size_limit(self):
        with self.assertRaises(capture.CaptureError) as caught:
            capture.run_bounded(("/usr/bin/yes",), 5, 4096)
        self.assertEqual(str(caught.exception), "too_large")

    def test_reports_a_failed_process_as_unavailable(self):
        with self.assertRaises(capture.CaptureError) as caught:
            capture.run_bounded(("/usr/bin/false",), 5, 1024)
        self.assertEqual(str(caught.exception), "unavailable")


if __name__ == "__main__":
    unittest.main()
