#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

cd "$ROOT_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required but was not found in PATH." >&2
  exit 1
fi

bun install --frozen-lockfile
bun run build

if [[ -f "$ROOT_DIR/claude-config.json" ]]; then
  cp "$ROOT_DIR/claude-config.json" "$ROOT_DIR/dist/claude-config.json"
fi

echo "Build complete: $ROOT_DIR/dist/cli.mjs"