#!/usr/bin/env bash
# Rebuild the sundial repo from the frozen fast-import stream.
# Usage: ./build.sh [target-dir]   (default: ./sundial)
set -euo pipefail
dir="${1:-sundial}"
git init -q "$dir"
git -C "$dir" fast-import --quiet < "$(dirname "$0")/sundial.fast-import"
git -C "$dir" checkout -q main
echo "rebuilt $dir @ $(git -C "$dir" rev-parse HEAD)"
