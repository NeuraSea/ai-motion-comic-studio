from __future__ import annotations

import asyncio
import sys
from pathlib import Path


SIDECAR_DIR = Path(__file__).resolve().parents[1]
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))

import app as sidecar  # noqa: E402


async def main() -> None:
    if sidecar.BACKEND != "mlx":
        raise SystemExit("speaker precompute requires INDEXTTS_BACKEND=mlx")
    voices = sidecar.load_voices()
    if not voices:
        raise SystemExit("voice manifest contains no usable voices")
    model = await sidecar.runtime.ensure_loaded()
    for voice in voices:
        if voice.conditioning_path is not None:
            print(f"{voice.entry.voice_id}: using explicit {voice.conditioning_path.name}")
            continue
        target = await asyncio.to_thread(
            sidecar.runtime._resolve_mlx_speaker_sync,
            model,
            voice,
        )
        print(f"{voice.entry.voice_id}: {target}")


if __name__ == "__main__":
    asyncio.run(main())
