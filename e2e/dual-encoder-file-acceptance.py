#!/usr/bin/env python3
"""File-level acceptance for one snapshot rendered by browser and FFmpeg.

This is intentionally an explicit E2E harness, not part of the fast unit-test
suite. It uses the production browser quick-export function in real Chrome and
the production FFmpeg adapter, then validates the resulting MP4 files without
requiring encoder-identical pixels. No Provider or external network is used.
"""

from __future__ import annotations

import contextlib
import hashlib
import http.server
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse

try:
    from playwright.sync_api import sync_playwright
except ImportError as error:  # pragma: no cover - explicit E2E prerequisite
    raise SystemExit(
        "Python Playwright is required. Install it and Chromium, or set "
        "MANJU_E2E_BROWSER to a Chrome executable."
    ) from error


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / "output" / "playwright" / "dual-encoder"
FRAME_WIDTH = 160
FRAME_HEIGHT = 90


def binary_path(package: str) -> str:
    return subprocess.check_output(
        ["node", "-e", f"console.log(require('{package}').path || require('{package}'))"],
        cwd=ROOT,
        text=True,
    ).strip()


FFMPEG = binary_path("ffmpeg-static")
FFPROBE = binary_path("@ffprobe-installer/ffprobe")


def browser_executable() -> str | None:
    configured = os.environ.get("MANJU_E2E_BROWSER", "").strip()
    candidates = [
        configured,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
    ]
    return next((value for value in candidates if value and Path(value).is_file()), None)


def run(command: list[str], *, binary: bool = False) -> bytes | str:
    completed = subprocess.run(command, cwd=ROOT, check=True, capture_output=True)
    if binary:
        return completed.stdout
    return completed.stdout.decode("utf-8", errors="replace")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path) -> dict:
    payload = run([
        FFPROBE,
        "-v", "error",
        "-count_frames",
        "-show_entries",
        "format=format_name,duration:stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,sample_rate,channels,duration,nb_frames,nb_read_frames",
        "-of", "json",
        str(path),
    ])
    assert isinstance(payload, str)
    return json.loads(payload)


def fraction(value: str) -> float:
    numerator, denominator = value.split("/", 1)
    return float(numerator) / float(denominator)


def stream(payload: dict, kind: str) -> dict:
    return next(item for item in payload["streams"] if item.get("codec_type") == kind)


def frame_count(video: dict) -> int:
    raw = video.get("nb_read_frames") or video.get("nb_frames")
    if raw in {None, "N/A"}:
        raise AssertionError(f"video frame count is unavailable: {video}")
    return int(raw)


def validate_probe(path: Path, expected: dict) -> dict:
    payload = probe(path)
    video = stream(payload, "video")
    audio = stream(payload, "audio")
    assert video["codec_name"] == "h264", video
    assert (int(video["width"]), int(video["height"])) == (1280, 720), video
    assert video["pix_fmt"] == "yuv420p", video
    assert math.isclose(fraction(video["avg_frame_rate"]), expected["frameRate"], abs_tol=0.001), video
    count = frame_count(video)
    assert count == expected["totalFrames"], (path, count)
    video_duration = float(video.get("duration") or expected["durationSeconds"])
    assert abs(video_duration - expected["durationSeconds"]) <= 1 / expected["frameRate"], video
    format_duration = float(payload["format"]["duration"])
    # WebCodecs AAC may expose up to four 1024-sample priming/padding packets
    # in the MP4 format duration even though the video track remains exactly
    # frame-aligned. Bound that known encoder difference instead of pretending
    # the containers are byte/pixel identical.
    assert abs(format_duration - expected["durationSeconds"]) <= 0.10, payload
    assert audio["codec_name"] == "aac", audio
    assert int(audio["sample_rate"]) == expected["audioSampleRate"], audio
    assert int(audio["channels"]) == 2, audio
    audio_duration = float(audio.get("duration") or format_duration)
    assert abs(audio_duration - expected["durationSeconds"]) <= 0.10, audio
    return {
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
        "durationSeconds": format_duration,
        "videoDurationSeconds": video_duration,
        "frameCount": count,
        "video": {
            "codec": video["codec_name"],
            "width": int(video["width"]),
            "height": int(video["height"]),
            "fps": fraction(video["avg_frame_rate"]),
        },
        "audio": {
            "codec": audio["codec_name"],
            "sampleRate": int(audio["sample_rate"]),
            "channels": int(audio["channels"]),
            "durationSeconds": audio_duration,
        },
    }


