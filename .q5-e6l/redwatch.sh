#!/usr/bin/env bash
# Usage: redwatch.sh "<label>"   — run the suite, print failing titles, restore.
cd /Users/hardikshingala/.traycer/worktrees/traycer-oss-cutover-02 || exit 1
echo "### $1"
env -u TRAYCER_CLI_VERSION bunx vitest run --root clients/traycer-cli \
  src/host/__tests__/update-run.test.ts 2>&1 \
  | grep -E "^\s+×|Tests " | sed 's/^[[:space:]]*/  /'
cp .q5-e6l/snapshot/update-run.ts clients/traycer-cli/src/host/update-run.ts
cp .q5-e6l/snapshot/host-update.ts clients/traycer-cli/src/commands/host-update.ts
cp .q5-e6l/snapshot/update-run.test.ts clients/traycer-cli/src/host/__tests__/update-run.test.ts
