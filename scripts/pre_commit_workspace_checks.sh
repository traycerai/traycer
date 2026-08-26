#!/usr/bin/env bash
# Project checks for pre-commit: lint, format, compile, build.
# Uses `nx affected` against a base ref for speed; falls back to full checks
# when no base ref exists (e.g. first commit). Tests run in their own workflow.
set -euo pipefail

gitroot="$(git rev-parse --show-toplevel)"
pushd "$gitroot" >/dev/null

nx_parallel="${NX_PARALLEL:-8}"

# Compile and build get their OWN, lower fan-out. Lint and format stream files
# one at a time, so eight of them cost little; `tsc` holds a whole type program
# resident, and these are not comparable workloads. Measured peak RSS for a
# single process, macOS, TypeScript 5.x:
#
#   traycer-clients-gui-app  `tsc -b`        ~3.5 GB
#   @traycer/protocol        `tsc --noEmit`  ~1.35 GB
#   @traycer-clients/shared  `tsc --noEmit`  ~1.15 GB
#
# A change touching protocol + shared + gui-app makes all three (plus their
# dependents) affected at once, so at --parallel=8 the compile step alone asks
# for ~6 GB before counting desktop, the CLI, and nx's own workers. That
# exhausts a CI runner and thrashes a developer machine, and it surfaces as a
# failed task rather than anything that names memory.
#
# Override with NX_COMPILE_PARALLEL when you know the box can take it.
nx_compile_parallel="${NX_COMPILE_PARALLEL:-3}"
workspace_check_lane="${WORKSPACE_CHECK_LANE:-all}"

run_static_checks() {
  local args=("$@")
  bun x nx affected --target=lint "${args[@]}" --parallel="${nx_parallel}"
  if [ -n "${CI:-}" ]; then
    bun run format:check
  else
    bun run format
  fi
}

run_compile_checks() {
  bun x nx affected --target=compile "$@" --parallel="${nx_compile_parallel}"
}

run_build_checks() {
  bun x nx affected --target=build "$@" --parallel="${nx_compile_parallel}"
}

run_full_checks() {
  echo "Running full workspace checks..."
  case "${workspace_check_lane}" in
    static)
      bun run lint
      if [ -n "${CI:-}" ]; then bun run format:check; else bun run format; fi
      ;;
    compile) bun run compile ;;
    build) bun run build ;;
    all)
      bun run lint
      if [ -n "${CI:-}" ]; then bun run format:check; else bun run format; fi
      bun run compile
      bun run build
      ;;
    *) echo "Unknown WORKSPACE_CHECK_LANE: ${workspace_check_lane}" >&2; exit 2 ;;
  esac
}

run_affected() {
  local args=("$@")
  case "${workspace_check_lane}" in
    static) run_static_checks "${args[@]}" ;;
    compile) run_compile_checks "${args[@]}" ;;
    build) run_build_checks "${args[@]}" ;;
    all)
      run_static_checks "${args[@]}"
      bun x nx affected --targets=compile,build "${args[@]}" \
        --parallel="${nx_compile_parallel}"
      ;;
    *) echo "Unknown WORKSPACE_CHECK_LANE: ${workspace_check_lane}" >&2; exit 2 ;;
  esac
}

if [ -n "${CI:-}" ] && [ -n "${NX_BASE:-}" ] && [ -n "${NX_HEAD:-}" ]; then
  echo "Affected workspace checks (${NX_BASE}..${NX_HEAD})..."
  run_affected --base="${NX_BASE}" --head="${NX_HEAD}" --tui=false
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
    run_affected --base="${base_ref}" --tui=false
  fi
fi

popd >/dev/null
