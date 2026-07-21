#!/usr/bin/env python3
"""Repeatable 45-second-class vertical browser quick-export performance Spike.

This is an acceptance harness, not a unit benchmark. It drives the production
UI and production build against a fresh SQLite runtime. Network access is
blocked in both Chrome and the server. Story/image boundaries are deterministic
test providers; narration is synthesized locally by the operating system and
then enters the real speech Job, MediaStore, OpenCut timeline, browser preview,
Mediabunny/WebCodecs export, download, and persistence paths.

Artifacts and a machine-readable report are written to
``output/performance-spike``. The report explicitly distinguishes sampled JS
heap from sampled Chrome-process RSS; it never presents either as total system
memory.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import platform
import re
import shutil
import signal
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlparse

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / "output" / "performance-spike"
VIDEO_PATH = ARTIFACT_DIR / "browser-45s-9x16.mp4"
SCREENSHOT_PATH = ARTIFACT_DIR / "recovered-timeline.png"
REPORT_PATH = ARTIFACT_DIR / "report.json"
REPORT_MARKDOWN_PATH = ARTIFACT_DIR / "report.md"
SHOT_COUNT = 9
STORY_TARGET_DURATION_SECONDS = 45
FRAME_RATE = 24
AUDIO_SAMPLE_RATE = 44_100
SYNC_GATE_MS = 100.0
QUICK_EXPORT_TIMEOUT_SECONDS = 15 * 60
# Deliberately differs from the Story's nine equal five-second draft shots.
# These frame-aligned source lengths become authoritative only after the real
# speech Jobs probe and persist the generated WAV files. The sum remains a
# 45-second performance-class workload while individual edit points prove
# that OpenCut follows audio rather than the Story draft.
# 44.1 kHz contains 1837.5 samples per 24 fps frame, so every fixture length
# uses an even frame count. This keeps the WAV boundary exact while production
# still rounds arbitrary real Provider audio outward and never truncates it.
NARRATION_DURATION_FRAMES = [108, 126, 114, 132, 110, 124, 116, 130, 120]
assert sum(NARRATION_DURATION_FRAMES) == 45 * FRAME_RATE
FINAL_FIRST_NARRATION = "第一镜，暮色降临古港，守灯人踏上石阶。"
NARRATION_TEXTS = [
    FINAL_FIRST_NARRATION,
    "第二镜，守灯人穿过海雾。",
    "第三镜，铜灯映亮石阶。",
    "第四镜，远船在雾中回应。",
    "第五镜，灯芯迎着海风苏醒。",
    "第六镜，暖光越过青石码头。",
    "第七镜，归航帆影逐渐清晰。",
    "第八镜，钟声在港湾间回荡。",
    "第九镜，归航灯终于照亮归途。",
]


def load_support():
    spec = importlib.util.spec_from_file_location(
        "manju_offline_browser_support",
        ROOT / "e2e" / "offline-browser.py",
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load offline browser support")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SUPPORT = load_support()


def node_package_binary(package: str) -> str:
    return subprocess.check_output(
        ["node", "-e", f"console.log(require({json.dumps(package)}).path || require({json.dumps(package)}))"],
        cwd=ROOT,
        text=True,
    ).strip()


def create_system_narration(directory: Path) -> dict[str, Any]:
    """Create real spoken Chinese WAVs with a short machine sync marker.

    The 80ms 1.4kHz marker starts at each shot boundary. Speech begins 120ms
    later and each file is padded/trimmed to a deliberately different 24fps
    duration. The persisted WAV probes, not the Story's five-second draft
    slots, therefore define every later visual/subtitle boundary.
    """

    directory.mkdir(parents=True, exist_ok=True)
    ffmpeg = node_package_binary("ffmpeg-static")
    say = shutil.which("say")
    espeak = shutil.which("espeak") or shutil.which("espeak-ng")
    if not say and not espeak:
        raise RuntimeError(
            "The performance Spike requires an offline system TTS command "
            "(`say`, `espeak`, or `espeak-ng`); refusing to label tones as narration."
        )
    source = "macOS say/Tingting" if say else Path(espeak or "espeak").name
    durations_seconds = [frames / FRAME_RATE for frames in NARRATION_DURATION_FRAMES]
    for index, (text, duration_seconds) in enumerate(
        zip(NARRATION_TEXTS, durations_seconds, strict=True),
        start=1,
    ):
        raw_voice = directory / (f"voice-{index}.aiff" if say else f"voice-{index}.wav")
        if say:
            subprocess.run(
                [say, "-v", "Tingting", "-r", "205", "-o", str(raw_voice), text],
                check=True,
                capture_output=True,
                text=True,
            )
        else:
            subprocess.run(
                [espeak or "espeak", "-v", "zh", "-s", "205", "-w", str(raw_voice), text],
                check=True,
                capture_output=True,
                text=True,
            )
        output = directory / f"speech-{index}.wav"
        subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                    f"sine=frequency=1400:sample_rate={AUDIO_SAMPLE_RATE}:duration=0.08",
                "-i",
                str(raw_voice),
                "-filter_complex",
                (
                    f"[0:a]aformat=sample_fmts=fltp:sample_rates={AUDIO_SAMPLE_RATE}:"
                    "channel_layouts=stereo,volume=0.78[marker];"
                    f"[1:a]aresample={AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates={AUDIO_SAMPLE_RATE}:"
                    "channel_layouts=stereo,adelay=120|120,volume=0.72[voice];"
                    "[marker][voice]amix=inputs=2:duration=longest:dropout_transition=0,"
                    f"apad,atrim=0:{duration_seconds:.9f},alimiter=limit=0.95[out]"
                ),
                "-map",
                "[out]",
                "-c:a",
                "pcm_s16le",
                "-ar",
                str(AUDIO_SAMPLE_RATE),
                "-ac",
                "2",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        with wave.open(str(output), "rb") as wav:
            assert wav.getframerate() == AUDIO_SAMPLE_RATE
            assert wav.getnchannels() == 2
            assert wav.getnframes() == round(duration_seconds * AUDIO_SAMPLE_RATE)
        raw_voice.unlink(missing_ok=True)
    boundaries_seconds: list[float] = []
    cursor = 0.0
    for duration_seconds in durations_seconds:
        boundaries_seconds.append(cursor)
        cursor += duration_seconds
    return {
        "source": source,
        "count": SHOT_COUNT,
        "durationFramesEach": NARRATION_DURATION_FRAMES,
        "durationSecondsEach": durations_seconds,
        "boundariesSeconds": boundaries_seconds,
        "timelineDurationSeconds": cursor,
        "authority": "persisted speech Asset duration at 24fps",
    }


def json_request(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request_headers = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        raise AssertionError(f"{method} {url} failed with {error.code}: {payload}") from error


def wait_for(
    label: str,
    read: Callable[[], Any],
    accept: Callable[[Any], bool],
    timeout: float = 120,
) -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        try:
            last = read()
            if accept(last):
                return last
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {label}; last={last!r}")


def process_table() -> dict[int, tuple[int, int, str]]:
    result = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    rows: dict[int, tuple[int, int, str]] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) < 4:
            continue
        try:
            pid, ppid, rss = map(int, parts[:3])
        except ValueError:
            continue
        rows[pid] = (ppid, rss, parts[3])
    return rows


def chrome_descendant_rss_kib() -> int:
    rows = process_table()
    descendants = {os.getpid()}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _rss, _command) in rows.items():
            if ppid in descendants and pid not in descendants:
                descendants.add(pid)
                changed = True
    return sum(
        rss
        for pid, (_ppid, rss, command) in rows.items()
        if pid in descendants and ("chrome" in command.lower() or "chromium" in command.lower())
    )


class MemorySampler:
    def __init__(self, cdp) -> None:
        self.cdp = cdp
        self.samples = 0
        self.peak_js_heap_bytes = 0.0
        self.peak_js_heap_total_bytes = 0.0
        self.peak_chrome_rss_kib = 0
        self.peak_dom_nodes = 0.0
        self.cdp.send("Performance.enable")

    def sample(self) -> None:
        values = {
            item["name"]: float(item["value"])
            for item in self.cdp.send("Performance.getMetrics").get("metrics", [])
        }
        self.samples += 1
        self.peak_js_heap_bytes = max(self.peak_js_heap_bytes, values.get("JSHeapUsedSize", 0.0))
        self.peak_js_heap_total_bytes = max(
            self.peak_js_heap_total_bytes,
            values.get("JSHeapTotalSize", 0.0),
        )
        self.peak_dom_nodes = max(self.peak_dom_nodes, values.get("Nodes", 0.0))
        self.peak_chrome_rss_kib = max(self.peak_chrome_rss_kib, chrome_descendant_rss_kib())

    def report(self) -> dict[str, Any]:
        mib = 1024 * 1024
        return {
            "samplingIntervalMsDuringQuickExport": 200,
            "samples": self.samples,
            "peakRendererJsHeapMiB": round(self.peak_js_heap_bytes / mib, 2),
            "peakRendererJsHeapCapacityMiB": round(self.peak_js_heap_total_bytes / mib, 2),
            "peakChromeProcessTreeRssMiB": round(self.peak_chrome_rss_kib / 1024, 2),
            "peakDomNodes": round(self.peak_dom_nodes),
            "scope": (
                "JS heap is Chrome DevTools Performance.getMetrics for the page target; "
                "RSS is the sampled sum of Chrome/Chromium descendants of this harness."
            ),
        }


def project_scope(base_url: str) -> tuple[str, str]:
    projects = json_request(f"{base_url}/api/v1/projects")["projects"]
    assert len(projects) == 1, projects
    project = projects[0]
    episode_id = project.get("currentEpisodeId")
    assert isinstance(episode_id, str) and episode_id, project
    return project["id"], episode_id


def create_narration_jobs(
    base_url: str,
    project_id: str,
    episode_id: str,
) -> tuple[list[str], dict[str, Any]]:
    story_payload = json_request(
        f"{base_url}/api/v1/episodes/{quote(episode_id)}/story?projectId={quote(project_id)}"
    )
    lines = [
        line
        for scene in story_payload["story"]["scenes"]
        for shot in scene["shots"]
        for line in shot["dialogueLines"]
    ]
    assert len(lines) == SHOT_COUNT, lines
    assert lines[0]["text"] == FINAL_FIRST_NARRATION, lines[0]
    ids: list[str] = []
    for line in lines:
        body = {
            "projectId": project_id,
            "episodeId": episode_id,
            "providerId": "minimax-speech",
            "voiceId": "offline-system-narrator",
            "speed": 1,
            "volume": 1,
            "pitch": 0,
            "emotion": "calm",
            "format": "wav",
            "sampleRate": AUDIO_SAMPLE_RATE,
            "bitrate": 128_000,
            "channels": 2,
        }
        payload = SUPPORT.paid_json_request(
            f"{base_url}/api/v1/dialogue-lines/{quote(line['id'])}/speech-generations",
            body=body,
            idempotency_key=f"performance-spike-{line['id']}-{uuid.uuid4()}",
            expected_action="dialogue.speech.generate",
        )
        ids.append(payload["job"]["id"])
    terminal = wait_for(
        "nine narration Jobs",
        lambda: json_request(f"{base_url}/api/v1/jobs?limit=100")["jobs"],
        lambda jobs: all(
            any(job["id"] == job_id and job["status"] in {"succeeded", "failed"} for job in jobs)
            for job_id in ids
        ),
        timeout=180,
    )
    selected = [next(job for job in terminal if job["id"] == job_id) for job_id in ids]
    failures = [job for job in selected if job["status"] != "succeeded"]
    assert not failures, failures
    measured_seconds: list[float] = []
    measured_frames: list[int] = []
    for job in selected:
        output = job.get("output") or {}
        asset = output.get("asset") or {}
        duration = asset.get("durationSeconds")
        assert isinstance(duration, (int, float)) and duration > 0, job
        frames = max(1, math.ceil(float(duration) * FRAME_RATE))
        measured_frames.append(frames)
        measured_seconds.append(frames / FRAME_RATE)
    # Prove the acceptance no longer inherited nine equal Story slots.
    assert measured_frames == NARRATION_DURATION_FRAMES, measured_frames
    assert len(set(measured_frames)) > 1, measured_frames
    boundaries_seconds: list[float] = []
    cursor_frames = 0
    for frames in measured_frames:
        boundaries_seconds.append(cursor_frames / FRAME_RATE)
        cursor_frames += frames
    assert 45 * FRAME_RATE <= cursor_frames <= 60 * FRAME_RATE, cursor_frames
    return ids, {
        "durationFramesEach": measured_frames,
        "durationSecondsEach": measured_seconds,
        "boundariesSeconds": boundaries_seconds,
        "timelineDurationSeconds": cursor_frames / FRAME_RATE,
        "authority": "generation Job output.asset.durationSeconds covered outward at 24fps",
    }


def timeline_revision(base_url: str, episode_id: str) -> str:
    payload = json_request(f"{base_url}/api/v1/episodes/{quote(episode_id)}/timeline-document")
    revision = payload.get("revision", {})
    revision_id = revision.get("id")
    assert isinstance(revision_id, str) and revision_id, payload
    return revision_id


def set_preview_time(page: Page, seconds: float, timeline_duration_seconds: float) -> None:
    scrubber = page.get_by_label("预览播放头")
    maximum = float(scrubber.get_attribute("max") or "0")
    assert maximum > 0
    value = maximum * seconds / timeline_duration_seconds
    scrubber.evaluate(
        """(element, value) => {
          // React's controlled-input value tracker ignores an input event when
          // the instance setter has already updated its cached value. Invoke
          // the native prototype setter so the real onChange -> OpenCut seek
          // path observes the browser event, just like a user drag.
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set;
          if (!setter) throw new Error('native input value setter missing');
          setter.call(element, String(value));
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        value,
    )
    page.wait_for_timeout(80)


