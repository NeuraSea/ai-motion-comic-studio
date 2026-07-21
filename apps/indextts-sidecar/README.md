# Manju IndexTTS2 Sidecar

Authenticated, MLX-first IndexTTS2 inference service for Manju Studio. The
HTTP contract stays independent from Gradio and from the inference backend.

## Main path: Apple Silicon + MLX

Requirements:

- Apple Silicon Mac
- Python 3.10-3.12 (managed automatically by `uv`)
- `uv` and `ffmpeg`
- about 12 GB unified-memory budget for the worker

From this directory:

```bash
cp .env.example .env
uv sync --extra mlx
uv run --env-file .env --extra mlx python scripts/download_model.py
cp voices/voices.example.json voices/voices.json
# Add each referenced WAV, then precompute reusable speaker conditioning.
uv run --env-file .env --extra mlx python scripts/precompute_speakers.py
./scripts/start.sh
```

The default model repository is
`vanch007/mlx-indextts2-standard-8bit`. It uses the unified file layout
expected by `solar2ain/mlx-indextts`. The public API model ID remains
`IndexTTS-2`, so changing the local runtime does not invalidate project voice
bindings. The example configuration pins the verified Hugging Face revision;
upgrading weights is an explicit operation rather than an implicit latest-tag
change. The downloader refuses to begin with less than 8 GiB free space so the
model download does not consume the runtime's swap headroom.

`INDEXTTS_AUTO_PRECOMPUTE_SPEAKERS=1` also creates missing `.npz` speaker
conditioning lazily on the first synthesis. Precomputing explicitly is better
for production because startup and first-request latency become predictable.

## Voice catalog

`voices/voices.json` is the durable catalog. Every entry must have a stable
`voice_id` and a real reference WAV. `speaker_conditioning` is optional; when
present it must point to a v2 `.npz` file inside the voice directory.

```json
{
  "voices": [{
    "voice_id": "ali-main",
    "name": "Ali",
    "description": "restrained young female voice",
    "reference_audio": "ali-main.wav",
    "speaker_conditioning": "ali-main.npz",
    "tags": ["female", "young"]
  }]
}
```

## Run

Set a long, independent `INDEXTTS_API_TOKEN` in `.env`, then:

```bash
npm run start:indextts
```

The service listens on `127.0.0.1:7861` by default. Do not use multiple
Uvicorn workers for one MLX device; inference and speaker preprocessing are
serialized inside the process.

## Contract

- `GET /health`: backend, model files and voice catalog readiness; no model load
- `GET /v1/models`: stable model discovery
- `GET /v1/voices`: stable real-account/local voice IDs
- `POST /v1/audio/speech`: synchronous WAV/MP3 synthesis

Every endpoint requires `Authorization: Bearer $INDEXTTS_API_TOKEN`.

## Legacy PyTorch backend

CUDA deployments can set `INDEXTTS_BACKEND=pytorch`, point
`INDEXTTS_MODEL_DIR` at the official IndexTTS2 checkpoints, and expose the
official `indextts` package on `PYTHONPATH`. MLX remains the default and tested
Mac path.
