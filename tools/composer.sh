#!/usr/bin/env bash
# Run Composer against packages/php, falling back to the composer:2 image.
#
#   tools/composer.sh install
#   tools/composer.sh require --dev some/package
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$root/packages/php"

if command -v composer >/dev/null 2>&1; then
  cd "$pkg"
  exec composer "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "neither composer nor docker is available; install one of them" >&2
  exit 1
fi

MSYS_NO_PATHCONV=1 exec docker run --rm \
  -v "$(cd "$pkg" && pwd -W 2>/dev/null || pwd):/app" \
  -w /app \
  composer:2 "$@"