def parse_open_cut_timecode(value: str) -> float:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2})", value.strip())
    assert match, value
    minutes, seconds, frames = (int(part) for part in match.groups())
    assert seconds < 60 and frames < FRAME_RATE, value
    return minutes * 60 + seconds + frames / FRAME_RATE


def apply_audio_driven_automatic_edit(
    page: Page,
    timeline_duration_seconds: float,
) -> dict[str, Any]:
    """Use the real Agentic/OpenCut path to reflow speech, visuals and subtitles.

    The initial ordinary reconcile intentionally preserves editor positions.
    Unequal speech can therefore expose a collision-shifted tail. The explicit
    safe automatic-edit preview must repair that tail with audited OpenCut
    timing operations before preview/export; the test never authors subtitles
    by hand or patches the Timeline JSON.
    """

    title = page.locator(".timeline-title > span")
    before = parse_open_cut_timecode(title.inner_text())
    if abs(before - timeline_duration_seconds) <= 1 / FRAME_RATE:
        return {
            "required": False,
            "beforeDurationSeconds": before,
            "afterDurationSeconds": before,
        }

    trigger = page.get_by_role("button", name="Agentic 自动剪辑预览", exact=True)
    assert trigger.is_enabled(), "Agentic automatic edit is not available on the authoritative revision"
    trigger.click()
    region = page.get_by_role("region", name="Agentic 自动剪辑预览", exact=True)
    region.get_by_text("自动剪辑预览 · 尚未保存", exact=True).wait_for(timeout=60_000)
    copy = region.inner_text()
    operation_match = re.search(r"(\d+) 项 OpenCut 时间调整", copy)
    assert operation_match and int(operation_match.group(1)) > 0, copy
    region.get_by_role("button", name="应用为新修订", exact=True).click()
    page.get_by_text("Agentic 自动剪辑修订", exact=True).wait_for(timeout=60_000)
    page.locator(".timeline-storage.ready", has_text="SQLite 修订已保存").wait_for(timeout=60_000)
    after = parse_open_cut_timecode(title.inner_text())
    assert abs(after - timeline_duration_seconds) <= 1 / FRAME_RATE, {
        "expectedAudioDrivenDuration": timeline_duration_seconds,
        "beforeOpenCutDuration": before,
        "afterOpenCutDuration": after,
        "preview": copy,
    }
    return {
        "required": True,
        "beforeDurationSeconds": before,
        "afterDurationSeconds": after,
        "operationCount": int(operation_match.group(1)),
    }


