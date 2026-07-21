#!/usr/bin/env python3
"""Audio-first five-stage browser acceptance with zero external Provider calls.

This suite is intentionally separate from the generic offline golden path. It
starts from an empty temporary SQLite runtime and proves the production UI can
bind narrator/character voices, create six unequal real WAV speech Assets from
stage 3, use those exact Assets as the Seedance/OpenCut timing authority, create
same-source managed subtitles, apply an audited OpenCut Agentic repair, and
finish a formal FFmpeg export plus seven-check QC.
"""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlparse

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ROOT / "output" / "audio-first-e2e"
VIDEO_PATH = ARTIFACT_DIR / "audio-first-formal.mp4"
SCREENSHOT_PATH = ARTIFACT_DIR / "hard-restart-recovered.png"
REPORT_PATH = ARTIFACT_DIR / "report.json"
FRAME_RATE = 24
SHOT_COUNT = 6
SPEECH_FRAMES = [96, 120, 108, 132, 126, 138]
assert sum(SPEECH_FRAMES) == 30 * FRAME_RATE
INITIAL_LINE_TEXTS = [
    "第一镜，海雾压低了远处的天光。",
    "第二镜，阿岚说，旧灯还没有亮。",
    "第三镜，她护住火种走上石阶。",
    "第四镜，阿岚说，归航的人正在等我。",
    "第五镜，铜灯终于穿透层层海雾。",
    "第六镜，阿岚说，看见灯，就能回家。",
]
LINE_TEXTS = [
    "第一镜，海雾压低了远处的天光。",
    "第二镜，阿岚说，灯还没有亮。",
    "第三镜，她护住火种走上石阶。",
    "第四镜，阿岚说，归航的人正在等我。",
    "第五镜，铜灯终于穿透层层海雾。",
    "第六镜，阿岚说，看见灯，就能回家。",
]
FINAL_SHOT_MOVEMENT = "缓慢推近"
EXPECTED_CHARACTER_VIEWS = {
    "shot-1": "front",
    "shot-2": "side",
    "shot-3": "back",
    "shot-4": "front",
    "shot-5": "side",
    "shot-6": "back",
}

# Production-shaped adaptation input, rather than the one-sentence smoke
# fixture. The deterministic text boundary still makes the Story repeatable,
# while the real Episode API must retain this complete Unicode manuscript.
SOURCE_MANUSCRIPT = "\n\n".join([
    "第一章 海雾。古港连续七日看不见日出，潮声贴着青石码头一层层上涨。守灯人阿岚每天在黄昏前检查铜灯、风门和旧绞盘。她记得师父说过，雾越厚，灯越不能迟到，因为海上的人只能把那一点暖光当成岸的方向。",
    "港务所的钟停在五点四十分，最后一班归航船却没有出现。渔民家属聚在仓门下，没人高声说话，只把写有船名的木牌握在手里。阿岚从名册里认出父亲当年驾驶过的那艘船，也认出今天掌舵的是她从小一起长大的伙伴。",
    "她背起备用灯油，沿着被潮水打湿的长阶向灯塔走。第一段石阶旁，海风把围巾掀到肩后；第二段石阶旁，锈蚀的护栏发出低响；到第三段时，塔顶旧灯忽然熄灭，整片港湾只剩浪花撞礁的白线。",
    "阿岚推开灯室门，发现主灯芯被潮气浸透。备用火种只能维持很短时间，她必须先打开风门，再让反光镜重新对准航道。每一次转动绞盘，铜齿轮都会卡住半圈，她便用肩膀抵住把手，一寸一寸把镜面推回刻度。",
    "塔下的人点起零散手灯，微弱的光沿码头排成弯曲的线。阿岚透过雾看不清他们的脸，却听见孩子问母亲，船是不是忘了回家的路。她没有回答，只把最后一小瓶灯油倒进灯盏，让火焰从蓝色慢慢变成金黄。",
    "远海传来一声短促汽笛，随后又被风吞没。阿岚判断声音来自旧礁区，那里的浮标刚在暴雨后移位。她调整遮光板，让灯束避开假航道，再按三短一长的节奏转动镜面，这是港里约定的紧急归航信号。",
    "灯束第一次穿透海雾时，只照到翻涌的浪脊；第二次扫过时，雾中出现一截湿亮的船舷；第三次扫过，归航船终于显出完整轮廓。甲板上的人挥动红布，说明动力受损但船体仍安全。",
    "阿岚没有立刻放松。她保持信号节奏，直到船头越过最后一处暗礁。塔下的手灯开始向泊位移动，缆绳、担架和热水都被准备好。她听见港务钟被人重新上弦，迟到的整点声在雾里一圈圈传开。",
    "守候的人并不知道灯室里发生过什么，只看到那束光每隔数秒准时扫过海面。老人把孩子抱得更高，让他记住灯塔的位置；修船匠沿泊位逐个检查系缆柱；医务员把干毯铺在仓门里。每个人只完成自己手边很小的一件事，却共同把归航的最后一段路准备完整。",
    "船靠岸后，伙伴抬头看向灯塔，隔着很远举起手。阿岚站在灯室窗口，没有做夸张的回应，只把掌心贴在冰冷玻璃上。她知道今夜之后仍要更换灯芯、校准浮标、修好绞盘，但归航的人已经踩上了岸。",
    "交接班记录里，阿岚逐项写下风向、潮位、灯油余量和浮标偏移角度，没有把自己的害怕写进去。下一位守灯人会从这些数字继续工作，修理队也会据此安排清晨出航。对她而言，可靠的记录和可靠的灯光一样，都是把一次幸运变成下一次准备的方法。",
    "尾声。海雾在凌晨前慢慢退向外海，铜灯仍按稳定节奏旋转。码头留下被拖长的倒影，阿岚把值守记录写到最后一行：灯没有替任何人完成航行，它只是让每个仍在寻找方向的人，知道岸一直在这里。",
])
assert 1_000 <= len(SOURCE_MANUSCRIPT) <= 100_000


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


def node_binary(package: str) -> str:
    return subprocess.check_output(
        [
            "node",
            "-e",
            (
                f"const value=require({json.dumps(package)});"
                "console.log(value.path || value)"
            ),
        ],
        cwd=ROOT,
        text=True,
    ).strip()


