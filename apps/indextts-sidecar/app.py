from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator


MODEL_NAME = os.getenv("INDEXTTS_MODEL_NAME", "IndexTTS-2")
BACKEND = os.getenv("INDEXTTS_BACKEND", "mlx").strip().lower()
MODEL_DIR = Path(os.getenv("INDEXTTS_MODEL_DIR", "./models/mlx-indextts2-standard-8bit")).resolve()
VOICE_DIR = Path(os.getenv("INDEXTTS_VOICE_DIR", "./voices")).resolve()
VOICE_MANIFEST = Path(
    os.getenv("INDEXTTS_VOICE_MANIFEST", str(VOICE_DIR / "voices.json"))
).resolve()
API_TOKEN = os.getenv("INDEXTTS_API_TOKEN", "").strip()
FFMPEG = os.getenv("INDEXTTS_FFMPEG", "ffmpeg")
MAX_TEXT_CHARACTERS = int(os.getenv("INDEXTTS_MAX_TEXT_CHARACTERS", "4096"))
SPEAKER_CACHE_DIR = Path(
    os.getenv("INDEXTTS_SPEAKER_CACHE_DIR", "./speaker-cache")
).resolve()
AUTO_PRECOMPUTE_SPEAKERS = os.getenv("INDEXTTS_AUTO_PRECOMPUTE_SPEAKERS", "1") == "1"
MLX_MEMORY_LIMIT_GB = float(os.getenv("INDEXTTS_MLX_MEMORY_LIMIT_GB", "12"))
MLX_DEVICE = os.getenv("INDEXTTS_MLX_DEVICE", "mps").strip() or "mps"
MLX_DIFFUSION_STEPS = int(os.getenv("INDEXTTS_MLX_DIFFUSION_STEPS", "16"))
MLX_CFG_RATE = float(os.getenv("INDEXTTS_MLX_CFG_RATE", "0.7"))
MLX_QUANTIZE_BITS_RAW = os.getenv("INDEXTTS_MLX_QUANTIZE_BITS", "").strip()
MLX_QUANTIZE_BITS = int(MLX_QUANTIZE_BITS_RAW) if MLX_QUANTIZE_BITS_RAW else None

MODEL_REQUIRED_FILES: dict[str, list[str]] = {
    "mlx": [
        "config.yaml",
        "config.json",
        "gpt.safetensors",
        "s2mel.safetensors",
        "bigvgan.safetensors",
        "vq2emb.safetensors",
        "tokenizer.model",
        "feat1.pt",
        "feat2.pt",
        "wav2vec2bert_stats.pt",
    ],
    "pytorch": ["config.yaml", "gpt.pth", "s2mel.pth", "bpe.model"],
}


class SpeechRequest(BaseModel):
    model: str
    input: str = Field(min_length=1, max_length=MAX_TEXT_CHARACTERS)
    voice: str = Field(min_length=1, max_length=200)
    response_format: Literal["wav", "mp3"] = "wav"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    emotion: Literal[
        "happy",
        "sad",
        "angry",
        "fearful",
        "disgusted",
        "surprised",
        "calm",
        "fluent",
        "whisper",
    ] = "calm"
    emotion_alpha: float = Field(default=0.65, ge=0.0, le=1.0)

    @field_validator("input")
    @classmethod
    def clean_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("input must not be blank")
        return cleaned


class VoiceEntry(BaseModel):
    voice_id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=1000)
    reference_audio: str = Field(min_length=1, max_length=500)
    speaker_conditioning: str | None = Field(default=None, max_length=500)
    tags: list[str] = Field(default_factory=list, max_length=32)


@dataclass(frozen=True)
class ResolvedVoice:
    entry: VoiceEntry
    audio_path: Path
    conditioning_path: Path | None


EMOTION_VECTORS: dict[str, list[float]] = {
    "happy": [1, 0, 0, 0, 0, 0, 0, 0],
    "angry": [0, 1, 0, 0, 0, 0, 0, 0],
    "sad": [0, 0, 1, 0, 0, 0, 0, 0],
    "fearful": [0, 0, 0, 1, 0, 0, 0, 0],
    "disgusted": [0, 0, 0, 0, 1, 0, 0, 0],
    "whisper": [0, 0, 0, 0, 0, 0.65, 0, 0.35],
    "surprised": [0, 0, 0, 0, 0, 0, 1, 0],
    "calm": [0, 0, 0, 0, 0, 0, 0, 1],
    "fluent": [0, 0, 0, 0, 0, 0, 0, 1],
}

MLX_EMOTIONS = {
    "happy": "happy",
    "angry": "angry",
    "sad": "sad",
    "fearful": "afraid",
    "disgusted": "disgusted",
    "surprised": "surprised",
    "calm": "calm",
    "fluent": "calm",
    "whisper": "melancholic",
}