def assert_preview_contract(
    page: Page,
    timeline_duration_seconds: float,
    expected_revision: str | None = None,
) -> str:
    dialog = page.get_by_role("dialog", name="预览「第 1 集」")
    dialog.wait_for(timeout=60_000)
    dialog.get_by_text("真实时间线", exact=True).wait_for(timeout=60_000)
    facts_text = dialog.locator(".opencut-preview-facts").inner_text()
    assert f"{SHOT_COUNT} 画面 / {SHOT_COUNT} 音频" in facts_text, facts_text
    expected_frames = round(timeline_duration_seconds * FRAME_RATE)
    dialog.get_by_text(f"{expected_frames} 帧 @ {FRAME_RATE}fps", exact=True).wait_for()
    dialog.get_by_text("720p · H.264/AAC · 资产字节 SHA-256 复核", exact=True).wait_for(timeout=60_000)
    stage = dialog.locator(".opencut-preview-stage")
    box = stage.bounding_box()
    assert box and box["height"] > box["width"] * 1.7, box
    visible_revision = dialog.locator(".opencut-preview-facts span").first.locator("strong").inner_text()
    if expected_revision is not None:
        assert expected_revision.startswith(visible_revision), (expected_revision, visible_revision)
    return visible_revision


def verify_all_subtitles(
    page: Page,
    boundaries_seconds: list[float],
    timeline_duration_seconds: float,
) -> list[str]:
    observed: list[str] = []
    chinese_numbers = "一二三四五六七八九"
    for index, boundary_seconds in enumerate(boundaries_seconds):
        set_preview_time(page, boundary_seconds + 0.5, timeline_duration_seconds)
        subtitles = page.locator(".opencut-preview-subtitles span").all_inner_texts()
        expected = f"第{chinese_numbers[index]}镜"
        assert any(expected in text for text in subtitles), (index, subtitles)
        observed.append(" / ".join(subtitles))
    set_preview_time(page, 0, timeline_duration_seconds)
    return observed


