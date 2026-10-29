#!/usr/bin/env bash
# pre-commit hook: a committed `unreleased-features.ts` holds the literal
# `true`, the value development and the staging builds run with. Only a
# production build writes `false`, at build time, through the deploy-target
# stampers. `bun clients/scripts/set-unreleased-features.cjs --off` rewrites
# it for a local comparison against production, and a commit of that state
# would turn development and every staging build off.
# pre-commit passes the staged files; run `--restore` and stage again.
set -euo pipefail

status=0
for file in "$@"; do
  if ! grep -qE '^export const UNRELEASED_FEATURES_ENABLED: boolean = true;$' "$file"; then
    echo "$file: UNRELEASED_FEATURES_ENABLED must be the literal 'true' in a commit; run 'bun clients/scripts/set-unreleased-features.cjs --restore' and stage again" >&2
    status=1
  fi
done
exit "$status"
