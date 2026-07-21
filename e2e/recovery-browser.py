#!/usr/bin/env python3
"""Offline browser golden for timing remediation and OpenCut quarantine rescue.

The fixture authors durable SQLite incidents before the browser starts. The UI
must route a STALE_AUDIO_TIMING Job through stage 3, require an explicit stage
4 free preflight, quarantine an unparseable authoritative OpenCut head, expose
its exact raw JSON, and restore a compatible immutable history revision. No
Provider method or external network request is allowed.
"""

from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / "output" / "recovery-golden"
SCREENSHOT = ARTIFACT_DIR / "recovery-complete.png"
RAW_TIMELINE = ARTIFACT_DIR / "quarantined-authoritative-head.json"
RENDER_RESCUE = ARTIFACT_DIR / "render-unsupported-head-rescue.json"
RENDER_RESCUE_SCREENSHOT = ARTIFACT_DIR / "render-unsupported-rescue.png"


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


def assert_zero_provider_calls(evidence: dict) -> None:
    assert evidence["providerCalls"] == {
        "text": 0,
        "image": 0,
        "speech": 0,
        "video": 0,
    }, evidence
    assert evidence["unexpectedNetworkRequests"] == 0, evidence
    assert evidence["localVoiceCatalogRequests"] == 0, evidence