def monitor_quick_export(page: Page, sampler: MemorySampler) -> tuple[float, int]:
    started = time.monotonic()
    maximum_progress = 0
    status = page.locator(".opencut-quick-export-copy span")
    while time.monotonic() - started < QUICK_EXPORT_TIMEOUT_SECONDS:
        sampler.sample()
        text = status.inner_text()
        match = re.search(r"(\d+)%", text)
        if match:
            maximum_progress = max(maximum_progress, int(match.group(1)))
        if "审片 MP4 已在本浏览器生成" in text:
            return time.monotonic() - started, maximum_progress
        if "浏览器快导失败" in text or "失败" in text:
            raise AssertionError(f"Browser quick export failed: {text}")
        page.wait_for_timeout(200)
    raise AssertionError(f"Browser quick export exceeded {QUICK_EXPORT_TIMEOUT_SECONDS}s")


def decode_media(
    video_path: Path,
    expected_duration_seconds: float,
) -> tuple[dict[str, Any], list[float], bytes]:
    ffprobe = node_package_binary("@ffprobe-installer/ffprobe")
    ffmpeg = node_package_binary("ffmpeg-static")
    payload = json.loads(subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout)
    streams = payload["streams"]
    video = next(stream for stream in streams if stream["codec_type"] == "video")
    audio = next(stream for stream in streams if stream["codec_type"] == "audio")
    duration = float(payload["format"]["duration"])
    assert video["codec_name"] == "h264", video
    assert video["pix_fmt"] == "yuv420p", video
    assert (video["width"], video["height"]) == (720, 1280), video
    assert audio["codec_name"] == "aac", audio
    assert audio["sample_rate"] == "48000", audio
    assert audio["channels"] == 2, audio
    assert abs(duration - expected_duration_seconds) <= 0.2, (
        duration,
        expected_duration_seconds,
    )
    audio_bytes = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(video_path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    audio_samples = [value[0] for value in struct.iter_unpack("<f", audio_bytes)]
    video_rgb = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(video_path),
            "-map",
            "0:v:0",
            "-vf",
            "scale=1:1:flags=area,format=rgb24",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return {
        "durationSeconds": duration,
        "sizeBytes": video_path.stat().st_size,
        "video": {
            "codec": video["codec_name"],
            "pixelFormat": video["pix_fmt"],
            "width": video["width"],
            "height": video["height"],
            "frameRate": video["r_frame_rate"],
        },
        "audio": {
            "codec": audio["codec_name"],
            "sampleRate": int(audio["sample_rate"]),
            "channels": audio["channels"],
        },
    }, audio_samples, video_rgb


def rms(samples: list[float]) -> float:
    return math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples)))


