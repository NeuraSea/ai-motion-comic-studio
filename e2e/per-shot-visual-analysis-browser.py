#!/usr/bin/env python3
"""Offline browser golden for per-shot and batched visual-reference analysis.

The browser uses production HTTP/Job/UI boundaries against deterministic,
in-process image + structured-vision fixtures. It proves that analysis is an
explicit free action attached to each shot card, batch ambiguity recovery is
still prominent, results survive another shot and a hard page refresh, and a
later Seedance *preflight* carries the exact durable Job ID for every shot.
The paid Seedance confirmation is never clicked and every external request is
blocked.
"""

from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Locator, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / "output" / "per-shot-visual-analysis-golden"
SCREENSHOT = ARTIFACT_DIR / "per-shot-visual-analysis-complete.png"


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


def wait_for_locator_text(
    locator: Locator,
    expected: str,
    *,
    timeout_seconds: float = 45,
) -> str:
    deadline = time.monotonic() + timeout_seconds
    last = ""
    while time.monotonic() < deadline:
        try:
            last = locator.inner_text()
        except Exception:
            last = ""
        if expected in last:
            return last
        time.sleep(0.12)
    raise AssertionError({"expected": expected, "actual": last})


def set_checkbox(checkbox: Locator, checked: bool) -> None:
    checkbox.wait_for(state="visible")
    if checkbox.is_checked() != checked:
        checkbox.click()
    assert checkbox.is_checked() is checked


def enter_video_dialog(page: Page):
    pipeline = page.get_by_role("navigation", name="生产流程")
    pipeline.get_by_role(
        "button", name=re.compile(r"分镜与逐镜视频")
    ).click()
    shot_grid = page.locator(".shot-grid")
    shot_grid.wait_for()
    assert shot_grid.locator(".shot-card").count() == 6, shot_grid.inner_text()
    shot_grid.locator(".shot-card").first.click()
    panel = page.get_by_role("region", name="逐镜 AI 视频")
    panel.wait_for()
    panel.get_by_role(
        "button",
        name=re.compile(r"打开批量工作台|配置镜头并预检"),
    ).click()
    dialog = page.get_by_role("dialog", name="逐镜视频批量生成")
    dialog.wait_for()
    return dialog


