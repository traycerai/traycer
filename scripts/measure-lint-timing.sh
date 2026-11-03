#!/usr/bin/env bash
# Throwaway measurement for CI plan ticket 21; this branch never lands.
# Times each phase of gui-app's and protocol's lint alone on the runner, over
# the inputs of e256690b2, with per-rule tables.
set -uo pipefail

out="${RUNNER_TEMP:-/tmp}/lint-timing"
mkdir -p "$out"

phase() {
  local label="$1"
  shift
  local start=$EPOCHREALTIME
  "$@" >"$out/$label.log" 2>&1
  local rc=$?
  local secs
  secs=$(python3 -c "print(f'{$EPOCHREALTIME-$start:.1f}')")
  echo "PHASE $label ${secs}s rc=$rc"
  echo "::notice title=$label::${secs}s rc=$rc"
}

stats() {
  python3 - "$1" <<'EOF'
import json, sys, collections
data = json.load(open(sys.argv[1]))
parse = fix = rules_total = 0.0
rules = collections.Counter()
files = 0
for f in data:
    st = f.get("stats")
    if not st:
        continue
    files += 1
    for p in st["times"]["passes"]:
        parse += p["parse"]["total"]
        fix += p["fix"]["total"]
        for name, r in p["rules"].items():
            rules[name] += r["total"]
            rules_total += r["total"]
print(f"files={files} parse={parse/1000:.1f}s rules={rules_total/1000:.1f}s fix={fix/1000:.1f}s")
for name, ms in rules.most_common(15):
    print(f"  {ms/1000:7.2f}s  {name}")
EOF
}

nproc
free -g | head -2

root="$PWD"
cd "$root/clients/gui-app" || exit 1
OXLINT_TSGOLINT_PATH="$(node -e 'console.log(require("@maschwenk/tsrslint").binaryPath())')"
export OXLINT_TSGOLINT_PATH
oxargs=(-c oxlint.config.ts --deny-warnings --no-error-on-unmatched-pattern .)

phase gui-oxlint bun x oxlint "${oxargs[@]}"
phase gui-oxlint-no-type-aware bun x oxlint "${oxargs[@]}" --type-aware=false
phase gui-oxlint-timings bun x oxlint "${oxargs[@]}" --debug=timings
tail -n 60 "$out/gui-oxlint-timings.log"
tail -n 5 "$out/gui-oxlint-no-type-aware.log"

export NODE_OPTIONS=--max-old-space-size=6144
ls -la .eslintcache 2>/dev/null
cp .eslintcache "$out/eslintcache.restored" 2>/dev/null
phase gui-eslint-restored-cache bun x eslint --cache --cache-strategy content --max-warnings 0 --no-warn-ignored .
phase gui-eslint-cold env TIMING=all bun x eslint --max-warnings 0 --no-warn-ignored --stats -f json -o "$out/gui-eslint.json" .
cat "$out/gui-eslint-cold.log"
stats "$out/gui-eslint.json"
unset NODE_OPTIONS

cd "$root/protocol" || exit 1
phase protocol-eslint bun x eslint --max-warnings 0 --no-warn-ignored .
phase protocol-eslint-timing env TIMING=all bun x eslint --max-warnings 0 --no-warn-ignored --stats -f json -o "$out/protocol-eslint.json" .
cat "$out/protocol-eslint-timing.log"
stats "$out/protocol-eslint.json"

cd "$root" || exit 1
cp "$out/eslintcache.restored" clients/gui-app/.eslintcache 2>/dev/null
phase all-six-nx-skip-cache bun x nx run-many -t lint --skip-nx-cache --parallel=8 --tui=false -p traycer-clients-gui-app @traycer/protocol @traycer-clients/desktop @traycer-clients/mobile @traycer-clients/shared @traycer-clients/traycer-cli
grep -E "nx run|Run duration" "$out/all-six-nx-skip-cache.log"
exit 0