def create_real_speech_wavs(directory: Path) -> dict[str, Any]:
    """Use an offline system voice, then pin six exact frame-aligned WAVs."""

    directory.mkdir(parents=True, exist_ok=True)
    ffmpeg = node_binary("ffmpeg-static")
    say = shutil.which("say")
    espeak = shutil.which("espeak") or shutil.which("espeak-ng")
    if not say and not espeak:
        raise RuntimeError("audio-first E2E requires local `say`, `espeak`, or `espeak-ng`")
    source = "macOS say/Tingting" if say else Path(espeak or "espeak").name
    for index, (text, frames) in enumerate(zip(LINE_TEXTS, SPEECH_FRAMES, strict=True), start=1):
        raw = directory / (f"raw-{index}.aiff" if say else f"raw-{index}.wav")
        if say:
            subprocess.run(
                [say, "-v", "Tingting", "-r", "220", "-o", str(raw), text],
                check=True,
                capture_output=True,
                text=True,
            )
        else:
            subprocess.run(
                [espeak or "espeak", "-v", "zh", "-s", "220", "-w", str(raw), text],
                check=True,
                capture_output=True,
                text=True,
            )
        duration = frames / FRAME_RATE
        output = directory / f"speech-{index}.wav"
        subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(raw),
                "-af",
                f"aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo,apad,atrim=0:{duration:.9f}",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "44100",
                "-ac",
                "2",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        with wave.open(str(output), "rb") as wav:
            assert wav.getframerate() == 44_100
            assert wav.getnchannels() == 2
            assert round(wav.getnframes() / wav.getframerate() * FRAME_RATE) == frames
        raw.unlink(missing_ok=True)
    return {
        "source": source,
        "durationFramesEach": SPEECH_FRAMES,
        "durationSecondsEach": [frames / FRAME_RATE for frames in SPEECH_FRAMES],
    }


def json_request(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request_headers = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
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


def project_scope(base_url: str) -> tuple[str, str]:
    projects = json_request(f"{base_url}/api/v1/projects")["projects"]
    assert len(projects) == 1, projects
    episode_id = projects[0].get("currentEpisodeId")
    assert isinstance(episode_id, str) and episode_id
    return projects[0]["id"], episode_id


def episode_snapshot(base_url: str, episode_id: str) -> dict[str, Any]:
    return json_request(f"{base_url}/api/v1/episodes/{quote(episode_id)}")["episode"]


def project_jobs(base_url: str) -> list[dict[str, Any]]:
    jobs = json_request(f"{base_url}/api/v1/jobs?limit=100")["jobs"]
    assert isinstance(jobs, list)
    return jobs


def visual_targets(base_url: str, project_id: str, episode_id: str) -> dict[str, Any]:
    return json_request(
        f"{base_url}/api/v1/episodes/{quote(episode_id)}/visual-asset-targets"
        f"?projectId={quote(project_id)}"
    )


def asset_snapshot(base_url: str, asset_id: str) -> dict[str, Any]:
    return json_request(f"{base_url}/api/v1/assets/{quote(asset_id)}")["asset"]


def expect_json_error(
    url: str,
    *,
    body: dict[str, Any],
    headers: dict[str, str],
    status: int,
    code: str,
) -> dict[str, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/json", **headers},
    )
    try:
        urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode("utf-8"))
        assert error.code == status, payload
        assert payload["error"]["code"] == code, payload
        return payload
    raise AssertionError(f"POST {url} unexpectedly succeeded")


def assert_visual_lock_set(
    base_url: str,
    project_id: str,
    episode_id: str,
    source_revision_id: str,
) -> dict[str, Any]:
    payload = visual_targets(base_url, project_id, episode_id)
    assert payload["sourceRevisionId"] == source_revision_id, payload
    by_type = {target["type"]: target for target in payload["targets"]}
    character = by_type["character"]
    location = by_type["location"]
    references = character["lockedReferences"]
    slots = {
        "front": references["frontAssetId"],
        "side": references["sideAssetId"],
        "back": references["backAssetId"],
    }
    all_ids = [character["lockedAssetId"], location["lockedAssetId"], *slots.values()]
    assert all(isinstance(asset_id, str) and asset_id for asset_id in all_ids), payload
    assert len(set(all_ids)) == len(all_ids), all_ids
    assets = {asset_id: asset_snapshot(base_url, asset_id) for asset_id in all_ids}
    for asset in assets.values():
        assert asset["projectId"] == project_id
        assert asset["episodeId"] == episode_id
        assert asset["sourceRevisionId"] == source_revision_id
        assert asset["status"] == "ready"
        assert asset["mimeType"].startswith("image/")
        assert re.fullmatch(r"[0-9a-f]{64}", asset["checksum"])
    for role, asset_id in slots.items():
        assert assets[asset_id]["kind"] == f"character-reference.{role}"
        assert assets[asset_id]["parentAssetId"] == character["lockedAssetId"]
    return {
        "sourceRevisionId": source_revision_id,
        "characterAssetId": character["lockedAssetId"],
        "locationAssetId": location["lockedAssetId"],
        "turnaround": slots,
        "targetVersions": {
            "character": character["version"],
            "location": location["version"],
        },
    }


def assert_current_storyboard_reference_jobs(
    base_url: str,
    source_revision_id: str,
    visual: dict[str, Any],
) -> dict[str, Any]:
    jobs = [
        job for job in project_jobs(base_url)
        if job["type"] == "asset.image.generate"
        and job["status"] == "succeeded"
        and job.get("input", {}).get("metadata", {}).get("kind") == "storyboard"
        and job.get("input", {}).get("storyboardBinding", {}).get("expectedRevisionId")
        == source_revision_id
    ]
    assert len(jobs) == SHOT_COUNT, jobs
    rows: list[dict[str, Any]] = []
    for job in sorted(jobs, key=lambda item: item["input"]["metadata"]["shotId"]):
        shot_id = job["input"]["metadata"]["shotId"]
        decision = job["input"]["storyboardReferenceDecision"]
        assert decision["version"] == 1
        assert decision["policy"] == "deterministic-character-view-location-v1"
        assert decision["source"] == "agentic_auto"
        assert decision["shotId"] == shot_id
        assert decision["sourceRevisionId"] == source_revision_id
        assert decision["locationPin"]["assetId"] == visual["locationAssetId"]
        assert decision["locationPin"]["assetSourceRevisionId"] == source_revision_id
        assert job["input"]["referenceAssetIds"] == decision["referenceAssetIds"]
        recommendation = decision["recommendation"]
        expected_view = EXPECTED_CHARACTER_VIEWS[shot_id]
        assert recommendation["status"] == "recommended", recommendation
        assert len(recommendation["characters"]) == 1
        character = recommendation["characters"][0]
        assert character["characterName"] == "阿岚"
        assert character["view"] == expected_view
        assert character["assetId"] == visual["turnaround"][expected_view]
        assert character["assetSourceRevisionId"] == source_revision_id
        assert isinstance(character["slotAuditRevisionId"], str)
        expected_ids = [visual["turnaround"][expected_view], visual["locationAssetId"]]
        assert decision["referenceAssetIds"] == expected_ids, decision
        assert job.get("output", {}).get("referenceAssetIds") == expected_ids
        rows.append({
            "jobId": job["id"],
            "shotId": shot_id,
            "view": expected_view,
            "referenceAssetIds": expected_ids,
            "decisionPolicy": decision["policy"],
        })
    return {"count": len(rows), "jobs": rows}


