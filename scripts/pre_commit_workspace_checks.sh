#!/usr/bin/env bash
# Project checks for pre-commit: lint, format, compile; CI also builds.
# Uses `nx affected` against a base ref for speed; falls back to full checks
# when no base ref exists (e.g. first commit). Tests run in their own workflow.
set -euo pipefail

# Resolved before the pushd: BASH_SOURCE may be relative to the caller's cwd.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# LOCAL runs differ from CI in three ways, all for memory. Agents commit from
# several worktrees at once, and each check below holds a whole type program
# resident, so a commit used to cost ~8 GB (gui-app `tsgo -b`, never warm) +
# ~5 GB (whole-project type-aware lint) + ~5 GB (desktop's vite build), times
# every concurrent commit.
#
#   1. One machine-wide slot (scripts/machine-slot.sh, one per 16 GB of RAM)
#      for the whole run, shared with the internal monorepo's hook, so
#      concurrent commits queue instead of stacking their peaks.
#   2. Lint covers only the files this branch changed
#      (scripts/lint-changed-files.mjs); CI lints every affected project.
#   3. No `build`: bundling verifies packaging, not types, and CI runs it.
#      The exception is @traycer/protocol, whose build is a declaration emit
#      plus registry validation, errors `compile` (--noEmit) cannot see. It
#      builds locally when affected (~1.35 GB, no bundler).
#
# The compile targets themselves are incremental and single-threaded in every
# lane, so a warm local re-check costs seconds and ~2 GB.

run_static_checks() {
  local args=("$@")
  bun x nx affected --target=lint "${args[@]}" --parallel="${nx_parallel}"
  if [ -n "${CI:-}" ]; then
    bun run format:check
  else
    bun run format
  fi
}

run_local_static_checks() {
  bun scripts/lint-changed-files.mjs "$1"
  bun run format
}

run_compile_checks() {
  bun x nx affected --target=compile "$@" --parallel="${nx_compile_parallel}"
}

run_build_checks() {
  bun x nx affected --target=build "$@" --parallel="${nx_compile_parallel}"
}

# `nx affected` has no project filter (it forwards --projects to every
# affected target), so ask which projects are affected and run one target.
run_local_protocol_build() {
  local affected
  affected="$(bun x nx show projects --affected --base="$1" \
    --projects=@traycer/protocol --json)"
  case "${affected}" in
    *'"@traycer/protocol"'*) bun x nx run @traycer/protocol:build --tui=false ;;
  esac
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
      if [ -n "${CI:-}" ]; then bun run build; fi
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

run_local_affected() {
  local base="$1"
  shift
  case "${workspace_check_lane}" in
    static) run_local_static_checks "${base}" ;;
    compile) run_compile_checks --base="${base}" "$@" ;;
    build) run_build_checks --base="${base}" "$@" ;;
    all)
      run_local_static_checks "${base}"
      run_compile_checks --base="${base}" "$@"
      run_local_protocol_build "${base}"
      ;;
    *) echo "Unknown WORKSPACE_CHECK_LANE: ${workspace_check_lane}" >&2; exit 2 ;;
  esac
}

if [ -n "${CI:-}" ] && [ -n "${NX_BASE:-}" ] && [ -n "${NX_HEAD:-}" ]; then
  echo "Affected workspace checks (${NX_BASE}..${NX_HEAD})..."
  run_affected --base="${NX_BASE}" --head="${NX_HEAD}" --tui=false
else
  # The hook runs shellcheck without -x, so it cannot follow this file.
  # shellcheck disable=SC1091
  . "${script_dir}/machine-slot.sh"
  if [ -z "${CI:-}" ]; then
    machine_slot_acquire commit-checks auto
  fi

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
    if [ -n "${CI:-}" ]; then
      run_affected --base="${base_ref}" --tui=false
    else
      run_local_affected "${base_ref}" --tui=false
    fi
  fi
fi

popd >/dev/null
