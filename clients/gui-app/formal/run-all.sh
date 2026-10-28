#!/usr/bin/env bash
# Runs one config until every invariant it lists either holds or has a
# counterexample: formal/run-all.sh <Config> [TLC args...]
# Each pass checks all remaining invariants breadth-first, so each violation
# is a shortest trace; the violated invariant is then dropped and the rest
# re-run. Traces land in results/<Config>.<Invariant>.out, the final run's
# log in results/<Config>.ok.out. Read a trace with formal/trace.py.
# TLC_TIMEOUT (seconds, default 600) caps each pass; a pass that reaches it
# without a violation stops the run and records the bound it reached, so
# the remaining invariants held only up to that depth.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
config="${1:?usage: run-all.sh <Config> [TLC args...]}"
shift
mkdir -p "$here/results" "$here/states"
work="$here/states/$config.run.cfg"
cp "$here/$config.cfg" "$work"
while :; do
  out="$here/results/$config.run.out"
  "$here/check.sh" "states/$config.run" "$@" >"$out" 2>&1 &
  pid=$!
  start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    if [ $((SECONDS - start)) -ge "${TLC_TIMEOUT:-600}" ]; then
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
      echo "TIMEOUT after ${TLC_TIMEOUT:-600}s" >>"$out"
      break
    fi
    sleep 2
  done
  wait "$pid" 2>/dev/null || true
  # TLC keeps every run's state queue on disk (gigabytes for a long pass).
  rm -rf "$here/states/$config.run"
  violated="$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated\.$/\1/p' "$out" | head -1)"
  if [ -z "$violated" ]; then
    if grep -q "Model checking completed. No error has been found" "$out"; then
      mv "$out" "$here/results/$config.ok.out"
      echo "$config: remaining invariants hold ($(grep -o '[0-9,]* distinct states found' "$here/results/$config.ok.out"))"
    elif grep -q "^TIMEOUT" "$out"; then
      mv "$out" "$here/results/$config.bound.out"
      echo "$config: no further violation up to: $(grep '^Progress' "$here/results/$config.bound.out" | tail -1)"
    else
      mv "$out" "$here/results/$config.error.out"
      echo "$config: TLC failed; see results/$config.error.out" >&2
      exit 1
    fi
    break
  fi
  mv "$out" "$here/results/$config.$violated.out"
  echo "$config: $violated violated -> results/$config.$violated.out"
  grep -v "^    $violated\$" "$work" >"$work.next"
  mv "$work.next" "$work"
done