class IndexTTSRuntime:
    def __init__(self) -> None:
        self._model = None
        self._load_error: str | None = None
        self._lock = asyncio.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def _load_sync(self):
        try:
            if BACKEND == "mlx":
                from mlx_indextts.generate_v2 import IndexTTSv2

                model = IndexTTSv2(
                    model_dir=str(MODEL_DIR),
                    device=MLX_DEVICE,
                    memory_limit_gb=MLX_MEMORY_LIMIT_GB,
                    quantize_bits=MLX_QUANTIZE_BITS,
                )
            elif BACKEND == "pytorch":
                from indextts.infer_v2 import IndexTTS2

                model = IndexTTS2(
                    model_dir=str(MODEL_DIR),
                    cfg_path=str(MODEL_DIR / "config.yaml"),
                    use_fp16=os.getenv("INDEXTTS_FP16", "1") == "1",
                    use_deepspeed=os.getenv("INDEXTTS_DEEPSPEED", "0") == "1",
                    use_cuda_kernel=os.getenv("INDEXTTS_CUDA_KERNEL", "0") == "1",
                )
            else:
                raise RuntimeError(f"unsupported INDEXTTS_BACKEND: {BACKEND}")
        except Exception as exc:  # surfaced by /health without leaking paths
            self._load_error = f"{type(exc).__name__}: {exc}"[:500]
            raise
        self._model = model
        self._load_error = None
        return model

    async def ensure_loaded(self):
        if self._model is not None:
            return self._model
        return await asyncio.to_thread(self._load_sync)

    def _speaker_cache_path(self, voice: ResolvedVoice) -> Path:
        digest = hashlib.sha256()
        digest.update(voice.audio_path.read_bytes())
        for name in ("config.yaml", "config.json"):
            path = MODEL_DIR / name
            if path.is_file():
                digest.update(path.read_bytes())
        safe_voice_id = "".join(
            character if character.isalnum() or character in "-_" else "-"
            for character in voice.entry.voice_id
        ).strip("-") or "voice"
        return SPEAKER_CACHE_DIR / f"{safe_voice_id}-{digest.hexdigest()[:16]}.npz"

    def _resolve_mlx_speaker_sync(self, model, voice: ResolvedVoice) -> Path:
        if voice.conditioning_path is not None:
            return voice.conditioning_path
        if not AUTO_PRECOMPUTE_SPEAKERS:
            return voice.audio_path
        target = self._speaker_cache_path(voice)
        if target.is_file() and target.stat().st_size > 0:
            return target
        SPEAKER_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.stem}-{secrets.token_hex(6)}.tmp.npz")
        try:
            model.save_speaker(str(voice.audio_path), str(temporary))
            if not temporary.is_file() or temporary.stat().st_size == 0:
                raise RuntimeError("IndexTTS MLX did not create speaker conditioning")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return target

    async def synthesize(self, request: SpeechRequest, voice: ResolvedVoice) -> bytes:
        async with self._lock:
            model = await self.ensure_loaded()
            with tempfile.TemporaryDirectory(prefix="manju-indextts-") as temp_dir:
                raw_path = Path(temp_dir) / "generated.wav"
                output_path = Path(temp_dir) / f"output.{request.response_format}"
                if BACKEND == "mlx":
                    speaker_path = await asyncio.to_thread(
                        self._resolve_mlx_speaker_sync, model, voice
                    )

                    def infer() -> None:
                        model.generate(
                            text=request.input,
                            reference_audio=str(speaker_path),
                            output_path=str(raw_path),
                            max_text_tokens_per_segment=120,
                            diffusion_steps=MLX_DIFFUSION_STEPS,
                            cfg_rate=MLX_CFG_RATE,
                            emotion=MLX_EMOTIONS[request.emotion],
                            emo_alpha=request.emotion_alpha,
                            seed=None,
                            verbose=False,
                        )
                else:
                    vector = EMOTION_VECTORS[request.emotion]

                    def infer() -> None:
                        normalized = model.normalize_emo_vec(vector, apply_bias=True)
                        model.infer(
                            spk_audio_prompt=str(voice.audio_path),
                            text=request.input,
                            output_path=str(raw_path),
                            emo_alpha=request.emotion_alpha,
                            emo_vector=normalized,
                            use_random=False,
                            verbose=False,
                            max_text_tokens_per_segment=120,
                        )

                await asyncio.to_thread(infer)
                if not raw_path.is_file() or raw_path.stat().st_size == 0:
                    raise RuntimeError("IndexTTS did not create an audio file")
                if request.response_format == "wav" and request.speed == 1:
                    return raw_path.read_bytes()
                await asyncio.to_thread(
                    transcode,
                    raw_path,
                    output_path,
                    request.response_format,
                    request.speed,
                )
                return output_path.read_bytes()


