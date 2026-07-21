from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

from huggingface_hub import snapshot_download


DEFAULT_REPOSITORY = "vanch007/mlx-indextts2-standard-8bit"
DEFAULT_REVISION = "81e890787be1b0b174b9ec3dafd89642f578b286"
MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024
REQUIRED_FILES = [
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
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download the verified MLX IndexTTS2 model layout."
    )
    parser.add_argument(
        "--repository",
        default=os.getenv("INDEXTTS_HF_REPOSITORY", DEFAULT_REPOSITORY),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(
            os.getenv(
                "INDEXTTS_MODEL_DIR",
                "./models/mlx-indextts2-standard-8bit",
            )
        ),
    )
    parser.add_argument(
        "--revision",
        default=os.getenv("INDEXTTS_HF_REVISION") or DEFAULT_REVISION,
    )
    parser.add_argument(
        "--skip-disk-check",
        action="store_true",
        help="Skip the 8 GiB free-space safety check.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(output).free
    if not args.skip_disk_check and free_bytes < MIN_FREE_BYTES:
        free_gib = free_bytes / 1024 / 1024 / 1024
        raise SystemExit(
            f"refusing model download: only {free_gib:.1f} GiB free; "
            "at least 8 GiB is required"
        )
    snapshot_download(
        repo_id=args.repository,
        revision=args.revision,
        local_dir=output,
        allow_patterns=REQUIRED_FILES,
    )
    missing = [name for name in REQUIRED_FILES if not (output / name).is_file()]
    if missing:
        raise SystemExit(f"download incomplete; missing: {', '.join(missing)}")
    print(f"MLX IndexTTS2 model ready: {output}")


if __name__ == "__main__":
    main()
