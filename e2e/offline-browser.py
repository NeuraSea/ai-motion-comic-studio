#!/usr/bin/env python3
"""Strict offline browser golden path for the production Manju UI.

The suite starts a fresh SQLite runtime and a production build. Test-only
providers return deterministic bytes, but every state transition after those
provider boundaries uses the real HTTP API, queue, MediaStore, OpenCut adapter,
FFmpeg renderer, QC analyzer, release gate, and browser download.
"""

from __future__ import annotations

import json
import math
import os
import queue
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path
from urllib.parse import urlparse

try:
    from playwright.sync_api import Page
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError as error:  # pragma: no cover - environment prerequisite
    raise SystemExit(
        "Python Playwright is required for test:e2e:offline. "
        "Install it and Chromium with: pip install playwright && playwright install chromium"
    ) from error


ROOT = Path(__file__).resolve().parents[1]
READY_PREFIX = "MANJU_E2E_READY "
ARTIFACT_DIR = ROOT / "output" / "playwright"
TIMEOUT_MS = 180_000


def system_chromium_executable() -> str | None:
    configured = os.environ.get("MANJU_E2E_BROWSER", "").strip()
    candidates = [
        configured,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
        shutil.which("chromium-browser") or "",
    ]
    return next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)


def make_tone(path: Path, duration_seconds: int = 30) -> None:
    sample_rate = 48_000
    amplitude = 6_000
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        frames = bytearray()
        for index in range(sample_rate * duration_seconds):
            sample = round(math.sin(2 * math.pi * 440 * index / sample_rate) * amplitude)
            frames.extend(struct.pack("<hh", sample, sample))
        output.writeframes(frames)


def read_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def confirm_paid_browser_tasks(
    page: Page,
    *,
    count: int,
    endpoint_fragment: str,
    timeout: float = 120_000,
) -> None:
    """Confirm exactly ``count`` server-signed paid intents through the UI.

    The first POST for each intent is deliberately a non-billable 409
    challenge.  This helper only clicks the shared confirmation dialog after
    that challenge is visible and then requires the acknowledged create POST
    to return 202.  It never injects a token or bypasses the product UX.
    """

    if count < 1:
        raise ValueError("count must be positive")
    for _index in range(count):
        dialog = page.locator(".paid-aigc-confirmation-dialog")
        dialog.wait_for(state="visible", timeout=timeout)
        confirm = dialog.get_by_role(
            "button",
            name="明确确认并创建 1 个任务",
            exact=True,
        )
        confirm.wait_for(state="visible", timeout=timeout)
        assert confirm.is_enabled(), dialog.inner_text()
        with page.expect_response(
            lambda response: (
                response.request.method == "POST"
                and endpoint_fragment in response.url
                and response.status == 202
            ),
            timeout=timeout,
        ) as response_info:
            confirm.click()
        assert response_info.value.status == 202


def paid_json_request(
    url: str,
    *,
    body: dict,
    idempotency_key: str,
    expected_action: str,
    timeout: float = 30,
) -> dict:
    """Perform the real two-step paid HTTP contract with one immutable key."""

    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotency_key,
    }
    request = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode("utf-8"))
        assert error.code == 409, payload
        assert payload.get("error", {}).get("code") == "PAID_CONFIRMATION_REQUIRED", payload
        confirmation = payload.get("error", {}).get("details", {}).get("confirmation", {})
        assert confirmation.get("action") == expected_action, payload
        token = confirmation.get("confirmationToken")
        assert isinstance(token, str) and token.startswith("aigcpf1_"), payload
    else:
        raise AssertionError("Paid create unexpectedly bypassed the confirmation challenge")

    confirmed = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={**headers, "X-Manju-Aigc-Confirmation": token},
    )
    with urllib.request.urlopen(confirmed, timeout=timeout) as response:
        assert response.status == 202, response.status
        return json.loads(response.read().decode("utf-8"))