def assert_no_black_or_silence(path: Path) -> dict:
    black = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-i", str(path), "-vf", "blackdetect=d=0.08:pic_th=0.98", "-an", "-f", "null", "-"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stderr
    silence = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostdin", "-i", str(path), "-af", "silencedetect=noise=-50dB:d=0.15", "-vn", "-f", "null", "-"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stderr
    black_durations = [float(value) for value in re.findall(r"black_duration:([0-9.]+)", black)]
    silence_starts = re.findall(r"silence_start:", silence)
    assert not black_durations, (path, black_durations)
    assert not silence_starts, (path, silence)
    return {"blackIntervals": 0, "silenceIntervals": 0}


def raw_frame(path: Path, seconds: float) -> bytes:
    payload = run([
        FFMPEG,
        "-v", "error",
        "-nostdin",
        "-i", str(path),
        "-ss", f"{seconds:.6f}",
        "-frames:v", "1",
        "-vf", f"scale={FRAME_WIDTH}:{FRAME_HEIGHT}:flags=bilinear",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
        "pipe:1",
    ], binary=True)
    assert isinstance(payload, bytes)
    expected_size = FRAME_WIDTH * FRAME_HEIGHT * 3
    assert len(payload) == expected_size, (path, seconds, len(payload))
    return payload


def raw_frame_at_index(path: Path, frame_index: int) -> bytes:
    payload = run([
        FFMPEG,
        "-v", "error",
        "-nostdin",
        "-i", str(path),
        "-vf", f"select=eq(n\\,{frame_index}),scale={FRAME_WIDTH}:{FRAME_HEIGHT}:flags=bilinear",
        "-vsync", "0",
        "-frames:v", "1",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
        "pipe:1",
    ], binary=True)
    assert isinstance(payload, bytes)
    expected_size = FRAME_WIDTH * FRAME_HEIGHT * 3
    assert len(payload) == expected_size, (path, frame_index, len(payload))
    return payload


def mean_color(frame: bytes, *, top_fraction: float = 0.65) -> tuple[float, float, float]:
    rows = max(1, round(FRAME_HEIGHT * top_fraction))
    pixels = FRAME_WIDTH * rows
    totals = [0, 0, 0]
    for offset in range(0, pixels * 3, 3):
        totals[0] += frame[offset]
        totals[1] += frame[offset + 1]
        totals[2] += frame[offset + 2]
    return tuple(value / pixels for value in totals)


def white_ratio(frame: bytes) -> float:
    start_row = round(FRAME_HEIGHT * 0.68)
    end_row = round(FRAME_HEIGHT * 0.98)
    white = 0
    total = FRAME_WIDTH * (end_row - start_row)
    for y in range(start_row, end_row):
        for x in range(FRAME_WIDTH):
            offset = (y * FRAME_WIDTH + x) * 3
            # Frames are intentionally downscaled for a codec-independent
            # signal. Antialiasing blends white glyphs into the solid source,
            # so classify by the minimum channel (all fixture backgrounds have
            # two channels near 30) rather than demanding pure white pixels.
            if min(frame[offset], frame[offset + 1], frame[offset + 2]) >= 40:
                white += 1
    return white / total


def validate_frames(path: Path, expected: dict) -> dict:
    samples: dict[float, bytes] = {}
    colors: list[dict] = []
    for item in expected["keyframes"]:
        seconds = float(item["seconds"])
        frame = raw_frame(path, seconds)
        samples[seconds] = frame
        color = mean_color(frame)
        dominant = max(range(3), key=lambda index: color[index])
        assert dominant == item["expectedDominantChannel"], (path, item, color)
        ordered = sorted(color, reverse=True)
        assert ordered[0] - ordered[1] >= 80, (path, item, color)
        colors.append({"seconds": seconds, "label": item["label"], "meanRgb": [round(v, 2) for v in color]})

    # Check the exact one-frame sides of both visual edit points. This catches
    # an encoder that duplicates/drops a frame while still reporting 144 total.
    boundary_colors: list[dict] = []
    for item in expected["visualBoundaries"]:
        boundary = float(item["seconds"])
        before_channel = int(item["beforeChannel"])
        after_channel = int(item["afterChannel"])
        boundary_frame = round(boundary * 24)
        before = mean_color(raw_frame_at_index(path, boundary_frame - 1))
        after = mean_color(raw_frame_at_index(path, boundary_frame))
        assert max(range(3), key=lambda index: before[index]) == before_channel, before
        assert max(range(3), key=lambda index: after[index]) == after_channel, after
        boundary_colors.append({
            "seconds": boundary,
            "beforeRgb": [round(v, 2) for v in before],
            "afterRgb": [round(v, 2) for v in after],
        })

    subtitle_ratios: list[float] = []
    baseline_ratios: list[float] = []
    for cue_seconds, baseline_seconds in zip(
        expected["subtitleSamplesSeconds"], expected["subtitleBaselineSeconds"], strict=True
    ):
        cue_ratio = white_ratio(samples.get(float(cue_seconds)) or raw_frame(path, float(cue_seconds)))
        baseline_ratio = white_ratio(samples.get(float(baseline_seconds)) or raw_frame(path, float(baseline_seconds)))
        assert cue_ratio >= baseline_ratio + 0.0002, (path, cue_seconds, cue_ratio, baseline_ratio)
        subtitle_ratios.append(cue_ratio)
        baseline_ratios.append(baseline_ratio)
    # The fixture deliberately uses monotonically longer text. Proving the
    # three burned-in glyph-density bands are ordered establishes more than a
    # generic "some subtitle exists" check without coupling to a font raster.
    assert subtitle_ratios[1] > subtitle_ratios[0] * 2, (path, subtitle_ratios)
    assert subtitle_ratios[2] > subtitle_ratios[1] * 1.15, (path, subtitle_ratios)
    return {
        "keyframes": colors,
        "boundaries": boundary_colors,
        "subtitleWhiteRatios": [round(value, 6) for value in subtitle_ratios],
        "subtitleBaselineRatios": [round(value, 6) for value in baseline_ratios],
    }


