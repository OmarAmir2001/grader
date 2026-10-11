#!/usr/bin/env bash
# Copy exactly the files the website needs into one folder for GitHub Pages (no build, just a copy).
# Everything else (tests, fixtures, encrypted fixtures, README, node_modules) is left out on purpose.
#
#   scripts/collect-site.sh _site
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: $0 <output-folder>}"

rm -rf "$OUT"
mkdir -p "$OUT/frontend/js" "$OUT/backend/src/grader"

cp "$REPO_ROOT/index.html" "$REPO_ROOT/LICENSE-otter.txt" "$OUT/"
cp "$REPO_ROOT/frontend/index.html" "$REPO_ROOT/frontend/style.css" "$REPO_ROOT/frontend/config.js" "$OUT/frontend/"
cp "$REPO_ROOT"/frontend/js/*.js "$REPO_ROOT"/frontend/js/*.py "$OUT/frontend/js/"
# The browser worker fetches the grading engine from this exact path (see frontend/config.js).
cp "$REPO_ROOT/backend/src/grader/grader.py" "$OUT/backend/src/grader/"

echo "Collected $(find "$OUT" -type f | wc -l) files into $OUT"
