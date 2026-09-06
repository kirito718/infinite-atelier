#!/bin/sh
set -eu

: "${CODEX_HOME:=/data/codex}"
export CODEX_HOME
mkdir -p "$CODEX_HOME"
command -v codex >/dev/null 2>&1 || {
  echo "Codex CLI is not installed in the image" >&2
  exit 1
}
exec "$@"
