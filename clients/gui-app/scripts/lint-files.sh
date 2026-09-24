#!/usr/bin/env bash
# Lint the given paths with both of gui-app's linters: `bun run lint:files
# <paths...>`. `bun run lint` passes `.`, the whole project.
#
# Oxlint (type-aware, through tsgolint) owns every rule it can express; ESLint
# keeps the repository-specific selectors and boundaries. Both flags that
# tolerate ignored paths are load-bearing for the changed-files lint in
# scripts/lint-changed-files.mjs: an explicitly passed ignored file (for
# example src/routeTree.gen.ts) is otherwise an oxlint error and an ESLint
# warning, and --max-warnings 0 turns the warning into a failure.
set -euo pipefail

if [ "$#" -eq 0 ]; then
    set -- .
fi

oxlint -c oxlint.config.ts --fix --deny-warnings --no-error-on-unmatched-pattern "$@"
NODE_OPTIONS=--max-old-space-size=6144 eslint --cache --fix --max-warnings 0 --no-warn-ignored "$@"
