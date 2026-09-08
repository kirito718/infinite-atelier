#!/bin/sh
set -eu

# The authenticated server assigns CODEX_HOME per account; never reuse a shared login.
command -v codex >/dev/null 2>&1 || {
  echo "Codex CLI is not installed in the image" >&2
  exit 1
}
exec "$@"