def assert_media_provider_boundary(evidence: dict, *, text_calls: int) -> None:
    # Text calls below are deterministic in-process LLM/Agentic boundaries and
    # carry the persisted `free-llm` platform policy. No image/speech/video or
    # external Provider request is allowed.
    assert evidence["providerCalls"] == {
        "text": text_calls,
        "image": 0,
        "speech": 0,
        "video": 0,
    }, evidence
    assert evidence["unexpectedNetworkRequests"] == 0, evidence
    assert evidence["providerBoundary"] == "in-process-structured-vision-fixture", evidence


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    started_at = time.monotonic()
    process = None

    with tempfile.TemporaryDirectory(prefix="manju-per-shot-visual-golden-") as temporary:
        runtime_dir = Path(temporary) / "runtime"
        process, base_url, server_output = SUPPORT.start_server(
            runtime_dir,
            extra_env={"MANJU_E2E_PER_SHOT_VISUAL_GOLDEN": "1"},
        )
        external_requests: list[str] = []
        page_errors: list[str] = []
        console_errors: list[str] = []
        failed_responses: list[str] = []
        job_reads: list[str] = []
        batch_reads: list[str] = []
        analysis_posts: list[dict] = []
        seedance_paid_posts: list[str] = []

        try:
            fixture = SUPPORT.read_json(
                f"{base_url}/__e2e__/per-shot-visual-evidence"
            )
            before = SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
            assert len(fixture["shots"]) == 6, fixture
            assert fixture["jobs"] == [], fixture
            assert fixture["boundaryCalls"] == [], fixture
            assert before["perShotVisualGolden"] is True, before
            assert_media_provider_boundary(before, text_calls=0)

            with sync_playwright() as playwright:
                executable = SUPPORT.system_chromium_executable()
                browser = playwright.chromium.launch(
                    headless=True,
                    **({"executable_path": executable} if executable else {}),
                )
                context = browser.new_context(
                    viewport={"width": 1720, "height": 1200},
                )

                def route_request(route, request) -> None:
                    parsed = urlparse(request.url)
                    if (
                        parsed.scheme in {"http", "https"}
                        and parsed.hostname not in {"127.0.0.1", "localhost"}
                    ):
                        external_requests.append(request.url)
                        route.abort("blockedbyclient")
                    else:
                        route.continue_()

                def request_seen(request) -> None:
                    if (
                        request.method == "GET"
                        and re.search(r"/api/v1/jobs/[^/?]+$", request.url)
                    ):
                        job_reads.append(request.url.rsplit("/", 1)[-1])
                    if (
                        request.method == "GET"
                        and "/video-reference-analysis-batches/" in request.url
                    ):
                        batch_reads.append(request.url.split("?", 1)[0].rsplit("/", 1)[-1])
                    if (
                        request.method == "POST"
                        and request.url.endswith("/video-reference-analyses")
                    ):
                        analysis_posts.append(request.post_data_json)
                    if (
                        request.method == "POST"
                        and re.search(r"/video-generations$", request.url)
                    ):
                        seedance_paid_posts.append(request.url)

                def response_seen(response) -> None:
                    if response.status >= 400:
                        failed_responses.append(f"{response.status} {response.url}")

                context.route("**/*", route_request)
                page = context.new_page()
                page.on("request", request_seen)
                page.on("response", response_seen)
                page.on(
                    "console",
                    lambda message: console_errors.append(message.text)
                    if message.type == "error"
                    else None,
                )
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.set_default_timeout(45_000)

                try:
                    # The default workspace is now the global project Catalog.
                    # This golden owns an Episode-scoped production fixture,
                    # so enter the production route explicitly instead of
                    # depending on the former default landing page.
                    page.goto(
                        f"{base_url}/?stage=storyboard",
                        wait_until="domcontentloaded",
                    )
                    page.locator(".save-state", has_text="已保存").wait_for()
                    dialog = enter_video_dialog(page)

                    cards = {
                        shot["code"]: dialog.locator(
                            f'article[aria-label="{shot["code"]} 逐镜生成配置"]'
                        )
                        for shot in fixture["shots"]
                    }
                    for code, card in cards.items():
                        card.wait_for()
                        # The explicit analysis action is a sibling of the
                        # paid-selection label, never hidden in selected-only
                        # reference controls.
                        analyze = card.get_by_role(
                            "button", name=f"分析 {code} 视觉参考", exact=True
                        )
                        assert analyze.count() == 1, card.inner_text()
                        assert analyze.is_visible(), code

                    # Select exactly V1 + V2, then let the fast deterministic
                    # preflight return both real view ambiguities in one 409.
                    for code, card in cards.items():
                        set_checkbox(
                            card.locator('input[type="checkbox"]').first,
                            code in {"V1", "V2"},
                        )
                    preflight_button = dialog.get_by_role(
                        "button", name="第一步：快速权威预检", exact=True
                    )
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and response.url.endswith("/video-generations/preflight")
                            and response.status == 409
                        )
                    ):
                        preflight_button.click()

                    batch = dialog.locator(
                        '[aria-label="批量分析预检歧义镜头"]'
                    )
                    batch.wait_for()
                    batch_text = batch.inner_text()
                    assert "共 2 个歧义镜头" in batch_text, batch_text
                    batch_button = batch.get_by_role(
                        "button", name="批量分析 2 个歧义镜头", exact=True
                    )
                    assert batch_button.is_visible() and batch_button.is_enabled(), batch_text

                    before_selection = {
                        code: cards[code]
                        .locator('input[type="checkbox"]')
                        .first.is_checked()
                        for code in ["V1", "V2"]
                    }
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and response.url.endswith("/video-reference-analyses")
                            and response.status == 202
                        )
                    ) as batch_response_info:
                        batch_button.click()
                    batch_payload = batch_response_info.value.json()
                    assert batch_payload["batch"]["counts"]["total"] == 2, batch_payload
                    batch_jobs = batch_payload["jobs"]
                    assert len(batch_jobs) == 2, batch_payload
                    batch_job_ids = [job["id"] for job in batch_jobs]
                    for index, job in enumerate(batch_jobs):
                        assert job["input"]["selectors"] == [{
                            "shotId": f"visual-shot-{index + 1}",
                            "sceneId": "scene-visual",
                        }], job
                        assert job["input"]["batch"] == {
                            "version": 1,
                            "batchId": batch_payload["batch"]["id"],
                            "requestFingerprint": batch_payload["batch"]["requestFingerprint"],
                            "selectionIndex": index,
                            "selectionCount": 2,
                        }, job
                    assert before_selection == {"V1": True, "V2": True}
                    assert all(
                        cards[code].locator('input[type="checkbox"]').first.is_checked()
                        for code in ["V1", "V2"]
                    )

                    v1_status = cards["V1"].locator(
                        '[aria-label="V1 视觉分析状态"]'
                    )
                    v2_status = cards["V2"].locator(
                        '[aria-label="V2 视觉分析状态"]'
                    )
                    v1_status.wait_for()
                    v2_status.wait_for()
                    wait_for_locator_text(v1_status, "分析完成")
                    wait_for_locator_text(v2_status, "分析完成")
                    assert "视觉证据" in v1_status.inner_text(), v1_status.inner_text()
                    assert "视觉证据" in v2_status.inner_text(), v2_status.inner_text()

                    # V3 is intentionally outside the paid selection. Its
                    # card-local button still creates an exact one-shot Job,
                    # does not toggle selection, and cannot erase V1/V2.
                    v3_checkbox = cards["V3"].locator('input[type="checkbox"]').first
                    set_checkbox(v3_checkbox, False)
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and response.url.endswith("/video-reference-analyses")
                            and response.status == 202
                        )
                    ) as single_response_info:
                        cards["V3"].get_by_role(
                            "button", name="分析 V3 视觉参考", exact=True
                        ).click()
                    single_job_payload = single_response_info.value.json()["job"]
                    single_job_id = single_job_payload["id"]
                    assert single_job_payload["input"]["selectors"] == [
                        {"shotId": "visual-shot-3", "sceneId": "scene-visual"}
                    ], single_job_payload
                    assert not v3_checkbox.is_checked()
                    assert "分析完成" in v1_status.inner_text(), v1_status.inner_text()
                    assert "分析完成" in v2_status.inner_text(), v2_status.inner_text()
                    v3_status = cards["V3"].locator(
                        '[aria-label="V3 视觉分析状态"]'
                    )
                    v3_status.wait_for()
                    assert re.search(
                        r"正在创建免费持久任务|持久任务 .*%|分析完成",
                        v3_status.inner_text(),
                    ), v3_status.inner_text()
                    wait_for_locator_text(v3_status, "分析完成")
                    assert "视觉证据" in v3_status.inner_text(), v3_status.inner_text()

                    assert (
                        batch_payload["batch"]["id"] in batch_reads
                        or all(job_id in job_reads for job_id in batch_job_ids)
                    ), {"jobReads": job_reads, "batchReads": batch_reads}
                    assert single_job_id in job_reads, job_reads
                    assert len(analysis_posts) == 2, analysis_posts
                    assert seedance_paid_posts == [], seedance_paid_posts

                    # Hard refresh proves these are durable Job bindings, not
                    # results trapped in modal state. Recovery may list Jobs
                    # and strictly re-read them, but must not invoke the model.
                    page.reload(wait_until="domcontentloaded")
                    page.locator(".save-state", has_text="已保存").wait_for()
                    dialog = enter_video_dialog(page)
                    cards = {
                        shot["code"]: dialog.locator(
                            f'article[aria-label="{shot["code"]} 逐镜生成配置"]'
                        )
                        for shot in fixture["shots"]
                    }
                    for code in ["V1", "V2", "V3"]:
                        status = cards[code].locator(
                            f'[aria-label="{code} 视觉分析状态"]'
                        )
                        wait_for_locator_text(status, "分析完成")
                        assert "视觉证据" in status.inner_text(), status.inner_text()
                    assert len(analysis_posts) == 2, analysis_posts

                    # Select the recovered three shots. The successful free
                    # preflight must name the shared batch Job for V1/V2 and
                    # the separate one-shot Job for V3. Stop at paid confirm.
                    for code, card in cards.items():
                        set_checkbox(
                            card.locator('input[type="checkbox"]').first,
                            code in {"V1", "V2", "V3"},
                        )
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and response.url.endswith("/video-generations/preflight")
                            and response.status == 200
                        )
                    ) as preflight_response_info:
                        dialog.get_by_role(
                            "button", name="第一步：快速权威预检", exact=True
                        ).click()
                    preflight_request = preflight_response_info.value.request.post_data_json
                    assert preflight_request["selections"] == [
                        {
                            "shotId": "visual-shot-1",
                            "sceneId": "scene-visual",
                            "referenceAnalysisJobId": batch_job_ids[0],
                        },
                        {
                            "shotId": "visual-shot-2",
                            "sceneId": "scene-visual",
                            "referenceAnalysisJobId": batch_job_ids[1],
                        },
                        {
                            "shotId": "visual-shot-3",
                            "sceneId": "scene-visual",
                            "referenceAnalysisJobId": single_job_id,
                        },
                    ], preflight_request
                    dialog.get_by_role(
                        "button", name="确认 3 个计费任务并开始", exact=True
                    ).wait_for()
                    assert seedance_paid_posts == [], seedance_paid_posts
                    page.screenshot(path=str(SCREENSHOT), full_page=True)
                except Exception:
                    page.screenshot(path=str(SCREENSHOT), full_page=True)
                    raise
                finally:
                    context.close()
                    browser.close()

            after = SUPPORT.read_json(
                f"{base_url}/__e2e__/per-shot-visual-evidence"
            )
            final_evidence = SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
            assert_media_provider_boundary(final_evidence, text_calls=3)
            assert len(after["jobs"]) == 3, after
            assert len(after["boundaryCalls"]) == 3, after
            jobs_by_id = {job["id"]: job for job in after["jobs"]}
            assert set(jobs_by_id) == {*batch_job_ids, single_job_id}, after
            for job in jobs_by_id.values():
                assert job["status"] == "succeeded", job
                policy = job["cost"]["platformPolicy"]
                assert policy["costClass"] == "free-llm", policy
                assert policy["billable"] is False, policy
                assert policy["paidConfirmationRequired"] is False, policy
            boundary_by_id = {
                call["idempotencyKey"]: call for call in after["boundaryCalls"]
            }
            assert boundary_by_id[batch_job_ids[0]]["shotIds"] == [
                "visual-shot-1"
            ], boundary_by_id
            assert boundary_by_id[batch_job_ids[1]]["shotIds"] == [
                "visual-shot-2"
            ], boundary_by_id
            assert boundary_by_id[single_job_id]["shotIds"] == [
                "visual-shot-3"
            ], boundary_by_id
            assert not external_requests, external_requests
            assert not page_errors, page_errors

            expected_failed = [
                item
                for item in failed_responses
                if item.startswith("409 ")
                and item.endswith("/video-generations/preflight")
            ]
            assert len(expected_failed) == 1, failed_responses
            optional_profile_404s = [
                item
                for item in failed_responses
                if item.startswith("404 ")
                and "/project-narrator-voice-profile" in item
            ]
            optional_timeline_404s = [
                item
                for item in failed_responses
                if item.startswith("404 ")
                and item.endswith("/timeline-document")
            ]
            unexpected_responses = [
                item
                for item in failed_responses
                if item not in expected_failed
                and item not in optional_profile_404s
                and item not in optional_timeline_404s
            ]
            assert not unexpected_responses, unexpected_responses
            expected_console_resource_errors = [
                item
                for item in console_errors
                if "Failed to load resource" in item
                and ("404" in item or "409" in item)
            ]
            unexpected_console = [
                item for item in console_errors if item not in expected_console_resource_errors
            ]
            assert not unexpected_console, unexpected_console
        finally:
            if process is not None:
                SUPPORT.stop_server(process)

    print(
        json.dumps(
            {
                "ok": True,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
                "durableVisualJobs": 3,
                "batchAmbiguities": 2,
                "perShotAnalysis": "unselected-card -> exact one-shot Job",
                "refreshRecovery": True,
                "seedanceSubmissions": 0,
                "externalRequests": 0,
                "screenshot": str(SCREENSHOT.relative_to(ROOT)),
                "serverLogLines": len(server_output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
