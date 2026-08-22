#!/usr/bin/env bash
# Headless acceptance test: builds the mod, loads it into a throwaway Factorio
# install of its own, and asserts on what the scanner actually outputs.
#
#   test/run.sh                 # run with the mod's default settings
#   test/run.sh --groups        # also turn "Publish to logistic group" on
#   FACTORIO=/path/to/binary test/run.sh
#
# Nothing here touches your real mods folder or saves.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FACTORIO="${FACTORIO:-/Applications/factorio.app/Contents/MacOS/factorio}"
TICKS="${TICKS:-1200}"
WORK="$REPO/build/test"

# note: GROUPS is a special read only array in bash, do not reuse that name
WITH_GROUPS=0
[ "${1:-}" = "--groups" ] && WITH_GROUPS=1

[ -x "$FACTORIO" ] || { echo "Factorio binary not found at $FACTORIO (set FACTORIO=...)"; exit 1; }

# the game takes an exclusive lock on its user data directory, so give this run its
# own write directory: that way it works while you have Factorio open
mkdir -p "$WORK/write"
CONFIG="$WORK/config.ini"

echo "==> building"
(cd "$REPO" && yarn build >/dev/null)
ZIP="$(ls "$REPO"/build/GhostScanner4_*.zip | head -1)"

echo "==> staging $(basename "$ZIP")"
rm -rf "$WORK"
mkdir -p "$WORK/mods"
mkdir -p "$WORK/write"
cp "$ZIP" "$WORK/mods/"
cp -R "$REPO/test/harness" "$WORK/mods/gs4test_1.0.0"
cat > "$CONFIG" <<INI
[path]
read-data=__PATH__executable__/../data
write-data=$WORK/write
INI

cat > "$WORK/mods/mod-list.json" <<JSON
{"mods":[
  {"name":"base","enabled":true},
  {"name":"quality","enabled":true},
  {"name":"elevated-rails","enabled":false},
  {"name":"space-age","enabled":false},
  {"name":"GhostScanner4","enabled":true},
  {"name":"gs4test","enabled":true}
]}
JSON

if [ "$WITH_GROUPS" = "1" ]; then
    python3 "$REPO/test/mod-settings.py" "$WORK/mods/mod-settings.dat" \
        ghost-scanner-logistic-group=true
fi

echo "==> creating map"
"$FACTORIO" --config "$CONFIG" --mod-directory "$WORK/mods" --create "$WORK/test.zip" 2>&1 \
    | grep -E "^ *[0-9.]+ (Error|Warning)" || true

echo "==> running $TICKS ticks"
OUT="$("$FACTORIO" --config "$CONFIG" --mod-directory "$WORK/mods" --benchmark "$WORK/test.zip" --benchmark-ticks "$TICKS" 2>&1)"

echo "$OUT" | grep -E "GS4TEST|^ *[0-9.]+ Error" | sed -E 's/^.*(GS4TEST|Error)/\1/' || true

if echo "$OUT" | grep -q "GS4TEST RESULT PASS"; then
    echo "==> PASS"
else
    echo "==> FAIL (no passing result line; see output above)"
    exit 1
fi
