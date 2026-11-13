#!/bin/sh
# Every check, in order: die.json's polygons, the rebuilt netlist and layouts, the simulator, and that the committed
# site/gen matches what die.json rebuilds. Stops at the first failure.
# Run from anywhere: sh test/all.sh
set -e
cd "$(dirname "$0")/.."
step() { echo "== $*"; out=$("$@" 2>&1) || { echo "$out"; echo "FAILED: $*"; exit 1; }; echo "$out" | tail -n 3; }
step python3 extract/check.py
step python3 extract/build.py
step node gen/draft.js
step node test/globals_test.js
step node test/test.js
step node test/card_test.js 1000
step node test/layout_test.js
echo "== site/gen matches a rebuild"
if [ -n "$(git status --porcelain site/gen)" ]; then
  git status --short site/gen
  echo "site/gen differs from a rebuild of die.json: commit the rebuilt files"
  exit 1
fi
echo "all checks passed"