runtime = IndexTTSRuntime()
app = FastAPI(title="Manju IndexTTS2 Sidecar", version="0.2.0")


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    if not API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="INDEXTTS_API_TOKEN is not configured",
        )
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(supplied, API_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid bearer token",
        )


def load_voices() -> list[ResolvedVoice]:
    if not VOICE_MANIFEST.is_file():
        return []
    try:
        payload = json.loads(VOICE_MANIFEST.read_text(encoding="utf-8"))
        raw_voices = payload["voices"] if isinstance(payload, dict) else payload
        entries = [VoiceEntry.model_validate(item) for item in raw_voices]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"invalid voice manifest: {exc}") from exc
    seen: set[str] = set()
    resolved: list[ResolvedVoice] = []
    root = VOICE_DIR.resolve()
    for entry in entries:
        if entry.voice_id in seen:
            raise HTTPException(status_code=500, detail="duplicate voice_id in manifest")
        seen.add(entry.voice_id)
        audio_path = (VOICE_DIR / entry.reference_audio).resolve()
        if root not in audio_path.parents or not audio_path.is_file():
            raise HTTPException(status_code=500, detail=f"missing reference audio for {entry.voice_id}")
        conditioning_path = None
        if entry.speaker_conditioning:
            conditioning_path = (VOICE_DIR / entry.speaker_conditioning).resolve()
            if root not in conditioning_path.parents or not conditioning_path.is_file():
                raise HTTPException(
                    status_code=500,
                    detail=f"missing speaker conditioning for {entry.voice_id}",
                )
            if conditioning_path.suffix.lower() != ".npz":
                raise HTTPException(
                    status_code=500,
                    detail=f"speaker conditioning must be .npz for {entry.voice_id}",
                )
        resolved.append(
            ResolvedVoice(
                entry=entry,
                audio_path=audio_path,
                conditioning_path=conditioning_path,
            )
        )
    return resolved


def transcode(source: Path, target: Path, output_format: str, speed: float) -> None:
    if shutil.which(FFMPEG) is None:
        raise RuntimeError("ffmpeg is required for MP3 or speed conversion")
    codec = ["-codec:a", "libmp3lame", "-b:a", "128k"] if output_format == "mp3" else ["-codec:a", "pcm_s16le"]
    command = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    if speed != 1:
        command.extend(["-filter:a", f"atempo={speed:.6f}"])
    command.extend([*codec, str(target)])
    completed = subprocess.run(command, capture_output=True, text=True, timeout=180, check=False)
    if completed.returncode != 0 or not target.is_file() or target.stat().st_size == 0:
        raise RuntimeError(f"ffmpeg conversion failed: {completed.stderr[-500:]}")


@app.get("/health", dependencies=[Depends(require_token)])
def health() -> dict[str, object]:
    voices = load_voices()
    required = MODEL_REQUIRED_FILES.get(BACKEND, [])
    missing = [name for name in required if not (MODEL_DIR / name).is_file()]
    backend_supported = BACKEND in MODEL_REQUIRED_FILES
    state = "ready" if backend_supported and not missing and voices else "not_ready"
    return {
        "status": state,
        "model": MODEL_NAME,
        "backend": BACKEND,
        "model_loaded": runtime.loaded,
        "voice_count": len(voices),
        "missing_model_files": missing,
        "load_error": runtime.load_error
        or (None if backend_supported else "unsupported backend"),
        "speaker_cache": AUTO_PRECOMPUTE_SPEAKERS if BACKEND == "mlx" else False,
    }


@app.get("/v1/models", dependencies=[Depends(require_token)])
def models() -> dict[str, object]:
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.get("/v1/voices", dependencies=[Depends(require_token)])
def voices() -> dict[str, object]:
    return {
        "voices": [
            {
                "voice_id": item.entry.voice_id,
                "name": item.entry.name,
                "description": item.entry.description,
                "tags": item.entry.tags,
                "type": "voice_cloning",
            }
            for item in load_voices()
        ]
    }


@app.post("/v1/audio/speech", dependencies=[Depends(require_token)])
async def speech(request: SpeechRequest) -> Response:
    if request.model != MODEL_NAME:
        raise HTTPException(status_code=404, detail="model not found")
    voice = next((item for item in load_voices() if item.entry.voice_id == request.voice), None)
    if voice is None:
        raise HTTPException(status_code=404, detail="voice not found")
    try:
        audio = await runtime.synthesize(request, voice)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"IndexTTS inference failed: {type(exc).__name__}") from exc
    media_type = "audio/wav" if request.response_format == "wav" else "audio/mpeg"
    return Response(content=audio, media_type=media_type, headers={"Cache-Control": "no-store"})
