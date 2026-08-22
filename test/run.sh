#!/usr/bin/env bash
# Headless acceptance test: builds the mod, loads it into a throwaway Factorio install
# of its own, and asserts on what the scanner actually outputs.
#
#   test/run.sh                 # run with the mod's default settings
#   test/run.sh --groups        # also turn "Publish to logistic group" on
#   test/run.sh --upgrade       # write the save with the PREVIOUS commit's build, then
#                               # load it with this one. Catches storage added without a
#                               # migration: on_configuration_changed does not fire
#                               # between builds of the same mod version.
#
#   FACTORIO=/path/to/binary TICKS=3000 test/run.sh
#
# Nothing here touches your real mods folder or saves, and it has its own Factorio write
# directory, so it runs while you have the game open.
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FACTORIO="${FACTORIO:-/Applications/factorio.app/Contents/MacOS/factorio}"
TICKS="${TICKS:-3000}"
WORK="$REPO/build/test"

# note: GROUPS is a special read only array in bash, do not reuse that name
WITH_GROUPS=0
UPGRADE=0
case "${1:-}" in
    --groups) WITH_GROUPS=1 ;;
    --upgrade) WITH_GROUPS=1; UPGRADE=1 ;;
esac

[ -x "$FACTORIO" ] || { echo "Factorio binary not found at $FACTORIO (set FACTORIO=...)"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# every build wipes build/, so all building happens before anything is staged
if [ "$UPGRADE" = "1" ]; then
    git -C "$REPO" diff --quiet -- src public locale || {
        echo "--upgrade rebuilds src/public/locale from the previous commit, so those must be clean"
        exit 1
    }
    PREV="$(git -C "$REPO" rev-parse --short HEAD~1)"
    echo "==> building previous commit $PREV, to write the save with"
    git -C "$REPO" checkout -q "$PREV" -- src public locale
    (cd "$REPO" && yarn build >/dev/null)
    cp "$REPO"/build/GhostScanner4_*.zip "$STAGE/old.zip"
    git -C "$REPO" checkout -q HEAD -- src public locale
fi

echo "==> building"
(cd "$REPO" && yarn build >/dev/null)
cp "$REPO"/build/GhostScanner4_*.zip "$STAGE/new.zip"

echo "==> staging"
rm -rf "$WORK"
mkdir -p "$WORK/mods" "$WORK/write"
cp -R "$REPO/test/harness" "$WORK/mods/gs4test_1.0.0"
if [ "$UPGRADE" = "1" ]; then
    cp "$STAGE/old.zip" "$WORK/mods/GhostScanner4_4.1.0.zip"
else
    cp "$STAGE/new.zip" "$WORK/mods/GhostScanner4_4.1.0.zip"
fi

# the game takes an exclusive lock on its user data directory, so give this run its own
CONFIG="$WORK/config.ini"
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

if [ "$UPGRADE" = "1" ]; then
    echo "==> swapping in the current build and loading that save"
    cp "$STAGE/new.zip" "$WORK/mods/GhostScanner4_4.1.0.zip"
fi

echo "==> running $TICKS ticks"
OUT="$("$FACTORIO" --config "$CONFIG" --mod-directory "$WORK/mods" --benchmark "$WORK/test.zip" \
    --benchmark-ticks "$TICKS" 2>&1 || true)"

echo "$OUT" | grep -E "GS4TEST|Error while running|caused a non-recoverable|attempt to" \
    | sed -E 's/^.*(GS4TEST|Error|attempt)/\1/' || true

if echo "$OUT" | grep -q "GS4TEST RESULT PASS"; then
    echo "==> PASS"
else
    echo "==> FAIL (no passing result line; see output above)"
    exit 1
fi