def timeline_snapshot(base_url: str, episode_id: str) -> dict[str, Any]:
    return json_request(
        f"{base_url}/api/v1/episodes/{quote(episode_id)}/timeline-document"
    )


def timeline_evidence(snapshot: dict[str, Any]) -> dict[str, Any]:
    document = snapshot["document"]
    tracks = document["tracks"]
    audio = [
        element
        for track in tracks["audio"]
        for element in track["elements"]
        if element.get("params", {}).get("dialogueLineId")
    ]
    cues = [
        element
        for track in tracks["overlay"]
        for element in track["elements"]
        if element.get("manju", {}).get("subtitleCue")
    ]
    visuals = sorted(
        [
            element
            for track in tracks["overlay"]
            for element in track["elements"]
            if element.get("type") in {"image", "video"}
            and element.get("params", {}).get("storyShotId")
        ],
        key=lambda element: element["startTime"],
    )
    assert len(visuals) == SHOT_COUNT, visuals
    assert len(audio) == SHOT_COUNT, audio
    assert len(cues) == SHOT_COUNT, cues
    audio_by_line = {element["params"]["dialogueLineId"]: element for element in audio}
    cue_rows: list[dict[str, Any]] = []
    for cue in cues:
        source = cue["manju"]["subtitleCue"]
        line_id = source["dialogueLineId"]
        audio_element = audio_by_line[line_id]
        assert source["speechAssetId"] == audio_element["mediaId"], (cue, audio_element)
        assert source["sourceAudioElementId"] == audio_element["id"], (cue, audio_element)
        assert source["sourceAudioStartTime"] == audio_element["startTime"], (cue, audio_element)
        assert source["sourceAudioDuration"] == audio_element["duration"], (cue, audio_element)
        assert cue["startTime"] == audio_element["startTime"], (cue, audio_element)
        assert cue["duration"] == audio_element["duration"], (cue, audio_element)
        cue_rows.append({
            "lineId": line_id,
            "speechAssetId": source["speechAssetId"],
            "text": cue["params"]["text"],
            "startTime": cue["startTime"],
            "duration": cue["duration"],
        })
    timing = document["manjuTimeline"]["audioDrivenTiming"]
    assert timing["version"] == 1
    assert timing["policy"] == "speech-assets-first-v1"
    assert timing["frameRate"] == FRAME_RATE
    assert re.fullmatch(r"[0-9a-f]{64}", timing["hash"])
    decisions = [shot["durationDecision"] for shot in timing["shots"]]
    assert len(decisions) == SHOT_COUNT
    assert [round(decision["timelineDurationSeconds"] * FRAME_RATE) for decision in decisions] == SPEECH_FRAMES
    for decision in decisions:
        assert decision["source"] == "speech_assets"
        assert len(decision["speechBindings"]) == 1
    return {
        "revisionId": snapshot["revision"]["id"],
        "etag": snapshot["etag"],
        "timingHash": timing["hash"],
        "durationFramesEach": [
            round(decision["timelineDurationSeconds"] * FRAME_RATE) for decision in decisions
        ],
        "visualStartFramesEach": [
            round(element["startTime"] / 120_000 * FRAME_RATE) for element in visuals
        ],
        "visualDurationFramesEach": [
            round(element["duration"] / 120_000 * FRAME_RATE) for element in visuals
        ],
        "speechAssetIds": [decision["speechBindings"][0]["assetId"] for decision in decisions],
        "cues": sorted(cue_rows, key=lambda row: row["startTime"]),
    }


