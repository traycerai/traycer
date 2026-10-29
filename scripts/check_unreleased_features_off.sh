#!/usr/bin/env bash
# pre-commit hook: a committed `unreleased-features.ts` holds the literal
# `false`. `bun clients/scripts/set-unreleased-features.cjs --on` rewrites it
# for a local build of the features the next release does not ship, and a
# commit of that state would turn every build that stamps nothing on. The
# staging builds write `true` themselves, at build time, and restore it.
# pre-commit passes the staged files; run `--restore` and stage again.
set -euo pipefail

status=0
for file in "$@"; do
  if ! grep -qE '^export const UNRELEASED_FEATURES_ENABLED: boolean = false;$' "$file"; then
    echo "$file: UNRELEASED_FEATURES_ENABLED must be the literal 'false' in a commit; run 'bun clients/scripts/set-unreleased-features.cjs --restore' and stage again" >&2
    status=1
  fi
done
exit "$status"
