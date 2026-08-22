#!/usr/bin/env bash
# Headless acceptance test: builds the mod, loads it into a throwaway Factorio install
# of its own, and asserts on what the scanner actually outputs.
#
#   test/run.sh                 # signal correctness, mod defaults
#   test/run.sh --invert        # ... with "Invert output" on
#   test/run.sh --stacks        # ... with "Round to stacks" on
#   test/run.sh --slow          # ... with the pacing settings at their extremes
#   test/run.sh --groups        # logistic group naming, renaming and collisions
#   test/run.sh --topology      # the scanner's network merging with another and splitting
#   test/run.sh --lifecycle     # switched off, switched on, destroyed by script
#   test/run.sh --upgrade       # write the save with the PREVIOUS commit's build, then
#                               # load it with this one. Catches storage added without a
#                               # migration: on_configuration_changed does not fire
#                               # between builds of the same mod version.
#   test/run.sh --all           # every one of the above, in order
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

if [ "${1:-}" = "--all" ]; then
    for mode in "" --invert --stacks --slow --groups --topology --lifecycle --upgrade; do
        echo
        echo "############ test/run.sh ${mode:-(defaults)}"
        "${BASH_SOURCE[0]}" $mode || exit 1
    done
    exit 0
fi

# note: GROUPS is a special read only array in bash, do not reuse that name
SCENARIO=signals
UPGRADE=0
SETTINGS=()
case "${1:-}" in
    --invert)    SETTINGS+=(ghost-scanner-negative-output=true) ;;
    --stacks)    SETTINGS+=(ghost-scanner-round2stack=true) ;;
    --slow)      SETTINGS+=(ghost-scanner-scan-areas-per-tick=1
                            ghost-scanner-area-scan-delay=37
                            ghost-scanner-update-interval=1) ;;
    --groups)    SCENARIO=groups ;;
    --topology)  SCENARIO=topology ;;
    --lifecycle) SCENARIO=lifecycle ;;
    --upgrade)   SCENARIO=groups; UPGRADE=1 ;;
    "")          ;;
    *)           echo "unknown option $1"; exit 1 ;;
esac

# every scenario except the plain signal run needs the groups published
[ "$SCENARIO" = "signals" ] || SETTINGS+=(ghost-scanner-logistic-group=true)
SETTINGS+=("seance-test-scenario=$SCENARIO")

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
    OLD_ZIP_NAME="$(basename "$(ls "$REPO"/build/*.zip | head -1)")"
    cp "$REPO"/build/*.zip "$STAGE/old.zip"
    OLD_MOD="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$REPO/public/info.json")"
    git -C "$REPO" checkout -q HEAD -- src public locale
fi

echo "==> building"
(cd "$REPO" && yarn build >/dev/null)
NEW_ZIP_NAME="$(basename "$(ls "$REPO"/build/*.zip | head -1)")"
cp "$REPO"/build/*.zip "$STAGE/new.zip"
MOD="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['name'])" "$REPO/public/info.json")"
OLD_MOD="${OLD_MOD:-$MOD}"

echo "==> staging"
rm -rf "$WORK"
mkdir -p "$WORK/mods" "$WORK/write"
cp -R "$REPO/test/harness" "$WORK/mods/seance-test_1.0.0"
if [ "$UPGRADE" = "1" ]; then
    # Factorio insists the file is named exactly <mod name>_<version>.zip
    cp "$STAGE/old.zip" "$WORK/mods/$OLD_ZIP_NAME"
else
    cp "$STAGE/new.zip" "$WORK/mods/$NEW_ZIP_NAME"
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
  {"name":"$MOD","enabled":true},
  {"name":"$OLD_MOD","enabled":true},
  {"name":"seance-test","enabled":true}
]}
JSON

python3 "$REPO/test/mod-settings.py" "$WORK/mods/mod-settings.dat" "${SETTINGS[@]}"

echo "==> creating map"
"$FACTORIO" --config "$CONFIG" --mod-directory "$WORK/mods" --create "$WORK/test.zip" 2>&1 \
    | grep -E "^ *[0-9.]+ (Error|Warning)" || true

if [ "$UPGRADE" = "1" ]; then
    echo "==> swapping in the current build and loading that save"
    rm -f "$WORK/mods/$OLD_ZIP_NAME"
    cp "$STAGE/new.zip" "$WORK/mods/$NEW_ZIP_NAME"
fi

echo "==> running $TICKS ticks, scenario $SCENARIO"
OUT="$("$FACTORIO" --config "$CONFIG" --mod-directory "$WORK/mods" --benchmark "$WORK/test.zip" \
    --benchmark-ticks "$TICKS" 2>&1 || true)"

echo "$OUT" | grep -E "SEANCE|Error while running|caused a non-recoverable|attempt to" \
    | sed -E 's/^.*(SEANCE|Error|attempt)/\1/' || true

if echo "$OUT" | grep -q "SEANCE RESULT PASS"; then
    echo "==> PASS"
else
    echo "==> FAIL (no passing result line; see output above)"
    exit 1
fi