def set_preview_time(page: Page, seconds: float) -> None:
    scrubber = page.get_by_label("预览播放头")
    maximum = float(scrubber.get_attribute("max") or "0")
    value = maximum * seconds / 30
    scrubber.evaluate(
        """(element, value) => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value'
          )?.set;
          if (!setter) throw new Error('native range setter unavailable');
          setter.call(element, String(value));
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        value,
    )
    page.wait_for_timeout(80)


def ffprobe_assertions(path: Path) -> dict[str, Any]:
    ffprobe = node_binary("@ffprobe-installer/ffprobe")
    payload = json.loads(subprocess.run(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout)
    video = next(stream for stream in payload["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in payload["streams"] if stream["codec_type"] == "audio")
    duration = float(payload["format"]["duration"])
    assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p", video
    assert (video["width"], video["height"]) == (1920, 1080), video
    assert audio["codec_name"] == "aac" and audio["sample_rate"] == "48000", audio
    assert audio["channels"] == 2, audio
    assert 29.8 <= duration <= 30.2, duration
    return {
        "durationSeconds": duration,
        "video": {
            "codec": video["codec_name"],
            "pixelFormat": video["pix_fmt"],
            "width": video["width"],
            "height": video["height"],
        },
        "audio": {"codec": audio["codec_name"], "sampleRate": audio["sample_rate"]},
    }


def select_visual_target(page: Page, target_type: str, target_id: str) -> None:
    tab_label = {"character": "角色", "location": "场景", "prop": "道具"}[target_type]
    page.locator(".assets-tabs button", has_text=tab_label).click()
    target = page.locator(
        f'[data-visual-target-type="{target_type}"][data-visual-target-id="{target_id}"]'
    )
    target.wait_for()
    target.click()


def generate_and_lock_visual_target(
    page: Page,
    *,
    target_type: str,
    target_id: str,
    target_name: str,
    derive_turnaround: bool = False,
) -> None:
    select_visual_target(page, target_type, target_id)
    panel = page.locator(".visual-candidate-panel")
    # Historical immutable versions stay visible for audit. Only a candidate
    # from the active Story revision may be generated, referenced or split.
    current_cards = panel.locator(".visual-candidate-card:not(.historical)")
    assert current_cards.count() == 0
    toolbar_generate = page.locator(".asset-toolbar-actions").get_by_role(
        "button", name=re.compile("生成候选|生成当前修订候选|再生成一版")
    )
    toolbar_generate.click()
    SUPPORT.confirm_paid_browser_tasks(
        page,
        count=1,
        endpoint_fragment="/api/v1/assets/image-generations",
    )
    card = current_cards.first
    card.wait_for(timeout=120_000)
    card.get_by_role("button", name="设为本集引用", exact=True).click()
    card.get_by_role("button", name="本集已引用", exact=True).wait_for(timeout=60_000)

    if not derive_turnaround:
        return
    card.get_by_role("button", name="拆分三视图", exact=True).click()
    dialog = page.get_by_role("dialog", name="分割角色正面、侧面与背面参考图")
    dialog.wait_for()
    confirm = dialog.get_by_label("我已逐张确认正面、侧面、背面标签与框选")
    confirm.wait_for(state="visible")
    confirm.click()
    dialog.get_by_role("button", name="创建三张持久参考图", exact=True).click()
    dialog.wait_for(state="detached", timeout=60_000)
    views = panel.get_by_label("已持久化三视图裁切")
    views.wait_for(timeout=120_000)
    assert views.get_by_role("button").count() == 3
    card = current_cards.first
    with page.expect_response(lambda response: response.url.endswith(
        "/api/v1/character-visual-references/lock"
    )) as pending_lock:
        card.get_by_role("button", name="绑定三视图", exact=True).click()
    lock_response = pending_lock.value
    assert lock_response.ok, (
        f"character turnaround lock failed: {lock_response.status} "
        f"{lock_response.text()}"
    )
    locked_views = panel.get_by_label("已绑定的角色三视图")
    locked_views.wait_for(timeout=60_000)
    assert locked_views.get_by_role("button").count() == 3
    assert panel.get_by_text(f"{target_name}", exact=True).count() >= 1


def run_browser(base_url: str, report: dict[str, Any]) -> None:
    external_requests: list[str] = []
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_responses: list[str] = []

    with sync_playwright() as playwright:
        executable = SUPPORT.system_chromium_executable()
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
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on(
            "response",
            lambda response: failed_responses.append(f"{response.status} {response.url}")
            if response.status >= 400 else None,
        )
        page.set_default_timeout(60_000)
        try:
            page.goto(base_url, wait_until="domcontentloaded")
            # Catalog and per-episode production are separate first-level
            # workspaces. Enter production explicitly instead of relying on
            # the legacy pre-Catalog default route.
            page.get_by_role("button", name="分集制作", exact=True).click()
            page.get_by_role("heading", name="故事原文").wait_for()
            page.locator(".save-state", has_text="已保存").wait_for()
            source_editor = page.locator(".source-editor textarea")
            assert source_editor.input_value() == ""
            source_editor.fill(SOURCE_MANUSCRIPT)
            page.locator(".segmented-control button", has_text="30").click()
            page.get_by_role("button", name="生成结构剧本", exact=True).click()
            page.get_by_role("heading", name="角色与场景准备", exact=True, level=1).wait_for()
            project_id, episode_id = project_scope(base_url)
            initial_episode = episode_snapshot(base_url, episode_id)
            initial_revision_id = initial_episode["sourceRevisionId"]
            assert initial_episode["sourceText"] == SOURCE_MANUSCRIPT
            assert initial_episode["targetDurationSeconds"] == 30
            story_payload = json_request(
                f"{base_url}/api/v1/episodes/{quote(episode_id)}/story?projectId={quote(project_id)}"
            )
            assert story_payload["revisionId"] == initial_revision_id
            assert sum(len(scene["shots"]) for scene in story_payload["story"]["scenes"]) == SHOT_COUNT
            assert [
                line["text"]
                for scene in story_payload["story"]["scenes"]
                for shot in scene["shots"]
                for line in shot["dialogueLines"]
            ] == INITIAL_LINE_TEXTS

            # Stage 2: real persistent image Jobs, manual primary locks, and a
            # local human-confirmed front/side/back derivation. These first
            # locks intentionally belong to the pre-edit Story revision.
            generate_and_lock_visual_target(
                page,
                target_type="character",
                target_id="keeper",
                target_name="阿岚",
                derive_turnaround=True,
            )
            generate_and_lock_visual_target(
                page,
                target_type="location",
                target_id="harbor",
                target_name="海雾古港",
            )
            initial_visual = assert_visual_lock_set(
                base_url, project_id, episode_id, initial_revision_id
            )
            initial_visual_jobs = [
                job for job in project_jobs(base_url)
                if job["type"] in {"asset.image.generate", "asset.image.turnaround.derive"}
                and (
                    job.get("input", {}).get("assetEntityBinding", {}).get("expectedRevisionId")
                    == initial_revision_id
                    or job.get("input", {}).get("sourceRevisionId") == initial_revision_id
                )
            ]
            assert len([job for job in initial_visual_jobs if job["type"] == "asset.image.generate"]) == 2
            assert len([job for job in initial_visual_jobs if job["type"] == "asset.image.turnaround.derive"]) == 1
            assert all(job["status"] == "succeeded" for job in initial_visual_jobs)

            # Stage 3 script review uses stable data-script-* controls. One
            # shot-language edit and one dialogue edit each create an
            # immutable Story revision before any speech is generated.
            page.locator(".pipeline-step", has_text="拆剧本与配音").click()
            page.get_by_role("heading", name="第 1 集 · 结构剧本").wait_for()
            stats = page.locator(".script-stage .stage-toolbar .score-row")
            stats.get_by_text("6 镜", exact=True).wait_for()
            first_shot = page.locator('[data-script-shot-id="shot-1"]')
            first_shot.locator('[data-script-shot-action="edit"]').click()
            first_shot.get_by_label("镜头 01A 运镜", exact=True).fill(FINAL_SHOT_MOVEMENT)
            first_shot.locator('[data-script-shot-action="save"]').click()
            movement_revision_id = wait_for(
                "shot edit Story revision",
                lambda: episode_snapshot(base_url, episode_id)["sourceRevisionId"],
                lambda revision: revision != initial_revision_id,
            )
            first_shot.locator(".script-shot-heading", has_text=FINAL_SHOT_MOVEMENT).wait_for()

            second_line = page.locator('[data-script-dialogue-line-id="line-2"]')
            second_line.locator('[data-script-dialogue-action="edit"]').click()
            second_line.locator("input").fill(LINE_TEXTS[1])
            second_line.locator('[data-script-dialogue-action="save"]').click()
            final_revision_id = wait_for(
                "dialogue edit Story revision",
                lambda: episode_snapshot(base_url, episode_id)["sourceRevisionId"],
                lambda revision: revision not in {initial_revision_id, movement_revision_id},
            )
            second_line.get_by_text(LINE_TEXTS[1], exact=True).wait_for()
            assert episode_snapshot(base_url, episode_id)["sourceText"] == SOURCE_MANUSCRIPT

            # A paid-boundary admission using the old location/turnaround locks
            # must fail before a Job or Provider request exists.
            calls_before_stale_gate = json_request(f"{base_url}/__e2e__/evidence")
            jobs_before_stale_gate = len(project_jobs(base_url))
            stale_error = expect_json_error(
                f"{base_url}/api/v1/assets/image-generations",
                body={
                    "projectId": project_id,
                    "episodeId": episode_id,
                    "input": {
                        "prompt": "验证旧修订参考图不能进入当前分镜任务。",
                        "size": "1536x1024",
                        "quality": "medium",
                        "count": 1,
                        "metadata": {
                            "kind": "storyboard",
                            "shotId": "shot-1",
                            "sceneId": "scene-1",
                            "shotCode": "01A",
                            "useLockedReferences": True,
                        },
                    },
                },
                headers={"Idempotency-Key": "audio-first-stale-reference-gate"},
                status=409,
                code="STORYBOARD_REFERENCE_MANUAL_REQUIRED",
            )
            calls_after_stale_gate = json_request(f"{base_url}/__e2e__/evidence")
            assert len(project_jobs(base_url)) == jobs_before_stale_gate
            assert calls_after_stale_gate["providerCalls"] == calls_before_stale_gate["providerCalls"]

            # Re-enter stage 2 and explicitly approve current-revision assets.
            # Old candidates remain durable and visible for audit, but are
            # marked historical and cannot be silently rebound.
            page.locator(".pipeline-step", has_text="角色与场景").click()
            page.get_by_role("heading", name="角色与场景准备", exact=True, level=1).wait_for()
            generate_and_lock_visual_target(
                page,
                target_type="character",
                target_id="keeper",
                target_name="阿岚",
                derive_turnaround=True,
            )
            generate_and_lock_visual_target(
                page,
                target_type="location",
                target_id="harbor",
                target_name="海雾古港",
            )
            current_visual = assert_visual_lock_set(
                base_url, project_id, episode_id, final_revision_id
            )
            assert set(current_visual["turnaround"].values()).isdisjoint(
                initial_visual["turnaround"].values()
            )
            assert current_visual["locationAssetId"] != initial_visual["locationAssetId"]

            # Bind verified account-catalog voices only after the final Story
            # revision and current visual reapproval are authoritative.
            narrator = page.get_by_role("region", name="项目旁白声线")
            narrator.get_by_role("option", name=re.compile("离线旁白声线")).click()
            narrator.get_by_role("button", name="设为项目旁白", exact=True).click()
            narrator.get_by_text("当前项目旁白", exact=True).wait_for()
            select_visual_target(page, "character", "keeper")
            character = page.get_by_role("region", name="阿岚角色声线")
            character.get_by_role("option", name=re.compile("离线角色声线")).click()
            character.get_by_role("button", name="设为角色声线", exact=True).click()
            character.get_by_text("当前角色声线", exact=True).wait_for()

            # Stage 3: submit six unequal real local-system-TTS WAV Jobs.
            page.locator(".pipeline-step", has_text="拆剧本与配音").click()
            page.get_by_role("heading", name="第 1 集 · 结构剧本").wait_for()
            page.get_by_role("button", name="继续生成与确认语音", exact=True).click()
            page.get_by_role("heading", name="语音生成与确认").wait_for()
            # Audio review needs the vertical space more than the timeline.
            # Exercise the retained collapse control rather than allowing the
            # bottom panel to obscure later dialogue rows in this viewport.
            page.get_by_role("button", name="收起时间线", exact=True).click()
            page.get_by_role("button", name="展开时间线", exact=True).wait_for()
            line_buttons = page.locator(".dialogue-production-list > div > button")
            assert line_buttons.count() == SHOT_COUNT
            for index in range(SHOT_COUNT):
                line_button = line_buttons.nth(index)
                line_button.click()
                page.locator(".real-voice-panel").get_by_role(
                    "button", name="生成当前台词", exact=True
                ).click()
                SUPPORT.confirm_paid_browser_tasks(
                    page,
                    count=1,
                    endpoint_fragment="/speech-generations",
                )
                line_button.locator(".speech-status", has_text="已生成").wait_for(timeout=120_000)
            page.locator(".dialogue-production-list header", has_text="6/6 已生成").wait_for()
            page.get_by_text("时间线可写", exact=True).wait_for(timeout=120_000)
            assert episode_snapshot(base_url, episode_id)["sourceRevisionId"] == final_revision_id

            # Stage 4 only starts after speech. Generate all real PNG storyboards.
            page.get_by_role("button", name="进入分镜与逐镜视频", exact=True).click()
            assert page.locator(".shot-card").count() == SHOT_COUNT
            page.locator("button.generate-all", has_text="补齐缺失").click()
            SUPPORT.confirm_paid_browser_tasks(
                page,
                count=SHOT_COUNT,
                endpoint_fragment="/api/v1/assets/image-generations",
            )
            page.locator("button.generate-all", has_text="分镜已齐").wait_for(timeout=120_000)
            page.locator(".timeline-storage.ready", has_text="SQLite 修订已保存").wait_for(timeout=120_000)
            storyboard_reference_evidence = assert_current_storyboard_reference_jobs(
                base_url,
                final_revision_id,
                current_visual,
            )

            # The visible free Seedance preflight must expose the exact measured durations.
            page.get_by_role("button", name=re.compile(r"^打开批量工作台 · 6 镜待生成$")).click()
            dialog = page.get_by_role("dialog", name="逐镜视频批量生成")
            # The workbench intentionally opens on the currently focused shot;
            # make the six-shot production scope explicit before the free gate.
            dialog.get_by_role("button", name="全选可生成镜头", exact=True).click()
            dialog.get_by_text("6 / 6 镜", exact=True).wait_for()
            with page.expect_response(
                lambda response: response.request.method == "POST"
                and response.url.endswith("/video-generations/preflight"),
                timeout=60_000,
            ) as response_info:
                dialog.get_by_role("button", name="第一步：快速权威预检", exact=True).click()
            preflight_response = response_info.value
            preflight_payload = preflight_response.json()
            assert preflight_response.ok, preflight_payload
            preflight = preflight_payload["preflight"]
            dialog.get_by_text("服务端权威预检已完成", exact=True).wait_for()
            actual_frames = [
                round(target["durationDecision"]["timelineDurationSeconds"] * FRAME_RATE)
                for target in preflight["targets"]
            ]
            assert actual_frames == SPEECH_FRAMES, preflight
            assert [target["durationSeconds"] for target in preflight["targets"]] == [4, 5, 5, 6, 6, 6]
            assert all(
                target["durationDecision"]["source"] == "speech_assets"
                and len(target["durationDecision"]["speechBindings"]) == 1
                for target in preflight["targets"]
            )
            assert dialog.get_by_role("button", name="确认 6 个计费任务并开始", exact=True).is_enabled()
            dialog.get_by_role("button", name="关闭 Seedance 批量生成", exact=True).click()
            dialog.wait_for(state="detached")

            before_repair = timeline_snapshot(base_url, episode_id)
            before_evidence = timeline_evidence(before_repair)
            assert before_evidence["durationFramesEach"] == SPEECH_FRAMES
            assert [cue["text"] for cue in before_evidence["cues"]] == LINE_TEXTS
            assert before_evidence["speechAssetIds"] == [
                target["durationDecision"]["speechBindings"][0]["assetId"]
                for target in preflight["targets"]
            ]

            # Normal reconcile intentionally preserves the original Story
            # edit points (six five-second shots). The unequal measured WAVs
            # therefore create a natural, provider-derived timing mismatch;
            # no synthetic user edit is needed. Agentic may safely conform
            # this untouched Story layout to the audio timing authority.
            assert before_evidence["visualStartFramesEach"] == [0, 120, 240, 360, 480, 600]
            assert before_evidence["visualDurationFramesEach"] == [120] * SHOT_COUNT
            pre_auto_edit_revision = before_evidence["revisionId"]
            page.get_by_role("button", name="展开时间线", exact=True).click()
            page.get_by_role("button", name="收起时间线", exact=True).wait_for()
            page.get_by_role("button", name="Agentic 自动剪辑预览", exact=True).click()
            auto_region = page.get_by_role("region", name="Agentic 自动剪辑预览")
            auto_region.wait_for(timeout=60_000)
            auto_headline = auto_region.locator("strong").first.inner_text()
            auto_diagnostics = auto_region.locator(".timeline-auto-edit-diagnostics span").all_inner_texts()
            assert auto_headline == "自动剪辑预览 · 尚未保存", (
                auto_headline,
                auto_diagnostics,
            )
            apply_button = auto_region.get_by_role("button", name="应用为新修订", exact=True)
            assert apply_button.is_enabled()
            apply_button.click()
            page.get_by_text("Agentic 自动剪辑修订", exact=True).wait_for(timeout=60_000)
            page.locator(".timeline-storage.ready", has_text="SQLite 修订已保存").wait_for(timeout=60_000)
            after_repair = timeline_snapshot(base_url, episode_id)
            after_evidence = timeline_evidence(after_repair)
            assert after_evidence["revisionId"] != pre_auto_edit_revision
            assert after_evidence["timingHash"] == before_evidence["timingHash"]
            expected_starts: list[int] = []
            cursor_frames = 0
            for duration_frames in SPEECH_FRAMES:
                expected_starts.append(cursor_frames)
                cursor_frames += duration_frames
            assert after_evidence["visualStartFramesEach"] == expected_starts
            assert after_evidence["visualDurationFramesEach"] == SPEECH_FRAMES

            # Browser preview must show each automatically managed same-source cue.
            page.get_by_role("button", name="预览", exact=True).click()
            preview = page.get_by_role("dialog", name="预览「第 1 集」")
            preview.get_by_text("真实时间线", exact=True).wait_for(timeout=60_000)
            cursor = 0.0
            observed_subtitles: list[str] = []
            for text, frames in zip(LINE_TEXTS, SPEECH_FRAMES, strict=True):
                set_preview_time(page, cursor + min(0.5, frames / FRAME_RATE / 2))
                visible = preview.locator(".opencut-preview-subtitles span").all_inner_texts()
                assert text in visible, (text, visible)
                observed_subtitles.append(text)
                cursor += frames / FRAME_RATE
            page.get_by_role("button", name="关闭预览", exact=True).click()

            # Stage 5 formal render and release gate.
            page.get_by_role("button", name="进入剪辑与成片", exact=True).click()
            page.locator(".export-actions button", has_text="导出 MP4").click()
            page.get_by_role("dialog", name="导出「第 1 集」").wait_for()
            page.get_by_role("button", name="1080P", exact=True).click()
            assert page.get_by_label("烧录整句字幕").is_checked()
            page.get_by_text("镜头运动来自 OpenCut 时间线", exact=True).wait_for()
            assert page.get_by_label("启用轻微推拉动效").count() == 0
            for option in ["片头标题落版", "片尾结束落版"]:
                control = page.get_by_label(option)
                if control.is_checked():
                    control.uncheck()
            page.get_by_role("button", name="创建 FFmpeg 导出任务", exact=True).click()
            page.get_by_text("真实成片已就绪", exact=True).wait_for(timeout=360_000)
            page.get_by_role("button", name="运行质检", exact=True).click()
            page.get_by_text("真实质检通过", exact=True).wait_for(timeout=360_000)
            assert page.locator(".real-qc-list > div").count() == 7
            release_review = page.get_by_role("region", name="人工发行复验")
            page.get_by_role("link", name="下载审片版", exact=True).wait_for()
            assert page.get_by_role("link", name="下载发布版", exact=True).count() == 0
            for option in ["音画匹配", "字幕同步且完整", "角色与画面语义一致"]:
                release_review.locator(".release-review-checklist label", has_text=option).locator("input").check()
            release_review.get_by_label(
                "我已在网页或系统播放器中完整审看当前成片",
                exact=True,
            ).check()
            approve_release = release_review.get_by_role("button", name="批准发行", exact=True)
            assert approve_release.is_enabled()
            approve_release.click()
            release_review.get_by_text("人工发行复验已批准", exact=True).wait_for(timeout=60_000)
            download_link = page.get_by_role("link", name="下载发布版", exact=True)
            download_link.wait_for(timeout=60_000)
            with page.expect_download(timeout=60_000) as download_info:
                download_link.click()
            download_info.value.save_as(str(VIDEO_PATH))
            assert VIDEO_PATH.exists() and VIDEO_PATH.stat().st_size > 1024

            # A full page refresh must recover the exact authoritative Story,
            # visual locks, timeline head, formal export, and seven-check QC.
            persisted_timeline_revision_id = after_evidence["revisionId"]
            page.reload(wait_until="domcontentloaded")
            page.get_by_role("button", name="分集制作", exact=True).click()
            page.locator(".save-state", has_text="已保存").wait_for()
            page.locator(".pipeline-step", has_text="剪辑与成片").click()
            page.get_by_text("真实成片已就绪", exact=True).wait_for(timeout=120_000)
            page.get_by_text("真实质检通过", exact=True).wait_for(timeout=120_000)
            page.get_by_text("人工发行复验已批准", exact=True).wait_for(timeout=120_000)
            assert page.locator(".real-qc-list > div").count() == 7
            assert page.get_by_role("link", name="下载发布版", exact=True).count() == 1
            assert timeline_snapshot(base_url, episode_id)["revision"]["id"] == persisted_timeline_revision_id
            assert episode_snapshot(base_url, episode_id)["sourceRevisionId"] == final_revision_id
            refreshed_visual = assert_visual_lock_set(
                base_url, project_id, episode_id, final_revision_id
            )
            assert refreshed_visual["turnaround"] == current_visual["turnaround"]
            assert refreshed_visual["locationAssetId"] == current_visual["locationAssetId"]

            report.update({
                "projectId": project_id,
                "episodeId": episode_id,
                "stage1": {
                    "sourceCharacters": len(SOURCE_MANUSCRIPT),
                    "sourceSha256": hashlib.sha256(SOURCE_MANUSCRIPT.encode("utf-8")).hexdigest(),
                    "sourcePersistedExactly": True,
                    "storyShots": SHOT_COUNT,
                    "initialSourceRevisionId": initial_revision_id,
                },
                "stage2": {
                    "initialRevisionLocks": initial_visual,
                    "currentRevisionLocks": current_visual,
                    "initialPersistentVisualJobs": [job["id"] for job in initial_visual_jobs],
                    "manualPrimaryLocks": 4,
                    "humanConfirmedTurnaroundDerivations": 2,
                    "immutableSlotsVerified": ["front", "side", "back"],
                },
                "stage3": {
                    "movementRevisionId": movement_revision_id,
                    "finalSourceRevisionId": final_revision_id,
                    "editedShotMovement": FINAL_SHOT_MOVEMENT,
                    "editedDialogue": LINE_TEXTS[1],
                    "staleReferenceAdmission": {
                        "status": 409,
                        "code": stale_error["error"]["code"],
                        "jobCreated": False,
                        "providerCallCreated": False,
                    },
                    "speechAssets": SHOT_COUNT,
                    "durationFramesEach": SPEECH_FRAMES,
                },
                "stage4": {
                    "storyboardImages": SHOT_COUNT,
                    "storyboardReferenceEvidence": storyboard_reference_evidence,
                    "videoProviderCalls": 0,
                },
                "preflight": {
                    "sourceRevisionId": preflight["sourceRevisionId"],
                    "billableTaskCount": preflight["billableTaskCount"],
                    "durationFramesEach": actual_frames,
                    "providerDurationSecondsEach": [
                        target["durationSeconds"] for target in preflight["targets"]
                    ],
                },
                "timeline": {
                    "beforeRepair": before_evidence,
                    "preAutoEditRevisionId": pre_auto_edit_revision,
                    "afterRepair": after_evidence,
                    "managedSubtitleCount": len(observed_subtitles),
                    "agenticRepairApplied": True,
                },
                "stage5": {
                    "formalResolution": "1080p",
                    "burnedSubtitles": True,
                    "qualityChecks": 7,
                    "downloaded": True,
                    "pageRefreshRecoveredExactState": True,
                    "timelineRevisionId": persisted_timeline_revision_id,
                },
            })
        finally:
            context.close()
            browser.close()

    allowed_404s = [
        response for response in failed_responses
        if response.startswith("404 ")
        and ("/story?projectId=" in response or response.endswith("/timeline-document"))
    ]
    allowed_paid_preflights = SUPPORT.expected_paid_preflight_responses(
        failed_responses,
        {
            "/api/v1/assets/image-generations": 10,
            "/speech-generations": SHOT_COUNT,
        },
    )
    unexpected_responses = [
        response
        for response in failed_responses
        if response not in allowed_404s and response not in allowed_paid_preflights
    ]
    generic_404 = "Failed to load resource: the server responded with a status of 404 (Not Found)"
    remaining_404s = len(allowed_404s)
    remaining_paid_console = len(allowed_paid_preflights)
    unexpected_console: list[str] = []
    for message in console_errors:
        if message == generic_404 and remaining_404s > 0:
            remaining_404s -= 1
        elif "Failed to load resource" in message and "409" in message and remaining_paid_console > 0:
            remaining_paid_console -= 1
        else:
            unexpected_console.append(message)
    assert not external_requests, external_requests
    assert not page_errors, page_errors
    assert not unexpected_responses, unexpected_responses
    assert not unexpected_console, unexpected_console


def verify_hard_restart_browser(base_url: str, report: dict[str, Any]) -> None:
    external_requests: list[str] = []
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_responses: list[str] = []
    with sync_playwright() as playwright:
        executable = SUPPORT.system_chromium_executable()
        browser = playwright.chromium.launch(
            headless=True,
            **({"executable_path": executable} if executable else {}),
        )
        context = browser.new_context(viewport={"width": 1440, "height": 1000})

        def route_request(route, request) -> None:
            parsed = urlparse(request.url)
            if parsed.scheme in {"http", "https"} and parsed.hostname not in {
                "127.0.0.1", "localhost"
            }:
                external_requests.append(request.url)
                route.abort("blockedbyclient")
            else:
                route.continue_()

        context.route("**/*", route_request)
        page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text) if message.type == "error" else None,
        )
        page.on(
            "response",
            lambda response: failed_responses.append(f"{response.status} {response.url}")
            if response.status >= 400 else None,
        )
        page.set_default_timeout(120_000)
        try:
            page.goto(base_url, wait_until="domcontentloaded")
            page.get_by_role("button", name="分集制作", exact=True).click()
            page.locator(".save-state", has_text="已保存").wait_for()
            page.locator(".pipeline-step", has_text="剪辑与成片").click()
            page.get_by_text("真实成片已就绪", exact=True).wait_for()
            page.get_by_text("真实质检通过", exact=True).wait_for()
            page.get_by_text("人工发行复验已批准", exact=True).wait_for()
            assert page.locator(".real-qc-list > div").count() == 7
            assert page.get_by_role("link", name="下载发布版", exact=True).count() == 1
            assert timeline_snapshot(base_url, report["episodeId"])["revision"]["id"] \
                == report["stage5"]["timelineRevisionId"]
            assert episode_snapshot(base_url, report["episodeId"])["sourceRevisionId"] \
                == report["stage3"]["finalSourceRevisionId"]
            recovered_visual = assert_visual_lock_set(
                base_url,
                report["projectId"],
                report["episodeId"],
                report["stage3"]["finalSourceRevisionId"],
            )
            assert recovered_visual["turnaround"] \
                == report["stage2"]["currentRevisionLocks"]["turnaround"]
            assert recovered_visual["locationAssetId"] \
                == report["stage2"]["currentRevisionLocks"]["locationAssetId"]
            assert len(project_jobs(base_url)) == report["persistence"]["jobCount"]
            page.screenshot(path=str(SCREENSHOT_PATH), full_page=True)
        finally:
            context.close()
            browser.close()
    assert not external_requests, external_requests
    assert not page_errors, page_errors
    assert not failed_responses, failed_responses
    assert not console_errors, console_errors


def main() -> int:
    if not (ROOT / "dist" / "index.html").exists():
        raise SystemExit("dist/index.html is missing; run npm run build first")
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    for path in [VIDEO_PATH, SCREENSHOT_PATH, REPORT_PATH]:
        path.unlink(missing_ok=True)
    started = time.monotonic()
    report: dict[str, Any] = {"ok": False}
    process: subprocess.Popen[str] | None = None
    server_outputs: list[list[str]] = []
    with tempfile.TemporaryDirectory(prefix="manju-audio-first-e2e-") as temporary:
        temporary_path = Path(temporary)
        runtime_dir = temporary_path / "runtime"
        speech_dir = temporary_path / "speech"
        speech = create_real_speech_wavs(speech_dir)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            selected_port = reservation.getsockname()[1]
        server_env = {
            "MANJU_E2E_AUDIO_FIRST": "1",
            "MANJU_E2E_AUDIO_FIRST_SPEECH_DIR": str(speech_dir),
        }
        process, base_url, server_output = SUPPORT.start_server(
            runtime_dir,
            selected_port,
            server_env,
        )
        server_outputs.append(server_output)
        try:
            run_browser(base_url, report)
            evidence_before_restart = json_request(f"{base_url}/__e2e__/evidence")
            assert evidence_before_restart["providerCalls"] == {
                "text": 1,
                "image": 4 + SHOT_COUNT,
                "speech": SHOT_COUNT,
                "video": 0,
            }, evidence_before_restart
            assert evidence_before_restart["imageReferenceCounts"][:4] == [0, 0, 0, 0]
            assert evidence_before_restart["imageReferenceCounts"][4:] == [2] * SHOT_COUNT
            assert evidence_before_restart["unexpectedNetworkRequests"] == 0
            assert evidence_before_restart["audioFirstAcceptance"] is True
            assert evidence_before_restart["localVoiceCatalogRequests"] >= 1
            report["persistence"] = {"jobCount": len(project_jobs(base_url))}

            # Simulate an abrupt service loss rather than a graceful shutdown,
            # then bind the same TCP address and recover solely from SQLite and
            # the controlled media directory.
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=15)
            assert process.returncode == -signal.SIGKILL
            process, restarted_url, restarted_output = SUPPORT.start_server(
                runtime_dir,
                selected_port,
                server_env,
            )
            server_outputs.append(restarted_output)
            assert restarted_url == base_url
            verify_hard_restart_browser(base_url, report)
            evidence_after_restart = json_request(f"{base_url}/__e2e__/evidence")
            assert evidence_after_restart["providerCalls"] == {
                "text": 0,
                "image": 0,
                "speech": 0,
                "video": 0,
            }, evidence_after_restart
            assert evidence_after_restart["imageReferenceCounts"] == []
            assert evidence_after_restart["unexpectedNetworkRequests"] == 0
            media = ffprobe_assertions(VIDEO_PATH)
            report.update({
                "ok": True,
                "elapsedSeconds": round(time.monotonic() - started, 3),
                "speechFixture": speech,
                "providerEvidence": {
                    "billableExternalProviderCalls": 0,
                    "beforeHardRestart": evidence_before_restart,
                    "afterHardRestart": evidence_after_restart,
                },
                "media": media,
                "artifacts": {
                    "video": str(VIDEO_PATH.relative_to(ROOT)),
                    "screenshot": str(SCREENSHOT_PATH.relative_to(ROOT)),
                },
            })
            report["stage5"]["hardServiceRestartRecoveredExactState"] = True
        finally:
            if process is not None:
                SUPPORT.stop_server(process)
        if process is not None and process.returncode not in {
            0,
            -signal.SIGTERM,
            128 + signal.SIGTERM,
        }:
            raise RuntimeError(
                f"offline audio-first server exited with {process.returncode}:\n"
                + "\n".join(line for output in server_outputs for line in output)
            )
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "report": str(REPORT_PATH.relative_to(ROOT)),
        "video": str(VIDEO_PATH.relative_to(ROOT)),
        "elapsedSeconds": report["elapsedSeconds"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
