#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
ENV_FILE="${INDEXTTS_ENV_FILE:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "IndexTTS environment file not found: $ENV_FILE" >&2
  echo "Copy .env.example to .env and set INDEXTTS_API_TOKEN first." >&2
  exit 2
fi

exec uv run --env-file "$ENV_FILE" --extra mlx \
  uvicorn app:app \
  --host "${INDEXTTS_HOST:-127.0.0.1}" \
  --port "${INDEXTTS_PORT:-7861}" \
  --workers 1