def frequency_at(path: Path, seconds: float) -> float:
    duration = 0.4
    payload = run([
        FFMPEG,
        "-v", "error",
        "-nostdin",
        "-ss", f"{seconds - duration / 2:.6f}",
        "-i", str(path),
        "-t", str(duration),
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-f", "f32le",
        "pipe:1",
    ], binary=True)
    assert isinstance(payload, bytes)
    values = struct.unpack(f"<{len(payload) // 4}f", payload)
    crossings = 0
    previous = 1 if values[0] >= 0 else -1
    for value in values[1:]:
        if abs(value) < 1e-4:
            continue
        current = 1 if value >= 0 else -1
        if current != previous:
            crossings += 1
            previous = current
    return crossings / (2 * duration)


def validate_audio_order(path: Path, expected: dict) -> list[dict]:
    result: list[dict] = []
    last = 0.0
    for item in expected["audioSamples"]:
        measured = frequency_at(path, float(item["seconds"]))
        target = float(item["expectedFrequencyHz"])
        assert abs(measured - target) <= 8, (path, item, measured)
        assert measured > last, (path, result, measured)
        last = measured
        result.append({"seconds": item["seconds"], "frequencyHz": round(measured, 2)})
    return result


def compare_encoder_observations(browser: dict, formal: dict) -> dict:
    assert browser["frameCount"] == formal["frameCount"]
    assert abs(browser["durationSeconds"] - formal["durationSeconds"]) <= 0.10
    assert abs(browser["audio"]["durationSeconds"] - formal["audio"]["durationSeconds"]) <= 0.10
    assert browser["audio"]["sampleRate"] == formal["audio"]["sampleRate"]
    color_deltas: list[float] = []
    for browser_item, formal_item in zip(
        browser["visualEvidence"]["keyframes"], formal["visualEvidence"]["keyframes"], strict=True
    ):
        assert browser_item["label"] == formal_item["label"]
        delta = sum(abs(a - b) for a, b in zip(browser_item["meanRgb"], formal_item["meanRgb"], strict=True)) / 3
        assert delta <= 12, (browser_item, formal_item, delta)
        color_deltas.append(delta)
    frequency_deltas: list[float] = []
    for browser_item, formal_item in zip(browser["audioOrder"], formal["audioOrder"], strict=True):
        delta = abs(browser_item["frequencyHz"] - formal_item["frequencyHz"])
        assert delta <= 4, (browser_item, formal_item)
        frequency_deltas.append(delta)
    return {
        "maxMeanRgbDelta": round(max(color_deltas), 3),
        "maxFrequencyDeltaHz": round(max(frequency_deltas), 3),
    }


class QuietStaticHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".json": "application/json",
        ".js": "text/javascript",
        ".png": "image/png",
        ".wav": "audio/wav",
        ".mp4": "video/mp4",
    }

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextlib.contextmanager
def static_server(directory: Path):
    handler = lambda *args, **kwargs: QuietStaticHandler(*args, directory=str(directory), **kwargs)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def browser_render(directory: Path) -> dict:
    external_requests: list[str] = []
    console_errors: list[str] = []
    with static_server(directory) as base_url, sync_playwright() as playwright:
        executable = browser_executable()
        browser = playwright.chromium.launch(
            headless=True,
            **({"executable_path": executable} if executable else {}),
        )
        context = browser.new_context(accept_downloads=True)

        def route_request(route, request) -> None:
            parsed = urlparse(request.url)
            if parsed.scheme in {"http", "https"} and parsed.hostname not in {"127.0.0.1", "localhost"}:
                external_requests.append(request.url)
                route.abort("blockedbyclient")
            else:
                route.continue_()

        context.route("**/*", route_request)
        page = context.new_page()
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.goto(f"{base_url}/harness.html", wait_until="domcontentloaded")
        page.wait_for_function("document.body.dataset.status === 'ready' || document.body.dataset.status === 'error'", timeout=120_000)
        error = page.evaluate("window.__dualEncoderError || null")
        if error:
            raise AssertionError(error)
        evidence = page.evaluate("window.__dualEncoderEvidence")
        link = page.locator("#dual-encoder-download")
        with page.expect_download(timeout=30_000) as download_info:
            link.click()
        output_path = directory / "browser-quick-export.mp4"
        download_info.value.save_as(str(output_path))
        context.close()
        browser.close()
    assert not external_requests, external_requests
    assert not console_errors, console_errors
    assert output_path.stat().st_size == evidence["byteLength"]
    return evidence