def analyze_sync(
    audio_samples: list[float],
    video_rgb: bytes,
    boundaries_seconds: list[float],
    timeline_duration_seconds: float,
) -> dict[str, Any]:
    sample_rate = 48_000
    audio_window = 480  # 10ms
    frame_colors = [tuple(video_rgb[index:index + 3]) for index in range(0, len(video_rgb), 3)]
    assert len(frame_colors) >= round(timeline_duration_seconds * FRAME_RATE) - 2, len(frame_colors)
    points: list[dict[str, Any]] = []
    errors: list[float] = []
    for shot, expected in enumerate(boundaries_seconds):
        search_start = max(0, int((expected - 0.08) * sample_rate))
        search_end = min(len(audio_samples), int((expected + 0.30) * sample_rate))
        audio_onset: float | None = None
        for offset in range(search_start, search_end - audio_window + 1, audio_window):
            # The WebCodecs AAC encode/decode path attenuates the synthetic
            # marker to about -29 dBFS RMS. A -34 dBFS gate stays well above
            # the preceding digital silence while remaining independent of
            # the substantially louder narration that begins at 120ms.
            if rms(audio_samples[offset:offset + audio_window]) >= 0.02:
                audio_onset = offset / sample_rate
                break
        assert audio_onset is not None, f"Missing audio marker near {expected}s"

        if shot == 0:
            visual_boundary = 0.0
        else:
            target_frame = round(expected * FRAME_RATE)
            candidates: list[tuple[float, int]] = []
            for frame in range(max(1, target_frame - 3), min(len(frame_colors), target_frame + 4)):
                before = frame_colors[frame - 1]
                after = frame_colors[frame]
                delta = math.sqrt(sum((int(after[channel]) - int(before[channel])) ** 2 for channel in range(3)))
                candidates.append((delta, frame))
            delta, boundary_frame = max(candidates)
            assert delta >= 3.0, (shot, candidates)
            visual_boundary = boundary_frame / FRAME_RATE
        error_ms = (audio_onset - visual_boundary) * 1_000
        errors.append(abs(error_ms))
        points.append({
            "shot": shot + 1,
            "expectedSeconds": expected,
            "videoBoundarySeconds": round(visual_boundary, 6),
            "audioMarkerSeconds": round(audio_onset, 6),
            "audioMinusVideoMs": round(error_ms, 3),
        })
    sorted_errors = sorted(errors)
    p95_index = min(len(sorted_errors) - 1, math.ceil(0.95 * len(sorted_errors)) - 1)
    maximum = max(errors)
    result = {
        "method": (
            "1.4kHz/80ms markers detected above -34dBFS at each audio-derived narration "
            "boundary versus decoded 1x1 average-color frame transitions; AAC decoded "
            "at 48kHz, video at 24fps."
        ),
        "gateMs": SYNC_GATE_MS,
        "maxAbsoluteErrorMs": round(maximum, 3),
        "meanAbsoluteErrorMs": round(statistics.mean(errors), 3),
        "p95AbsoluteErrorMs": round(sorted_errors[p95_index], 3),
        "passed": maximum <= SYNC_GATE_MS,
        "points": points,
    }
    assert result["passed"], result
    return result


def markdown_report(report: dict[str, Any]) -> str:
    timings = report["timingsSeconds"]
    memory = report["memory"]
    sync = report["audioVideoSync"]
    audio_timing = report["audioDrivenTiming"]
    return f"""# Browser performance Spike

- Result: **{'PASS' if report['ok'] else 'FAIL'}**
- Project: {audio_timing['timelineDurationSeconds']:.3f}s audio-driven timeline (Story target {STORY_TARGET_DURATION_SECONDS}s), 9:16, {SHOT_COUNT} images, {SHOT_COUNT} local-system-TTS narration assets, {SHOT_COUNT} subtitle cues
- Per-shot speech frames: {audio_timing['durationFramesEach']} @ {FRAME_RATE}fps
- Chrome: {report['environment']['browserVersion']}
- Quick export: {timings['quickExport']:.2f}s
- Cancel acknowledgement: {timings['quickExportCancel']:.2f}s
- Refresh recovery: {timings['refreshRecovery']:.2f}s
- Hard service restart recovery: {timings['serviceRestartRecovery']:.2f}s
- Peak renderer JS heap: {memory['peakRendererJsHeapMiB']:.2f} MiB
- Peak sampled Chrome process-tree RSS: {memory['peakChromeProcessTreeRssMiB']:.2f} MiB
- Maximum decoded A/V boundary error: {sync['maxAbsoluteErrorMs']:.3f}ms (gate {sync['gateMs']:.0f}ms)
- Billable/external Provider calls: **0**; unexpected network requests: **0**

See `report.json` for per-boundary sync samples, timings, persistence revision IDs,
provider-boundary evidence, and metric scope.
"""


