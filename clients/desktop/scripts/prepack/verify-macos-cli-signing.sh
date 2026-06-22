#!/usr/bin/env bash
# Verify that the Traycer CLI binary (or binaries) bundled inside a packaged
# macOS `Traycer.app` are correctly signed by the expected Apple Developer ID
# team, accepted by Gatekeeper, and that the parent `.app` has a valid
# notarization staple.
#
# Usage:
#   APPLE_TEAM_ID=XXXXXXXXXX verify-macos-cli-signing.sh <path-to-Traycer.app>
#
# Runs only on macOS; exits cleanly with a note on other platforms so
# contributors on Linux/Windows can invoke it without noise.
set -euo pipefail

PREFIX="[verify-macos-cli-signing]"

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "${PREFIX} usage: $0 <path-to-Traycer.app>" >&2
  echo "${PREFIX}   APPLE_TEAM_ID must be exported in the environment on macOS." >&2
  exit 2
fi

APP_PATH="$1"

if [ "$(uname)" != "Darwin" ]; then
  echo "${PREFIX} not running on macOS (uname=$(uname)); skipping verification."
  exit 0
fi

if [ ! -d "${APP_PATH}" ]; then
  echo "::error::${PREFIX} '${APP_PATH}' is not a directory or does not exist."
  exit 1
fi

if [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo "::error::${PREFIX} APPLE_TEAM_ID is not set in the environment; cannot verify team identifier."
  exit 1
fi

CLI_DIR="${APP_PATH}/Contents/Resources/cli"

if [ ! -d "${CLI_DIR}" ]; then
  echo "::error::${PREFIX} CLI resource directory not found at '${CLI_DIR}'."
  exit 1
fi

echo "${PREFIX} scanning '${CLI_DIR}' for Mach-O binaries"

mach_o_count=0
failure_count=0

# Iterate every regular file (including nested) under the CLI directory.
while IFS= read -r -d '' candidate; do
  if ! file -b "${candidate}" | grep -q "Mach-O"; then
    echo "${PREFIX} skipping non-Mach-O file: ${candidate}"
    continue
  fi

  mach_o_count=$((mach_o_count + 1))
  echo "${PREFIX} verifying Mach-O binary: ${candidate}"

  # 1. Deep, strict codesign verification.
  if ! codesign --verify --deep --strict --verbose=2 "${candidate}"; then
    echo "::error::${PREFIX} codesign --verify failed for '${candidate}'. The bundled CLI binary is unsigned or mis-signed."
    failure_count=$((failure_count + 1))
    continue
  fi

  # 2. Team identifier match against APPLE_TEAM_ID.
  requirements_output=$(codesign --display --requirements - --verbose=4 "${candidate}" 2>&1 || true)
  if ! echo "${requirements_output}" | grep -q "TeamIdentifier=${APPLE_TEAM_ID}"; then
    echo "::error::${PREFIX} team identifier mismatch for '${candidate}'. Expected TeamIdentifier=${APPLE_TEAM_ID}. codesign output follows:"
    echo "${requirements_output}"
    failure_count=$((failure_count + 1))
    continue
  fi

  # NOTE: no per-binary `spctl --assess` here. `spctl --assess --type execute`
  # only knows how to evaluate app bundles and installer packages; run against a
  # bare command-line Mach-O it always returns "rejected (the code is valid but
  # does not seem to be an app)" even when the tool is correctly signed AND
  # notarized. Gatekeeper coverage for these nested CLI binaries is established
  # by the PARENT app's notarization ticket (validated once via `stapler` after
  # the loop) - the notary service hashes every nested Mach-O, so a valid app
  # staple proves these binaries are notarized. Per-binary signing integrity is
  # already covered by the codesign --verify (1) and team-id (2) checks above.

  echo "${PREFIX} OK: ${candidate}"
done < <(find "${CLI_DIR}" -type f -print0)

if [ "${mach_o_count}" -eq 0 ]; then
  echo "::error::${PREFIX} no Mach-O CLI binaries found inside '${CLI_DIR}'. A packaged macOS .app must contain at least one bundled CLI SEA; refusing to mark the release verified."
  exit 1
fi

# 4. Verify the .app itself is notarized via a valid staple.
echo "${PREFIX} validating notarization staple on '${APP_PATH}'"
if ! stapler validate "${APP_PATH}"; then
  echo "::error::${PREFIX} stapler validate failed for '${APP_PATH}'. The .app is missing a valid notarization staple; the bundled CLI is not covered by notarization."
  failure_count=$((failure_count + 1))
fi

if [ "${failure_count}" -gt 0 ]; then
  echo "::error::${PREFIX} verification failed for ${failure_count} item(s) inside '${APP_PATH}'."
  exit 1
fi

echo "${PREFIX} verification succeeded for ${mach_o_count} Mach-O binary/binaries inside '${APP_PATH}'."
exit 0