def expected_paid_preflight_responses(
    failed_responses: list[str],
    expectations: dict[str, int],
) -> list[str]:
    """Return and count only the intentional browser-visible 409 challenges."""

    allowed: list[str] = []
    for fragment, expected_count in expectations.items():
        matches = [
            response
            for response in failed_responses
            if response.startswith("409 ") and fragment in response
        ]
        assert len(matches) == expected_count, {
            "fragment": fragment,
            "expected": expected_count,
            "actual": matches,
            "allFailedResponses": failed_responses,
        }
        allowed.extend(matches)
    return allowed


def start_server(
    runtime_dir: Path,
    port: int = 0,
    extra_env: dict[str, str] | None = None,
) -> tuple[subprocess.Popen[str], str, list[str]]:
    env = os.environ.copy()
    env.update(
        {
            "MANJU_E2E": "1",
            "MANJU_E2E_RUNTIME_DIR": str(runtime_dir),
            "MANJU_WEB_ROOT": str(ROOT / "dist"),
            "MANJU_E2E_PORT": str(port),
        }
    )
    if extra_env:
        env.update(extra_env)
    process = subprocess.Popen(
        [str(ROOT / "node_modules" / ".bin" / "tsx"), "e2e/offline-server.ts"],
        cwd=ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    messages: queue.Queue[str] = queue.Queue()
    output: list[str] = []

    def drain() -> None:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            output.append(line)
            if line.startswith(READY_PREFIX):
                messages.put(line[len(READY_PREFIX) :])
            else:
                print(f"[offline-e2e-server] {line}", file=sys.stderr)

    threading.Thread(target=drain, daemon=True).start()
    try:
        payload = messages.get(timeout=30)
    except queue.Empty as error:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        process.wait(timeout=10)
        raise RuntimeError("Offline E2E server did not become ready:\n" + "\n".join(output)) from error
    base_url = json.loads(payload)["baseUrl"]
    return process, base_url, output


def stop_server(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def ffprobe_assertions(video_path: Path) -> dict:
    ffprobe_path = subprocess.check_output(
        ["node", "-e", "console.log(require('@ffprobe-installer/ffprobe').path)"],
        cwd=ROOT,
        text=True,
    ).strip()
    result = subprocess.run(
        [
            ffprobe_path,
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
    )
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video = next(stream for stream in streams if stream.get("codec_type") == "video")
    audio = next(stream for stream in streams if stream.get("codec_type") == "audio")
    assert video["codec_name"] == "h264", video
    assert video["pix_fmt"] == "yuv420p", video
    assert (video["width"], video["height"]) == (1280, 720), video
    assert audio["codec_name"] == "aac", audio
    assert audio["sample_rate"] == "48000", audio
    assert audio["channels"] == 2, audio
    duration = float(payload["format"]["duration"])
    assert 29.8 <= duration <= 30.2, duration
    return {
        "durationSeconds": duration,
        "video": {"codec": video["codec_name"], "pixelFormat": video["pix_fmt"]},
        "audio": {"codec": audio["codec_name"], "sampleRate": audio["sample_rate"]},
    }


def run_browser(base_url: str, tone_path: Path, download_path: Path, screenshot_path: Path) -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []
    external_requests: list[str] = []
    failed_responses: list[str] = []

    with sync_playwright() as playwright:
        executable = system_chromium_executable()
        browser = playwright.chromium.launch(
            headless=True,
            **({"executable_path": executable} if executable else {}),
        )
        context = browser.new_context(accept_downloads=True, viewport={"width": 1440, "height": 1000})

        def route_request(route, request) -> None:
            parsed = urlparse(request.url)
            if parsed.scheme in {"http", "https"} and parsed.hostname not in {"127.0.0.1", "localhost"}:
                external_requests.append(request.url)
                route.abort("blockedbyclient")
            else:
                route.continue_()

        context.route("**/*", route_request)
        page = context.new_page()
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: failed_responses.append(f"{response.status} {response.url}")
            if response.status >= 400
            else None,
        )
        page.set_default_timeout(30_000)

        try:
            page.goto(base_url, wait_until="domcontentloaded")
            # The global Catalog and Episode production console are separate
            # first-level workspaces. Enter production explicitly instead of
            # relying on the pre-Catalog default route.
            page.get_by_role("button", name="分集制作", exact=True).click()
            page.get_by_role("heading", name="故事原文").wait_for()
            # Do not race the first authoritative Episode bootstrap: it owns
            # the initial source value and would correctly replace an edit
            # made before the "saved" state is reached.
            page.locator(".save-state", has_text="已保存").wait_for(timeout=30_000)
            source = page.locator(".source-editor textarea")
            assert source.input_value() == "", "A fresh runtime must not inject sample project content"
            source.fill("黄昏时，守灯人穿过古港，点亮归航灯，让迷雾中的船找到回家的方向。")
            page.locator(".segmented-control button", has_text="30").click()
            page.get_by_role("button", name="生成结构剧本", exact=True).click()
            page.get_by_role("heading", name="角色与场景准备", exact=True, level=1).wait_for(timeout=45_000)
            page.locator(".pipeline-step", has_text="拆剧本与配音").click()
            page.get_by_role("heading", name="第 1 集 · 结构剧本").wait_for(timeout=45_000)
            script_stats = page.locator(".script-stage .stage-toolbar .score-row")
            script_stats.get_by_text("1 场", exact=True).wait_for()
            script_stats.get_by_text("6 镜", exact=True).wait_for()

            # Stage 3 owns both script review and audio. Even this no-dialogue
            # fixture finishes its publishable BGM before visual production,
            # matching the real audio-first workflow without a paid TTS call.
            page.get_by_role("button", name="继续生成与确认语音", exact=True).click()
            page.get_by_text("时间线可写", exact=True).wait_for(timeout=45_000)
            page.locator(".audio-upload-row input[type=file]").set_input_files(str(tone_path))
            audio_card = page.locator(".user-audio-list article", has_text=tone_path.name)
            audio_card.wait_for(timeout=45_000)
            audio_card.get_by_role("button", name="已加入", exact=True).wait_for(timeout=45_000)

            page.locator(".pipeline-step", has_text="分镜与逐镜视频").click()
            assert page.locator(".shot-card").count() == 6
            # This compact no-dialogue fixture intentionally exercises the
            # explicit text-only recovery path.  The stronger audio-first
            # golden below separately generates, locks, and revalidates real
            # character/location references; never let this test silently
            # bypass the current role-slot admission while the switch says it
            # is enabled.
            consistency_switch = page.locator(".consistency-section button.switch")
            assert "on" in (consistency_switch.get_attribute("class") or "").split()
            consistency_switch.click()
            assert "on" not in (consistency_switch.get_attribute("class") or "").split()
            fill_missing = page.locator("button.generate-all")
            assert "补齐缺失" in fill_missing.inner_text()
            fill_missing.click()
            confirm_paid_browser_tasks(
                page,
                count=6,
                endpoint_fragment="/api/v1/assets/image-generations",
            )
            page.locator("button.generate-all", has_text="分镜已齐").wait_for(timeout=45_000)
            assert page.locator(".shot-card.review").count() == 6

            # Exercise the Manju-owned Seedance UX without confirming or
            # invoking a video Provider. A short desktop viewport proves the
            # confirmation footer remains reachable after the responsive fix.
            # The batch entry names the authoritative pending-shot count once
            # more than one shot is available.
            page.get_by_role(
                "button",
                name=re.compile(r"^打开批量工作台 · 6 镜待生成$"),
            ).click()
            video_dialog = page.get_by_role("dialog", name="逐镜视频批量生成")
            video_dialog.wait_for(timeout=30_000)
            # Open from the normal editor viewport first: at a deliberately
            # short height the pinned inspector tabs can overlap the launcher,
            # while the dialog itself must remain internally scrollable with
            # a reachable confirmation footer.
            page.set_viewport_size({"width": 1024, "height": 600})
            video_dialog.get_by_role("button", name="全选可生成镜头", exact=True).click()
            assert "6 / 6 镜" in video_dialog.inner_text()

            # With no locked character views, the first free preflight must
            # fail closed and return one actionable recovery for every shot.
            # The test then explicitly opts each shot into text-only mode;
            # this is a user choice, never a hidden consistency fallback.
            with page.expect_response(
                lambda response: (
                    response.request.method == "POST"
                    and "/video-generations/preflight" in response.url
                    and response.status == 409
                ),
                timeout=30_000,
            ):
                video_dialog.get_by_role("button", name="第一步：快速权威预检", exact=True).click()
            video_dialog.get_by_text(
                "已一次汇总 6 个待确认镜头；可在下方逐镜处理后统一重新预检。",
                exact=True,
            ).wait_for(timeout=30_000)
            text_only_buttons = video_dialog.locator("button.text-only")
            assert text_only_buttons.count() == 6, video_dialog.inner_text()
            for index in range(text_only_buttons.count()):
                text_only_buttons.nth(index).click()

            video_dialog.get_by_role("button", name="第一步：快速权威预检", exact=True).click()
            video_dialog.get_by_text("服务端权威预检已完成", exact=True).wait_for(timeout=30_000)
            assert video_dialog.locator(".shot-video-preflight-targets > span").count() == 6
            confirmation = video_dialog.get_by_role(
                "button",
                name="确认 6 个计费任务并开始",
                exact=True,
            )
            assert confirmation.is_visible()
            assert confirmation.is_enabled()
            video_dialog.get_by_role("button", name="关闭 Seedance 批量生成", exact=True).click()
            page.set_viewport_size({"width": 1440, "height": 1000})

            page.locator(".pipeline-step", has_text="剪辑与成片").click()
            page.locator(".export-actions button", has_text="导出 MP4").click()
            page.get_by_role("dialog", name="导出「第 1 集」").wait_for()
            page.get_by_role("button", name="720P", exact=True).click()
            page.get_by_label("片头标题落版").uncheck()
            page.get_by_label("片尾结束落版").uncheck()
            page.get_by_role("button", name="创建 FFmpeg 导出任务", exact=True).click()

            page.get_by_text("真实成片已就绪", exact=True).wait_for(timeout=TIMEOUT_MS)
            page.get_by_role("button", name="运行质检", exact=True).click()
            page.get_by_text("真实质检通过", exact=True).wait_for(timeout=TIMEOUT_MS)
            checks = page.locator(".real-qc-list > div")
            assert checks.count() == 7, f"Expected seven QC checks, got {checks.count()}"

            # QC unlocks only the controlled review copy. Publication remains
            # locked until the three human-review facts and acknowledgement
            # are written as an immutable release-review record.
            review_link = page.get_by_role("link", name="下载审片版", exact=True)
            review_link.wait_for()
            assert page.get_by_role("link", name="下载发布版", exact=True).count() == 0
            for label in ["音画匹配", "字幕同步且完整", "角色与画面语义一致"]:
                page.locator(".release-review-checklist label", has_text=label).locator("input").check()
            page.get_by_label("我已在网页或系统播放器中完整审看当前成片", exact=True).check()
            page.get_by_role("button", name="批准发行", exact=True).click()
            download_link = page.get_by_role("link", name="下载发布版", exact=True)
            download_link.wait_for()
            with page.expect_download(timeout=30_000) as download_info:
                download_link.click()
            download_info.value.save_as(str(download_path))
            page.screenshot(path=str(screenshot_path), full_page=True)
        except PlaywrightTimeoutError:
            page.screenshot(path=str(screenshot_path), full_page=True)
            api_diagnostics = page.evaluate(
                """async () => {
                  const read = async (path) => {
                    const response = await fetch(path);
                    return { status: response.status, body: await response.text() };
                  };
                  return {
                    projects: await read('/api/v1/projects'),
                    jobs: await read('/api/v1/jobs?limit=50'),
                    evidence: await read('/__e2e__/evidence'),
                  };
                }"""
            )
            print(
                "[offline-e2e-browser] timeout diagnostics:\n"
                + page.locator("body").inner_text()[:8_000]
                + "\nAPI:\n"
                + json.dumps(api_diagnostics, ensure_ascii=False)[:20_000],
                file=sys.stderr,
            )
            raise
        finally:
            context.close()
            browser.close()

    allowed_bootstrap_404s = [
        response for response in failed_responses
        if response.startswith("404 ")
        and ("/story?projectId=" in response or response.endswith("/timeline-document"))
    ]
    allowed_paid_preflights = expected_paid_preflight_responses(
        failed_responses,
        {"/api/v1/assets/image-generations": 6},
    )
    allowed_reference_recoveries = [
        response
        for response in failed_responses
        if response.startswith("409 ") and "/video-generations/preflight" in response
    ]
    assert len(allowed_reference_recoveries) == 1, {
        "expected": 1,
        "actual": allowed_reference_recoveries,
        "allFailedResponses": failed_responses,
    }
    unexpected_responses = [
        response
        for response in failed_responses
        if response not in allowed_bootstrap_404s
        and response not in allowed_paid_preflights
        and response not in allowed_reference_recoveries
    ]
    generic_404_console = "Failed to load resource: the server responded with a status of 404 (Not Found)"
    remaining_allowed_console = len(allowed_bootstrap_404s)
    remaining_paid_console = len(allowed_paid_preflights) + len(allowed_reference_recoveries)
    unexpected_console: list[str] = []
    for message in console_errors:
        if message == generic_404_console and remaining_allowed_console > 0:
            remaining_allowed_console -= 1
        elif "Failed to load resource" in message and "409" in message and remaining_paid_console > 0:
            remaining_paid_console -= 1
        else:
            unexpected_console.append(message)
    assert not external_requests, f"Browser attempted external requests: {external_requests}"
    assert not page_errors, f"Browser page errors: {page_errors}"
    assert not unexpected_responses, f"Browser received failed responses: {failed_responses}"
    assert not unexpected_console, f"Browser console errors: {console_errors}; responses={failed_responses}"


def main() -> int:
    if not (ROOT / "dist" / "index.html").exists():
        raise SystemExit("dist/index.html is missing; run npm run build first")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    download_path = ARTIFACT_DIR / "offline-browser-e2e.mp4"
    screenshot_path = ARTIFACT_DIR / "offline-browser-e2e-final.png"
    download_path.unlink(missing_ok=True)

    with tempfile.TemporaryDirectory(prefix="manju-browser-e2e-") as temporary:
        temporary_path = Path(temporary)
        tone_path = temporary_path / "offline-tone.wav"
        make_tone(tone_path)
        process, base_url, server_output = start_server(temporary_path / "runtime")
        started_at = time.monotonic()
        try:
            run_browser(base_url, tone_path, download_path, screenshot_path)
            evidence = read_json(f"{base_url}/__e2e__/evidence")
            assert evidence["providerCalls"] == {"text": 1, "image": 6, "speech": 0, "video": 0}, evidence
            assert evidence["unexpectedNetworkRequests"] == 0, evidence
            payload = download_path.read_bytes()
            assert len(payload) > 16 and payload[4:8] == b"ftyp", "Downloaded file is not an MP4"
            media = ffprobe_assertions(download_path)
        finally:
            stop_server(process)
        # Direct Node reports -SIGTERM while the tsx launcher shell convention
        # reports 128 + SIGTERM (143); both are expected after our clean stop.
        if process.returncode not in {0, -15, 143}:
            raise RuntimeError(
                f"Offline E2E server exited with {process.returncode}:\n" + "\n".join(server_output)
            )

    print(
        json.dumps(
            {
                "ok": True,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
                "download": str(download_path.relative_to(ROOT)),
                "screenshot": str(screenshot_path.relative_to(ROOT)),
                "media": media,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
