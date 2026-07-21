#!/usr/bin/env python3
"""Offline browser fault paths: refresh, cancel, and crash recovery."""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / "output" / "playwright"
SCREENSHOT = ARTIFACT_DIR / "offline-browser-faults-final.png"


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


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def post(url: str) -> None:
    request = urllib.request.Request(url, data=b"", method="POST")
    with urllib.request.urlopen(request, timeout=10) as response:
        assert response.status == 204, (url, response.status)


def jobs(base_url: str) -> list[dict]:
    return SUPPORT.read_json(f"{base_url}/api/v1/jobs?limit=100")["jobs"]


def wait_for(label: str, read, accept, timeout: float = 30) -> object:
    deadline = time.monotonic() + timeout
    last: object = None
    while time.monotonic() < deadline:
        try:
            last = read()
            if accept(last):
                return last
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {label}; last={last!r}")


def newest_image_job(base_url: str, excluded: set[str] | None = None) -> dict | None:
    excluded = excluded or set()
    candidates = [
        job
        for job in jobs(base_url)
        if job.get("type") == "asset.image.generate" and job.get("id") not in excluded
    ]
    return candidates[0] if candidates else None


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    port = reserve_port()
    source_text = "黄昏时，守灯人穿过古港，点亮归航灯，让迷雾中的船找到回家的方向。"
    current_process = None
    all_server_output: list[str] = []
    started_at = time.monotonic()

    with tempfile.TemporaryDirectory(prefix="manju-browser-faults-") as temporary:
        runtime_dir = Path(temporary) / "runtime"
        current_process, base_url, server_output = SUPPORT.start_server(runtime_dir, port)
        all_server_output.extend(server_output)

        external_requests: list[str] = []
        page_errors: list[str] = []
        unexpected_console_errors: list[str] = []
        expected_restart_console_errors: list[str] = []
        expected_not_found_responses: list[str] = []
        expected_not_found_console_errors: list[str] = []
        expected_paid_console_errors: list[str] = []
        failed_responses: list[str] = []
        restarting = False
        restart_performed = False

        try:
            with sync_playwright() as playwright:
                executable = SUPPORT.system_chromium_executable()
                browser = playwright.chromium.launch(
                    headless=True,
                    **({"executable_path": executable} if executable else {}),
                )
                context = browser.new_context(viewport={"width": 1440, "height": 1000})

                def route_request(route, request) -> None:
                    parsed = urlparse(request.url)
                    if parsed.scheme in {"http", "https"} and parsed.hostname not in {"127.0.0.1", "localhost"}:
                        external_requests.append(request.url)
                        route.abort("blockedbyclient")
                    else:
                        route.continue_()

                def console_message(message) -> None:
                    if message.type != "error":
                        return
                    if (
                        message.text == "Failed to load resource: the server responded with a status of 404 (Not Found)"
                        and len(expected_not_found_console_errors) < len(expected_not_found_responses)
                    ):
                        expected_not_found_console_errors.append(message.text)
                    elif "Failed to load resource" in message.text and "409" in message.text:
                        expected_paid_console_errors.append(message.text)
                    elif restart_performed and (
                        "ERR_CONNECTION_REFUSED" in message.text
                        or "ERR_INCOMPLETE_CHUNKED_ENCODING" in message.text
                    ):
                        expected_restart_console_errors.append(message.text)
                    else:
                        unexpected_console_errors.append(message.text)

                def response_received(response) -> None:
                    path = urlparse(response.url).path
                    if response.status >= 400:
                        failed_responses.append(f"{response.status} {response.url}")
                    if response.status == 404 and (
                        path.endswith("/story") or path.endswith("/timeline-document")
                    ):
                        expected_not_found_responses.append(response.url)

                context.route("**/*", route_request)
                page = context.new_page()
                page.on("console", console_message)
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.on("response", response_received)
                page.set_default_timeout(45_000)

                try:
                    page.goto(base_url, wait_until="domcontentloaded")
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.get_by_role("heading", name="故事原文").wait_for()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    source = page.locator(".source-editor textarea")
                    assert source.input_value() == ""
                    source.fill(source_text)
                    page.locator(".segmented-control button", has_text="30").click()
                    page.get_by_role("button", name="生成结构剧本", exact=True).click()
                    page.get_by_role("heading", name="角色与场景准备", exact=True, level=1).wait_for()
                    page.locator(".pipeline-step", has_text="拆剧本与配音").click()
                    page.get_by_role("heading", name="第 1 集 · 结构剧本").wait_for()

                    # Refresh must reconstruct both the Episode source and the
                    # generated immutable Story from SQLite, not browser-only state.
                    page.reload(wait_until="domcontentloaded")
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    assert page.locator(".source-editor textarea").input_value() == source_text
                    page.locator(".pipeline-step", has_text="拆剧本与配音").click()
                    page.get_by_role("heading", name="第 1 集 · 结构剧本").wait_for()
                    page.locator(".pipeline-step", has_text="分镜与逐镜视频").click()
                    first_shot = page.locator(".shot-card").first
                    # Fault injection targets Provider cancellation/recovery,
                    # not reference authoring. Use the visible text-only mode
                    # so reference safety cannot be mistaken for a paid gate.
                    consistency_switch = page.locator(".consistency-section button.switch")
                    assert "on" in (consistency_switch.get_attribute("class") or "").split()
                    consistency_switch.click()
                    assert "on" not in (consistency_switch.get_attribute("class") or "").split()

                    # A user cancellation aborts the real worker signal and
                    # publishes a durable cancelled row observed by the UI.
                    post(f"{base_url}/__e2e__/control/hold-next-image")
                    first_shot.get_by_role("button", name="生成当前镜头", exact=True).click()
                    SUPPORT.confirm_paid_browser_tasks(
                        page,
                        count=1,
                        endpoint_fragment="/api/v1/assets/image-generations",
                    )
                    wait_for(
                        "held cancellable Provider call",
                        lambda: SUPPORT.read_json(f"{base_url}/__e2e__/evidence"),
                        lambda value: value.get("heldImageRequests") == 1,
                    )
                    first_job = wait_for(
                        "first image Job waiting_provider",
                        lambda: newest_image_job(base_url),
                        lambda value: isinstance(value, dict) and value.get("status") == "waiting_provider",
                    )
                    first_job_id = first_job["id"]
                    first_shot.get_by_role("button", name="中断任务", exact=True).click()
                    cancelled = wait_for(
                        "durable cancelled image Job",
                        lambda: next((job for job in jobs(base_url) if job.get("id") == first_job_id), None),
                        lambda value: isinstance(value, dict) and value.get("status") == "cancelled",
                    )
                    assert cancelled["id"] == first_job_id
                    first_shot.locator(".status-badge", has_text="待生成").wait_for()

                    # Crash after a non-idempotent Provider submission. On the
                    # next process the same durable Job must fail closed rather
                    # than submitting and potentially billing a second time.
                    post(f"{base_url}/__e2e__/control/hold-next-image")
                    first_shot.get_by_role("button", name="生成当前镜头", exact=True).click()
                    SUPPORT.confirm_paid_browser_tasks(
                        page,
                        count=1,
                        endpoint_fragment="/api/v1/assets/image-generations",
                    )
                    # The retry path first reads the cancelled Job and only
                    # then dispatches a new create request. Pump Playwright so
                    # the fail-closed route interceptor can continue that
                    # asynchronous follow-up request.
                    page.wait_for_timeout(1_000)
                    wait_for(
                        "second held Provider call",
                        lambda: SUPPORT.read_json(f"{base_url}/__e2e__/evidence"),
                        lambda value: value.get("heldImageRequests") == 2,
                    )
                    second_job = wait_for(
                        "second image Job waiting_provider",
                        lambda: newest_image_job(base_url, {first_job_id}),
                        lambda value: isinstance(value, dict) and value.get("status") == "waiting_provider",
                    )
                    second_job_id = second_job["id"]
                    before_crash = SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
                    assert before_crash["providerCalls"]["image"] == 2, before_crash

                    restarting = True
                    restart_performed = True
                    os.killpg(current_process.pid, signal.SIGKILL)
                    current_process.wait(timeout=10)
                    current_process, restarted_url, restarted_output = SUPPORT.start_server(runtime_dir, port)
                    all_server_output.extend(restarted_output)
                    assert restarted_url == base_url
                    recovered = wait_for(
                        "same durable Job fail-closed recovery",
                        lambda: next((job for job in jobs(base_url) if job.get("id") == second_job_id), None),
                        lambda value: isinstance(value, dict) and value.get("status") == "failed",
                    )
                    assert recovered["id"] == second_job_id
                    assert recovered["error"]["code"] == "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN", recovered
                    after_restart = SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
                    assert after_restart["providerCalls"]["image"] == 0, after_restart
                    assert after_restart["unexpectedNetworkRequests"] == 0, after_restart

                    page.reload(wait_until="domcontentloaded")
                    restarting = False
                    page.get_by_role("button", name="分集制作", exact=True).click()
                    page.locator(".save-state", has_text="已保存").wait_for()
                    page.locator(".pipeline-step", has_text="分镜与逐镜视频").click()
                    failed_shot = page.locator(".shot-card.failed").first
                    failed_shot.wait_for()
                    assert "避免重复计费" in failed_shot.inner_text()
                    page.screenshot(path=str(SCREENSHOT), full_page=True)
                except Exception:
                    page.screenshot(path=str(SCREENSHOT), full_page=True)
                    raise
                finally:
                    context.close()
                    browser.close()

            assert not external_requests, external_requests
            assert not page_errors, page_errors
            allowed_404s = [
                response
                for response in failed_responses
                if response.startswith("404 ")
                and (
                    urlparse(response.split(" ", 1)[1]).path.endswith("/story")
                    or urlparse(response.split(" ", 1)[1]).path.endswith("/timeline-document")
                )
            ]
            allowed_paid_preflights = SUPPORT.expected_paid_preflight_responses(
                failed_responses,
                {"/api/v1/assets/image-generations": 2},
            )
            unexpected_responses = [
                response
                for response in failed_responses
                if response not in allowed_404s and response not in allowed_paid_preflights
            ]
            assert len(expected_paid_console_errors) <= len(allowed_paid_preflights), (
                expected_paid_console_errors,
                allowed_paid_preflights,
            )
            assert not unexpected_responses, unexpected_responses
            assert not unexpected_console_errors, unexpected_console_errors
        finally:
            if current_process is not None:
                SUPPORT.stop_server(current_process)

    print(
        json.dumps(
            {
                "ok": True,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
                "refreshRecovered": True,
                "cancelledJobId": first_job_id,
                "restartRecoveredJobId": second_job_id,
                "restartOutcome": "PROVIDER_SUBMISSION_OUTCOME_UNKNOWN",
                "expectedRestartConsoleErrors": len(expected_restart_console_errors),
                "expectedNotFoundResponses": len(expected_not_found_responses),
                "screenshot": str(SCREENSHOT.relative_to(ROOT)),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
