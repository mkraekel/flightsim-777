#!/bin/sh
# Mirror the simulator into the standalone public repo (served by GitHub Pages).
set -e
SRC=$(cd "$(dirname "$0")/.." && pwd)
DST=${1:-/home/user/flightsim-777}
find "$DST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
(cd "$SRC" && tar cf - --exclude=./tests/shots --exclude=./node_modules .) | (cd "$DST" && tar xf -)
touch "$DST/.nojekyll"