def prepare(directory: Path) -> dict:
    (directory / "assets").mkdir(parents=True)
    subprocess.run(
        [str(ROOT / "node_modules" / ".bin" / "tsx"), "e2e/dual-encoder-fixture.ts", str(directory)],
        cwd=ROOT,
        check=True,
    )
    subprocess.run(
        [
            str(ROOT / "node_modules" / ".bin" / "esbuild"),
            "e2e/dual-encoder-browser-entry.ts",
            "--bundle",
            "--platform=browser",
            "--format=iife",
            f"--outfile={directory / 'harness.js'}",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    (directory / "harness.html").write_text(
        "<!doctype html><meta charset=utf-8><title>dual encoder acceptance</title>"
        "<body data-status=loading><script src=/harness.js></script>",
        encoding="utf-8",
    )
    return json.loads((directory / "fixture.json").read_text(encoding="utf-8"))


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="manju-dual-encoder-") as temporary:
        # macOS exposes /var as a symlink to /private/var. The production
        # renderer correctly rejects symlinked output ancestors, so pass the
        # canonical temporary path exactly as a real render worker would.
        directory = Path(os.path.realpath(temporary))
        fixture = prepare(directory)
        browser_semantics = browser_render(directory)
        expected = fixture["expected"]
        assert browser_semantics["planSha256"] == expected["planSha256"]
        assert browser_semantics["boundarySignatureSha256"] == expected["boundarySignatureSha256"]
        assert browser_semantics["browserBoundarySignatureSha256"] == expected["boundarySignatureSha256"]
        assert browser_semantics["timelineRevisionId"] == expected["timelineRevisionId"]
        formal_semantics = fixture["formal"]
        assert formal_semantics["planSha256"] == expected["planSha256"]
        assert formal_semantics["boundarySignatureSha256"] == expected["boundarySignatureSha256"]
        assert formal_semantics["timelineRevisionId"] == expected["timelineRevisionId"]

        observations: dict[str, dict] = {}
        for name, filename in {
            "browser": "browser-quick-export.mp4",
            "formal": "formal-ffmpeg.mp4",
        }.items():
            path = directory / filename
            item = validate_probe(path, expected)
            item["continuity"] = assert_no_black_or_silence(path)
            item["visualEvidence"] = validate_frames(path, expected)
            item["audioOrder"] = validate_audio_order(path, expected)
            observations[name] = item
        comparison = compare_encoder_observations(observations["browser"], observations["formal"])
        report = {
            "ok": True,
            "zeroProviderCalls": True,
            "sameSnapshot": {
                "timelineRevisionId": expected["timelineRevisionId"],
                "planSha256": expected["planSha256"],
                "boundarySignatureSha256": expected["boundarySignatureSha256"],
                "subtitleTextsInSemanticOrder": expected["subtitleTexts"],
                "audioDrivenTiming": {
                    "durationFramesEach": expected["audioDrivenSegmentDurationFrames"],
                    "startFrames": expected["audioDrivenSegmentStartFrames"],
                    "authority": "three persisted speech Assets drive visual, audio, and subtitle boundaries",
                },
            },
            "browserSemanticEvidence": browser_semantics,
            "formalSemanticEvidence": formal_semantics,
            "files": observations,
            "comparison": comparison,
        }
        for filename in ["browser-quick-export.mp4", "formal-ffmpeg.mp4", "fixture.json", "subtitles.srt"]:
            shutil.copy2(directory / filename, ARTIFACT_DIR / filename)
        report_path = ARTIFACT_DIR / "acceptance-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "report": str(report_path.relative_to(ROOT)),
        "timelineRevisionId": report["sameSnapshot"]["timelineRevisionId"],
        "frameCount": report["files"]["browser"]["frameCount"],
        "durationSeconds": report["files"]["browser"]["durationSeconds"],
        "sampleRate": report["files"]["browser"]["audio"]["sampleRate"],
        "maxMeanRgbDelta": report["comparison"]["maxMeanRgbDelta"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
