from __future__ import annotations

import asyncio
import json
import wave
from pathlib import Path

import app as sidecar


def write_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(22050)
        output.writeframes(b"\x00\x00" * 220)


def configure_voice_catalog(monkeypatch, tmp_path: Path) -> sidecar.ResolvedVoice:
    voice_dir = tmp_path / "voices"
    voice_dir.mkdir()
    reference = voice_dir / "ali.wav"
    write_wav(reference)
    manifest = voice_dir / "voices.json"
    manifest.write_text(
        json.dumps(
            {
                "voices": [
                    {
                        "voice_id": "ali-main",
                        "name": "Ali",
                        "description": "calm",
                        "reference_audio": "ali.wav",
                        "tags": ["female"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sidecar, "VOICE_DIR", voice_dir)
    monkeypatch.setattr(sidecar, "VOICE_MANIFEST", manifest)
    return sidecar.load_voices()[0]


def test_load_voices_rejects_paths_outside_voice_dir(monkeypatch, tmp_path: Path) -> None:
    voice_dir = tmp_path / "voices"
    voice_dir.mkdir()
    outside = tmp_path / "outside.wav"
    write_wav(outside)
    manifest = voice_dir / "voices.json"
    manifest.write_text(
        json.dumps(
            {
                "voices": [
                    {
                        "voice_id": "bad",
                        "name": "Bad",
                        "reference_audio": "../outside.wav",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(sidecar, "VOICE_DIR", voice_dir)
    monkeypatch.setattr(sidecar, "VOICE_MANIFEST", manifest)

    try:
        sidecar.load_voices()
    except sidecar.HTTPException as error:
        assert error.status_code == 500
        assert "missing reference audio" in error.detail
    else:
        raise AssertionError("path traversal should be rejected")


def test_mlx_synthesis_precomputes_and_reuses_speaker_cache(
    monkeypatch, tmp_path: Path
) -> None:
    voice = configure_voice_catalog(monkeypatch, tmp_path)
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "config.yaml").write_text("model: test", encoding="utf-8")

    class FakeMlxModel:
        save_calls = 0
        generate_options: dict[str, object] | None = None

        def save_speaker(self, _audio: str, output: str) -> None:
            self.save_calls += 1
            Path(output).write_bytes(b"fake-npz")

        def generate(self, **kwargs) -> None:
            self.generate_options = kwargs
            write_wav(Path(kwargs["output_path"]))

    fake = FakeMlxModel()
    runtime = sidecar.IndexTTSRuntime()
    runtime._model = fake
    monkeypatch.setattr(sidecar, "BACKEND", "mlx")
    monkeypatch.setattr(sidecar, "MODEL_DIR", model_dir)
    monkeypatch.setattr(sidecar, "SPEAKER_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(sidecar, "AUTO_PRECOMPUTE_SPEAKERS", True)
    request = sidecar.SpeechRequest(
        model="IndexTTS-2",
        input="Hello",
        voice="ali-main",
        response_format="wav",
        speed=0.9,
        emotion="happy",
    )

    first = asyncio.run(runtime.synthesize(request, voice))
    second = asyncio.run(runtime.synthesize(request, voice))

    assert first.startswith(b"RIFF")
    assert second.startswith(b"RIFF")
    assert fake.save_calls == 1
    assert fake.generate_options is not None
    assert "speed" not in fake.generate_options
    assert len(list((tmp_path / "cache").glob("ali-main-*.npz"))) == 1


def test_health_exposes_mlx_backend_without_loading_model(monkeypatch, tmp_path: Path) -> None:
    configure_voice_catalog(monkeypatch, tmp_path)
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    for name in sidecar.MODEL_REQUIRED_FILES["mlx"]:
        (model_dir / name).write_bytes(b"x")
    monkeypatch.setattr(sidecar, "MODEL_DIR", model_dir)
    monkeypatch.setattr(sidecar, "BACKEND", "mlx")

    result = sidecar.health()

    assert result["status"] == "ready"
    assert result["backend"] == "mlx"
    assert result["missing_model_files"] == []