def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    started_at = time.monotonic()
    process = None
    render_unsupported_revision_id = None
    render_preview_head_id = None
    render_revision_count_before_preview = 0

    with tempfile.TemporaryDirectory(prefix="manju-recovery-golden-") as temporary:
        runtime_dir = Path(temporary) / "runtime"
        process, base_url, server_output = SUPPORT.start_server(
            runtime_dir,
            extra_env={"MANJU_E2E_RECOVERY_GOLDEN": "1"},
        )
        external_requests: list[str] = []
        page_errors: list[str] = []
        console_errors: list[str] = []
        failed_responses: list[str] = []

        try:
            fixture = SUPPORT.read_json(f"{base_url}/__e2e__/recovery-evidence")
            before_evidence = SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
            assert before_evidence["recoveryGolden"] is True, before_evidence
            assert_zero_provider_calls(before_evidence)
            assert fixture["currentTimelineRevisionId"] == fixture["incompatibleRevisionId"], fixture
            assert fixture["timelineRevisionIds"] == [
                fixture["incompatibleRevisionId"],
                fixture["compatibleRevisionId"],
            ], fixture
            assert "future-hologram" in json.dumps(
                fixture["currentTimelineDocument"], ensure_ascii=False
            )

            job_payload = SUPPORT.read_json(
                f"{base_url}/api/v1/jobs/{fixture['staleTimingJobId']}"
            )["job"]
            assert job_payload["retryDisposition"] == "paid-reconfirmation-required", job_payload
            assert job_payload["timingRemediation"]["checkpoint"] == "pre-submit", job_payload
            assert job_payload["timingRemediation"]["providerSubmissionState"] == "not-started", job_payload

            with sync_playwright() as playwright:
                executable = SUPPORT.system_chromium_executable()
                browser = playwright.chromium.launch(
                    headless=True,
                    **({"executable_path": executable} if executable else {}),
                )
                context = browser.new_context(
                    accept_downloads=True,
                    permissions=["clipboard-read", "clipboard-write"],
                    viewport={"width": 1600, "height": 1100},
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

                def response_received(response) -> None:
                    if response.status >= 400:
                        failed_responses.append(f"{response.status} {response.url}")

                context.route("**/*", route_request)
                page = context.new_page()
                page.on(
                    "console",
                    lambda message: console_errors.append(message.text)
                    if message.type == "error"
                    else None,
                )
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                page.on("response", response_received)
                page.set_default_timeout(45_000)

                try:
                    page.goto(base_url, wait_until="domcontentloaded")
                    page.locator(".save-state", has_text="已保存").wait_for()

                    # Task Center owns the fee-safe routing decision. Clicking
                    # "重新预检" must not retry a Job or invoke a Provider.
                    page.get_by_role(
                        "button", name=re.compile(r"^任务中心，")
                    ).click()
                    task_center = page.get_by_role("dialog", name="任务中心")
                    task_center.wait_for()
                    stale_task = task_center.locator(".task-item", has_text="视频生成").filter(
                        has_text="视频时长合同失效"
                    )
                    assert stale_task.count() == 1, task_center.inner_text()
                    stale_task.get_by_role("button", name="重新预检", exact=True).click()

                    remediation = page.locator('[aria-label="音频时长恢复"]')
                    remediation.wait_for()
                    remediation_text = remediation.inner_text()
                    assert "旧剪辑点为 2.00 秒" in remediation_text, remediation_text
                    assert "3.00 秒" in remediation_text, remediation_text
                    assert "尚未创建 Provider task" in remediation_text, remediation_text
                    assert "没有自动生成语音，也不会自动重提 Seedance" in remediation_text
                    page.wait_for_function(
                        "document.activeElement?.dataset?.dialogueLineId === 'line-1'"
                    )
                    assert_zero_provider_calls(
                        SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
                    )

                    # Recovery is deliberately user-driven: first acknowledge
                    # stage 3, then explicitly click the free stage-4 preflight.
                    remediation.get_by_role(
                        "button",
                        name=re.compile(
                            r"^我已核对 \/ 修复语音，进入(?:第 4 阶段|分镜与逐镜视频)$"
                        ),
                    ).click()
                    video_dialog = page.get_by_role("dialog", name="逐镜视频批量生成")
                    video_dialog.wait_for()
                    recovery_summary = video_dialog.locator(".shot-video-recovery-summary")
                    assert "仅定位镜头 R1" in recovery_summary.inner_text(), recovery_summary.inner_text()
                    selected_shots = video_dialog.locator(
                        ".shot-video-batch-shot-list > article.selected"
                    )
                    assert selected_shots.count() == 1, video_dialog.inner_text()
                    assert "R1 · 海雾中的旧灯" in selected_shots.inner_text()
                    assert video_dialog.locator(
                        ".shot-video-batch-shot-list > article.selected input[type=checkbox]"
                    ).is_checked()

                    preflight_button = video_dialog.get_by_role(
                        "button", name="第一步：快速权威预检", exact=True
                    )
                    preflight_button.wait_for(state="visible")
                    assert preflight_button.is_enabled(), video_dialog.inner_text()
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and "/video-generations/preflight" in response.url
                            and response.status == 200
                        ),
                        timeout=45_000,
                    ):
                        preflight_button.click()
                    preflight = video_dialog.locator(".shot-video-preflight-card")
                    preflight.wait_for()
                    preflight_text = preflight.inner_text()
                    assert "可计费任务\n1" in preflight_text, preflight_text
                    assert "剪辑 3.00s / 生成 4s" in preflight_text, preflight_text
                    assert video_dialog.get_by_role(
                        "button", name="确认 1 个计费任务并开始", exact=True
                    ).is_visible()
                    assert_zero_provider_calls(
                        SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
                    )

                    # Do not confirm the paid task. Close the dialog and prove
                    # that the already-loaded incompatible authoritative head
                    # is quarantined rather than reconciled or shown as fallback.
                    video_dialog.get_by_role(
                        "button", name="关闭 Seedance 批量生成", exact=True
                    ).click()
                    quarantine = page.locator(
                        '[aria-label="authoritative 时间线兼容性隔离"]'
                    )
                    quarantine.wait_for()
                    quarantine_text = quarantine.inner_text()
                    assert "当前 authoritative head 已持久隔离" in quarantine_text
                    assert "没有用分镜 fallback 伪装成可编辑时间线" in quarantine_text
                    assert page.get_by_role("button", name="播放", exact=True).is_disabled()

                    with page.expect_download() as download_info:
                        quarantine.get_by_role(
                            "button", name="下载当前 raw JSON", exact=True
                        ).click()
                    download_info.value.save_as(RAW_TIMELINE)
                    raw = json.loads(RAW_TIMELINE.read_text(encoding="utf-8"))
                    assert raw["kind"] == "manju.timeline-authoritative-canonical-quarantine", raw
                    assert raw["revision"]["id"] == fixture["incompatibleRevisionId"], raw
                    raw_document = json.dumps(raw["document"], ensure_ascii=False)
                    for marker in [
                        "future-hologram",
                        "vendor.future-refraction",
                        "vendor.depthPulse",
                    ]:
                        assert marker in raw_document, marker

                    with page.expect_response(
                        lambda response: (
                            response.request.method == "GET"
                            and "/timeline-documents/" in response.url
                            and response.url.endswith("/revisions?limit=100")
                            and response.status == 200
                        ),
                        timeout=45_000,
                    ):
                        quarantine.get_by_role(
                            "button", name="选择兼容历史", exact=True
                        ).click()
                    history = page.locator('[aria-label="时间线修订历史"]')
                    history.wait_for()
                    incompatible_row = history.locator(
                        '.timeline-history-list > button[data-restorable="false"]',
                        has_text="E2E incompatible future head",
                    )
                    compatible_row = history.locator(
                        '.timeline-history-list > button[data-restorable="true"]',
                        has_text="E2E compatible canonical head",
                    )
                    assert incompatible_row.count() == 1, history.inner_text()
                    assert "不可恢复" in incompatible_row.inner_text()
                    assert compatible_row.count() == 1, history.inner_text()
                    compatible_row.click()
                    restore_button = history.get_by_role(
                        "button", name="恢复为新修订", exact=True
                    )
                    assert restore_button.is_enabled(), history.inner_text()
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and "/timeline-document/revisions/" in response.url
                            and response.url.endswith("/restore")
                            and response.status == 201
                        ),
                        timeout=45_000,
                    ):
                        restore_button.click()

                    quarantine.wait_for(state="detached")
                    page.locator(".opencut-controller-timeline:not(.timeline-canonical-quarantine-active)").wait_for()

                    # A canonical document can still contain a future effect
                    # that the audited renderer subset cannot reproduce. Save
                    # that exact document as a normal immutable head, reload,
                    # and prove Preview refuses approximation while exporting
                    # a revision/ETag-pinned rescue envelope.
                    render_head = page.evaluate(
                        """async ({ episodeId }) => {
                          const url = `/api/v1/episodes/${encodeURIComponent(episodeId)}/timeline-document`;
                          const read = await fetch(url, { cache: 'no-store' });
                          if (!read.ok) throw new Error(`timeline read failed: ${read.status}`);
                          const snapshot = await read.json();
                          const document = structuredClone(snapshot.document);
                          const tracks = [
                            ...(document.tracks?.overlay ?? []),
                            document.tracks?.main,
                          ].filter(Boolean);
                          const element = tracks.flatMap((track) => track.elements ?? [])
                            .find((candidate) => candidate.type === 'image' || candidate.type === 'video');
                          if (!element) throw new Error('canonical head has no visual element');
                          element.effects = [{
                            type: 'future-volumetric-light',
                            vendorPayload: { intensity: 0.72, color: '#ffbc88' },
                          }];
                          element.futureElementField = { mustRoundTrip: ['alpha', 7, true] };
                          const saved = await fetch(url, {
                            method: 'PUT',
                            headers: {
                              'Content-Type': 'application/json',
                              'If-Match': snapshot.etag,
                            },
                            body: JSON.stringify({
                              projectId: snapshot.timelineDocument.projectId,
                              schemaVersion: snapshot.revision.schemaVersion,
                              upstreamCommit: snapshot.revision.upstreamCommit,
                              summary: 'E2E canonical but render-unsupported effect',
                              document,
                            }),
                          });
                          const payload = await saved.json();
                          if (!saved.ok) throw new Error(`timeline save failed: ${saved.status} ${JSON.stringify(payload)}`);
                          return payload;
                        }""",
                        {"episodeId": fixture["episodeId"]},
                    )
                    render_unsupported_revision_id = render_head["revision"]["id"]
                    page.goto(
                        f"{base_url}/?stage=export",
                        wait_until="domcontentloaded",
                    )
                    page.locator(".save-state", has_text="已保存").wait_for()
                    with page.expect_response(
                        lambda response: (
                            response.request.method == "POST"
                            and response.url.endswith("/timeline-document/reconcile")
                            and response.status == 200
                        ),
                        timeout=45_000,
                    ):
                        page.get_by_role("button", name="预览", exact=True).click()
                    before_render_preview = SUPPORT.read_json(
                        f"{base_url}/__e2e__/recovery-evidence"
                    )
                    render_preview_head_id = before_render_preview["currentTimelineRevisionId"]
                    render_revision_count_before_preview = len(
                        before_render_preview["timelineRevisionIds"]
                    )
                    assert render_unsupported_revision_id in before_render_preview[
                        "timelineRevisionIds"
                    ]
                    assert "future-volumetric-light" in json.dumps(
                        before_render_preview["currentTimelineDocument"], ensure_ascii=False
                    )
                    preview = page.get_by_role("dialog", name=re.compile(r'^预览「'))
                    preview.wait_for()
                    rescue = preview.get_by_role("alert", name="时间线渲染保真救援")
                    rescue.wait_for()
                    rescue_text = rescue.inner_text()
                    assert "已拒绝不保真预览，原始 OpenCut 数据保持不变" in rescue_text
                    assert "不会被删除、扁平化或用近似效果替代" in rescue_text
                    assert "UNSUPPORTED_TIMELINE" in preview.inner_text()
                    assert ".effects" in preview.inner_text()
                    page.screenshot(path=str(RENDER_RESCUE_SCREENSHOT), full_page=True)

                    with page.expect_download() as render_download:
                        rescue.get_by_role(
                            "button", name="下载完整 JSON", exact=True
                        ).click()
                    render_download.value.save_as(RENDER_RESCUE)
                    render_raw = json.loads(RENDER_RESCUE.read_text(encoding="utf-8"))
                    assert render_raw["kind"] == "manju.timeline-render-compatibility-rescue"
                    assert render_raw["scope"]["timelineRevisionId"] == render_preview_head_id
                    assert render_raw["scope"]["timelineEtag"] == f'W/"{render_preview_head_id}"'
                    render_document = json.dumps(render_raw["document"], ensure_ascii=False)
                    assert "future-volumetric-light" in render_document
                    assert "futureElementField" in render_document
                    assert "vendorPayload" in render_document
                    rescue.get_by_role(
                        "button", name="回到时间线检查", exact=True
                    ).click()
                    preview.wait_for(state="detached")
                    page.screenshot(path=str(SCREENSHOT), full_page=True)
                except Exception:
                    page.screenshot(path=str(SCREENSHOT), full_page=True)
                    raise
                finally:
                    context.close()
                    browser.close()

            after = SUPPORT.read_json(f"{base_url}/__e2e__/recovery-evidence")
            after_evidence = SUPPORT.read_json(f"{base_url}/__e2e__/evidence")
            assert_zero_provider_calls(after_evidence)
            assert after["currentTimelineRevisionId"] not in {
                fixture["compatibleRevisionId"],
                fixture["incompatibleRevisionId"],
            }, after
            assert after["currentTimelineRevisionId"] == render_preview_head_id, after
            assert render_unsupported_revision_id in after["timelineRevisionIds"], after
            assert len(after["timelineRevisionIds"]) == render_revision_count_before_preview, after
            assert "future-hologram" not in json.dumps(
                after["currentTimelineDocument"], ensure_ascii=False
            ), after
            current_render_head = json.dumps(
                after["currentTimelineDocument"], ensure_ascii=False
            )
            assert "future-volumetric-light" in current_render_head, after
            assert "futureElementField" in current_render_head, after
            immutable_incompatible = next(
                revision
                for revision in after["timelineRevisions"]
                if revision["id"] == fixture["incompatibleRevisionId"]
            )
            assert "future-hologram" in json.dumps(
                immutable_incompatible["snapshot"], ensure_ascii=False
            ), immutable_incompatible
            assert after["staleTimingJobStatus"] == "failed", after

            assert not external_requests, external_requests
            assert not page_errors, page_errors
            # Browsers may log the expected HTTP 404 for an absent optional
            # narrator profile. All other console/network errors are failures.
            optional_profile_404s = [
                item
                for item in failed_responses
                if item.startswith("404 ")
                and "/project-narrator-voice-profile" in item
            ]
            unexpected_responses = [
                item for item in failed_responses if item not in optional_profile_404s
            ]
            expected_console_404s = [
                item
                for item in console_errors
                if "Failed to load resource" in item and "404" in item
            ]
            unexpected_console = [
                item for item in console_errors if item not in expected_console_404s
            ]
            assert not unexpected_responses, unexpected_responses
            assert not unexpected_console, unexpected_console
        finally:
            if process is not None:
                SUPPORT.stop_server(process)

    print(
        json.dumps(
            {
                "ok": True,
                "elapsedSeconds": round(time.monotonic() - started_at, 2),
                "timingRecovery": "task-center -> audio -> explicit-free-preflight",
                "providerCalls": 0,
                "openCutRecovery": "quarantine -> raw-json -> immutable-history-restore -> strict-render-rescue",
                "screenshot": str(SCREENSHOT.relative_to(ROOT)),
                "rawTimeline": str(RAW_TIMELINE.relative_to(ROOT)),
                "renderRescue": str(RENDER_RESCUE.relative_to(ROOT)),
                "renderRescueScreenshot": str(RENDER_RESCUE_SCREENSHOT.relative_to(ROOT)),
                "serverLogLines": len(server_output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
