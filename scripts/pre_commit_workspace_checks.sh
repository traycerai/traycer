#!/usr/bin/env bash
# Project checks for pre-commit: lint, format, compile, build.
# Uses `nx affected` against a base ref for speed; falls back to full checks
# when no base ref exists (e.g. first commit). Tests run in their own workflow.
set -euo pipefail

gitroot="$(git rev-parse --show-toplevel)"
pushd "$gitroot" >/dev/null

nx_parallel="${NX_PARALLEL:-8}"

run_full_checks() {
  echo "Running full workspace checks..."
  bun run lint
  bun run format
  bun run compile
  bun run build
}

run_affected() {
  local args=("$@")
  bun x nx affected --target=lint "${args[@]}"
  bun x nx affected --target=format "${args[@]}"
  bun x nx affected --targets=compile,build "${args[@]}"
}

if [ -n "${CI:-}" ] && [ -n "${NX_BASE:-}" ] && [ -n "${NX_HEAD:-}" ]; then
  echo "Affected workspace checks (${NX_BASE}..${NX_HEAD})..."
  run_affected --base="${NX_BASE}" --head="${NX_HEAD}" --parallel="${nx_parallel}" --tui=false
else
  base_ref=""
  for ref in origin/main main HEAD~1; do
    if git rev-parse --verify "${ref}" >/dev/null 2>&1; then
      base_ref="${ref}"
      break
    fi
  done

  if [ -z "${base_ref}" ]; then
    run_full_checks
  else
    echo "Affected workspace checks (base: ${base_ref})..."
    run_affected --base="${base_ref}" --parallel="${nx_parallel}" --tui=false
  fi
fi

popd >/dev/null