def main() -> int:
    if not (ROOT / "dist" / "index.html").exists():
        raise SystemExit("dist/index.html is missing; run npm run build first")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    for artifact in [VIDEO_PATH, SCREENSHOT_PATH, REPORT_PATH, REPORT_MARKDOWN_PATH]:
        artifact.unlink(missing_ok=True)

    started_all = time.monotonic()
    timings: dict[str, float] = {}
    report: dict[str, Any] | None = None
    current_process = None
    all_server_outputs: list[list[str]] = []

    with tempfile.TemporaryDirectory(prefix="manju-performance-spike-") as temporary:
        temporary_path = Path(temporary)
        runtime_dir = temporary_path / "runtime"
        speech_dir = temporary_path / "speech"
        narration = create_system_narration(speech_dir)
        port = __import__("socket").socket()
        port.bind(("127.0.0.1", 0))
        selected_port = port.getsockname()[1]
        port.close()
        server_env = {
            "MANJU_E2E_PERFORMANCE_SPIKE": "1",
            "MANJU_E2E_SPIKE_SPEECH_DIR": str(speech_dir),
        }
        current_process, base_url, server_output = SUPPORT.start_server(
            runtime_dir,
            selected_port,
            server_env,
        )
        all_server_outputs.append(server_output)

        external_requests: list[str] = []
        console_errors: list[str] = []
        page_errors: list[str] = []
        failed_responses: list[str] = []
        restart_in_progress = False

        try:
            with sync_playwright() as playwright:
                executable = SUPPORT.system_chromium_executable()
                browser = playwright.chromium.launch(
                    headless=True,
                    **({"executable_path": executable} if executable else {}),
                )
                browser_version = browser.version
                context = browser.new_context(
                    accept_downloads=True,
                    viewport={"width": 1440, "height": 1000},
                )

                def route_request(route, request) -> None:
                    parsed = urlparse(request.url)
                    if parsed.scheme in {"http", "https"} and parsed.hostname not in {"127.0.0.1", "localhost"}:
                        external_requests.append(request.url)
                        route.abort("blockedbyclient")
                    else:
                        route.continue_()

                context.route("**/*", route_request)
                page = context.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.on(
                    "console",
                    lambda message: console_errors.append(message.text)
                    if message.type == "error"
                    else None,
                )
                page.on(
                    "response",
                    lambda response: failed_responses.append(f"{response.status} {response.url}")
                    if response.status >= 400
                    else None,
                )
                page.set_default_timeout(60_000)
                cdp = context.new_cdp_session(page)
                sampler = MemorySampler(cdp)

                try:
                    phase = time.monotonic()
                    page.goto(base_url, wait_until="domcontentloaded")
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.get_by_role("heading", name="故事原文").wait_for()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    source = page.locator(".source-editor textarea")
                    assert source.input_value() == ""
                    source.fill("海雾笼罩古港，守灯人踏上矶头，为九段归航时刻点亮灯塔。")
                    page.locator(".segmented-control button", has_text="45").click()
                    page.get_by_role("button", name="生成结构剧本", exact=True).click()
                    page.get_by_role("heading", name="角色与场景准备", exact=True, level=1).wait_for()
                    page.locator(".pipeline-step", has_text="拆剧本与配音").click()
                    page.get_by_role("heading", name="第 1 集 · 结构剧本").wait_for()
                    stats = page.locator(".script-stage .stage-toolbar .score-row")
                    stats.get_by_text("1 场", exact=True).wait_for()
                    stats.get_by_text("9 镜", exact=True).wait_for()
                    stats.get_by_text("45 秒", exact=True).wait_for()
                    timings["storyGeneration"] = time.monotonic() - phase

                    # A real browser edit creates a new immutable Story revision
                    # before any derived image/speech assets are generated.
                    phase = time.monotonic()
                    first_line = page.locator(".script-dialogue").first
                    first_line.get_by_role("button", name="编辑", exact=True).click()
                    first_line.locator("input").fill(FINAL_FIRST_NARRATION)
                    first_line.get_by_role("button", name="保存", exact=True).click()
                    first_line.get_by_text(FINAL_FIRST_NARRATION, exact=True).wait_for()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    timings["storyEdit"] = time.monotonic() - phase

                    phase = time.monotonic()
                    page.locator(".pipeline-step", has_text="分镜与逐镜视频").click()
                    assert page.locator(".shot-card").count() == SHOT_COUNT
                    aspect_button = page.get_by_role("button", name="9:16", exact=True)
                    aspect_button.click()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    # This Spike measures nine-shot browser/export throughput,
                    # not reference-consistency authoring. Make its text-only
                    # recovery mode explicit instead of silently bypassing the
                    # locked-reference admission gate.
                    consistency_switch = page.locator(".consistency-section button.switch")
                    assert "on" in (consistency_switch.get_attribute("class") or "").split()
                    consistency_switch.click()
                    assert "on" not in (consistency_switch.get_attribute("class") or "").split()
                    fill_missing = page.locator("button.generate-all")
                    assert "补齐缺失" in fill_missing.inner_text()
                    fill_missing.click()
                    SUPPORT.confirm_paid_browser_tasks(
                        page,
                        count=SHOT_COUNT,
                        endpoint_fragment="/api/v1/assets/image-generations",
                    )
                    page.locator("button.generate-all", has_text="分镜已齐").wait_for(timeout=120_000)
                    assert page.locator(".shot-card.review").count() == SHOT_COUNT
                    timings["storyboardImages"] = time.monotonic() - phase

                    project_id, episode_id = project_scope(base_url)
                    episode = json_request(f"{base_url}/api/v1/episodes/{quote(episode_id)}")["episode"]
                    assert episode["aspectRatio"] == "9:16", episode
                    assert episode["targetDurationSeconds"] == STORY_TARGET_DURATION_SECONDS, episode

                    phase = time.monotonic()
                    speech_job_ids, audio_timing = create_narration_jobs(
                        base_url,
                        project_id,
                        episode_id,
                    )
                    assert audio_timing["timelineDurationSeconds"] == narration["timelineDurationSeconds"]
                    assert audio_timing["durationFramesEach"] == narration["durationFramesEach"]
                    timings["narrationJobs"] = time.monotonic() - phase
                    evidence_before_restart = json_request(f"{base_url}/__e2e__/evidence")
                    assert evidence_before_restart["providerCalls"] == {
                        "text": 1,
                        "image": SHOT_COUNT,
                        "speech": SHOT_COUNT,
                        "video": 0,
                    }, evidence_before_restart
                    assert evidence_before_restart["unexpectedNetworkRequests"] == 0, evidence_before_restart

                    phase = time.monotonic()
                    page.reload(wait_until="domcontentloaded")
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    page.locator(".pipeline-step", has_text="拆剧本与配音").click()
                    page.get_by_role("button", name="继续生成与确认语音", exact=True).click()
                    page.get_by_text("时间线可写", exact=True).wait_for(timeout=120_000)
                    page.locator(".dialogue-production-list header", has_text="9/9 已生成").wait_for(timeout=120_000)
                    automatic_edit = apply_audio_driven_automatic_edit(
                        page,
                        audio_timing["timelineDurationSeconds"],
                    )
                    page.get_by_role("button", name="预览", exact=True).click()
                    visible_revision = assert_preview_contract(
                        page,
                        audio_timing["timelineDurationSeconds"],
                    )
                    persisted_revision = timeline_revision(base_url, episode_id)
                    assert persisted_revision.startswith(visible_revision)
                    subtitle_samples = verify_all_subtitles(
                        page,
                        audio_timing["boundariesSeconds"],
                        audio_timing["timelineDurationSeconds"],
                    )
                    timings["initialPreviewPreparation"] = time.monotonic() - phase

                    play = page.get_by_role("button", name="播放预览", exact=True)
                    play.click()
                    page.wait_for_timeout(1_250)
                    current_timecode = page.locator(".opencut-preview-timecode").first.inner_text()
                    assert current_timecode not in {"00:00:00", "00:00:01"}, current_timecode
                    page.get_by_role("button", name="暂停预览", exact=True).click()

                    # Start a real browser export, wait until frame encoding is
                    # active, then cancel. No partial Blob/download may survive.
                    phase = time.monotonic()
                    page.get_by_role("button", name="快速导出 MP4", exact=True).click()
                    cancel = page.get_by_role("button", name="取消快导", exact=True)
                    cancel.wait_for()
                    page.get_by_text(re.compile("正在合成画面")).wait_for(timeout=120_000)
                    sampler.sample()
                    cancel.click()
                    page.get_by_text("720p · H.264/AAC · 资产字节 SHA-256 复核", exact=True).wait_for(timeout=60_000)
                    assert page.get_by_role("link", name="下载审片版", exact=True).count() == 0
                    timings["quickExportCancel"] = time.monotonic() - phase

                    # Page refresh must recover the exact SQLite timeline, not
                    # browser-local state. The canceled Blob correctly does not
                    # reappear, while the authoritative revision does.
                    page.get_by_role("button", name="关闭预览", exact=True).click()
                    phase = time.monotonic()
                    page.reload(wait_until="domcontentloaded")
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    page.locator(".pipeline-step", has_text="拆剧本与配音").click()
                    page.get_by_role("button", name="继续生成与确认语音", exact=True).click()
                    page.get_by_text("时间线可写", exact=True).wait_for(timeout=120_000)
                    page.get_by_role("button", name="预览", exact=True).click()
                    assert_preview_contract(
                        page,
                        audio_timing["timelineDurationSeconds"],
                        persisted_revision,
                    )
                    assert timeline_revision(base_url, episode_id) == persisted_revision
                    timings["refreshRecovery"] = time.monotonic() - phase

                    phase = time.monotonic()
                    page.get_by_role("button", name="快速导出 MP4", exact=True).click()
                    quick_elapsed, maximum_progress = monitor_quick_export(page, sampler)
                    timings["quickExport"] = quick_elapsed
                    with page.expect_download(timeout=60_000) as download_info:
                        page.get_by_role("link", name="下载审片版", exact=True).click()
                    download_info.value.save_as(str(VIDEO_PATH))
                    timings["quickExportAndDownload"] = time.monotonic() - phase
                    assert VIDEO_PATH.exists() and VIDEO_PATH.stat().st_size > 1024

                    # A hard API-service restart uses the same SQLite/media
                    # runtime. The browser then reloads and must pin the same
                    # full timeline revision without another Provider call.
                    page.get_by_role("button", name="关闭预览", exact=True).click()
                    phase = time.monotonic()
                    restart_in_progress = True
                    os.killpg(current_process.pid, signal.SIGKILL)
                    current_process.wait(timeout=15)
                    current_process, restarted_url, restarted_output = SUPPORT.start_server(
                        runtime_dir,
                        selected_port,
                        server_env,
                    )
                    all_server_outputs.append(restarted_output)
                    assert restarted_url == base_url
                    page.reload(wait_until="domcontentloaded")
                    restart_in_progress = False
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    page.locator(".pipeline-step", has_text="拆剧本与配音").click()
                    page.get_by_role("button", name="继续生成与确认语音", exact=True).click()
                    page.get_by_text("时间线可写", exact=True).wait_for(timeout=120_000)
                    page.get_by_role("button", name="预览", exact=True).click()
                    assert_preview_contract(
                        page,
                        audio_timing["timelineDurationSeconds"],
                        persisted_revision,
                    )
                    assert timeline_revision(base_url, episode_id) == persisted_revision
                    evidence_after_restart = json_request(f"{base_url}/__e2e__/evidence")
                    assert evidence_after_restart["providerCalls"] == {
                        "text": 0,
                        "image": 0,
                        "speech": 0,
                        "video": 0,
                    }, evidence_after_restart
                    assert evidence_after_restart["unexpectedNetworkRequests"] == 0
                    timings["serviceRestartRecovery"] = time.monotonic() - phase
                    sampler.sample()
                    page.screenshot(path=str(SCREENSHOT_PATH), full_page=True)

                    media, audio_samples, video_rgb = decode_media(
                        VIDEO_PATH,
                        audio_timing["timelineDurationSeconds"],
                    )
                    sync = analyze_sync(
                        audio_samples,
                        video_rgb,
                        audio_timing["boundariesSeconds"],
                        audio_timing["timelineDurationSeconds"],
                    )
                    timings["total"] = time.monotonic() - started_all
                    report = {
                        "ok": True,
                        "generatedAt": datetime.now(timezone.utc).isoformat(),
                        "acceptance": {
                            "durationSeconds": audio_timing["timelineDurationSeconds"],
                            "storyTargetDurationSeconds": STORY_TARGET_DURATION_SECONDS,
                            "aspectRatio": "9:16",
                            "storyShots": SHOT_COUNT,
                            "storyboardImages": SHOT_COUNT,
                            "narrationAssets": SHOT_COUNT,
                            "subtitleCuesObservedInChrome": len(subtitle_samples),
                            "audioDrivenAutomaticEdit": automatic_edit,
                            "browserStoryEditPersisted": True,
                            "previewPlaybackAdvanced": True,
                            "quickExportCancelledWithoutArtifact": True,
                            "quickExportDownloaded": True,
                            "pageRefreshRecoveredExactTimelineRevision": True,
                            "hardServiceRestartRecoveredExactTimelineRevision": True,
                        },
                        "environment": {
                            "browserVersion": browser_version,
                            "browserExecutable": executable,
                            "platform": platform.platform(),
                            "python": platform.python_version(),
                            "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                        },
                        "timingsSeconds": {key: round(value, 3) for key, value in timings.items()},
                        "memory": sampler.report(),
                        "media": media,
                        "audioDrivenTiming": audio_timing,
                        "audioVideoSync": sync,
                        "persistence": {
                            "timelineRevisionId": persisted_revision,
                            "visibleRevisionPrefix": visible_revision,
                            "speechJobIds": speech_job_ids,
                        },
                        "providerEvidence": {
                            "billableProviderCalls": 0,
                            "unexpectedNetworkRequests": 0,
                            "beforeRestart": evidence_before_restart,
                            "afterRestart": evidence_after_restart,
                            "narration": narration,
                            "note": (
                                "Text/image are deterministic test boundaries; speech files come from "
                                "offline system TTS. Browser and server reject all non-local HTTP."
                            ),
                        },
                        "quickExport": {
                            "maximumObservedProgressPercent": maximum_progress,
                            "output": str(VIDEO_PATH.relative_to(ROOT)),
                            "screenshot": str(SCREENSHOT_PATH.relative_to(ROOT)),
                        },
                    }
                finally:
                    context.close()
                    browser.close()

            allowed_404s = [
                response
                for response in failed_responses
                if response.startswith("404 ")
                and ("/story?projectId=" in response or response.endswith("/timeline-document"))
            ]
            allowed_paid_preflights = SUPPORT.expected_paid_preflight_responses(
                failed_responses,
                {"/api/v1/assets/image-generations": SHOT_COUNT},
            )
            unexpected_responses = [
                response
                for response in failed_responses
                if response not in allowed_404s and response not in allowed_paid_preflights
            ]
            generic_404 = "Failed to load resource: the server responded with a status of 404 (Not Found)"
            allowed_console_404s = len(allowed_404s)
            allowed_console_paid = len(allowed_paid_preflights)
            unexpected_console: list[str] = []
            for message in console_errors:
                if message == generic_404 and allowed_console_404s > 0:
                    allowed_console_404s -= 1
                elif "Failed to load resource" in message and "409" in message and allowed_console_paid > 0:
                    allowed_console_paid -= 1
                elif "ERR_CONNECTION_REFUSED" in message or "ERR_INCOMPLETE_CHUNKED_ENCODING" in message:
                    # Connection failures can only occur inside the explicit
                    # hard-restart window; recovered authoritative state is
                    # asserted after the process returns.
                    continue
                else:
                    unexpected_console.append(message)
            assert not restart_in_progress, "service restart did not finish"
            assert not external_requests, external_requests
            assert not page_errors, page_errors
            assert not unexpected_responses, unexpected_responses
            assert not unexpected_console, unexpected_console
        finally:
            if current_process is not None:
                SUPPORT.stop_server(current_process)

    assert report is not None
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    REPORT_MARKDOWN_PATH.write_text(markdown_report(report), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "report": str(REPORT_PATH.relative_to(ROOT)),
        "video": str(VIDEO_PATH.relative_to(ROOT)),
        "quickExportSeconds": report["timingsSeconds"]["quickExport"],
        "peakChromeRssMiB": report["memory"]["peakChromeProcessTreeRssMiB"],
        "peakJsHeapMiB": report["memory"]["peakRendererJsHeapMiB"],
        "maxAudioVideoSyncErrorMs": report["audioVideoSync"]["maxAbsoluteErrorMs"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
