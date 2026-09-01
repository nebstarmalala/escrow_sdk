#!/usr/bin/env bash
# Run a PHP command against packages/php.
#
# Uses a local `php` if one is on PATH, and otherwise falls back to the
# php:8.1-cli image. 8.1 is the package's declared floor, so the fallback tests
# the oldest supported runtime rather than whatever happens to be installed -
# which is the version that actually matters for a library.
#
#   tools/php.sh vendor/bin/phpunit
#   tools/php.sh vendor/bin/phpstan analyse --no-progress
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg="$root/packages/php"

if command -v php >/dev/null 2>&1; then
  cd "$pkg"
  exec php "$@"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "neither php nor docker is available; install one of them" >&2
  exit 1
fi

# MSYS_NO_PATHCONV stops Git Bash on Windows rewriting /app into a Windows path
# before docker ever sees it.
MSYS_NO_PATHCONV=1 exec docker run --rm \
  -v "$(cd "$pkg" && pwd -W 2>/dev/null || pwd):/app" \
  -w /app \
  php:8.1-cli php "$@"
