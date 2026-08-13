#!/usr/bin/env bash
# Rebuild + install a local unsigned Thanos Traycer.app for daily dogfood.
#
# Usage (from repo root):
#   ./scripts/install-local-desktop.sh              # full: rebuild CLI + app + install
#   ./scripts/install-local-desktop.sh --skip-cli   # faster: reuse staged CLI (GUI-only)
#   ./scripts/install-local-desktop.sh --no-open    # install without launching
#   make install-local-desktop
#   make install-local-desktop ARGS="--skip-cli"
#
# Requirements:
#   - macOS
#   - bun
#   - Node 24+ on PATH (or via nvm) for `build:sea`
#   - Stable encryption key at ~/.traycer/desktop-local-storage-key
#     (created automatically on first run; keep it forever or localStorage
#     encrypted prefs will not decrypt after rebuild)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/clients/desktop"
CLI_PKG="$ROOT/clients/traycer-cli"
KEY_FILE="${TRAYCER_DESKTOP_LOCAL_STORAGE_KEY_FILE:-$HOME/.traycer/desktop-local-storage-key}"
VERSION="${TRAYCER_LOCAL_VERSION:-0.0.0-local}"
INSTALL_DIR="${TRAYCER_INSTALL_DIR:-/Applications}"
APP_NAME="Thanos Traycer.app"
ENTITLEMENTS="$DESKTOP/resources/bundle/entitlements.mac.plist"

SKIP_CLI=0
WITH_CLI=0
OPEN_APP=1
SYNC_USER_CLI=1

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-cli) SKIP_CLI=1; shift ;;
    --with-cli) WITH_CLI=1; SKIP_CLI=0; shift ;;
    --no-open) OPEN_APP=0; shift ;;
    --no-sync-user-cli) SYNC_USER_CLI=0; shift ;;
    -h|--help) usage 0 ;;
    *)
      echo "unknown arg: $1" >&2
      usage 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: local install script is macOS-only" >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  arm64)
    CLI_PLATFORM="darwin-arm64"
    RELEASE_APP="$DESKTOP/release/mac-arm64/$APP_NAME"
    ;;
  x86_64)
    CLI_PLATFORM="darwin-x64"
    RELEASE_APP="$DESKTOP/release/mac/$APP_NAME"
    ;;
  *)
    echo "error: unsupported arch: $arch" >&2
    exit 1
    ;;
esac

CLI_STAGE_DIR="$DESKTOP/resources/cli/$CLI_PLATFORM"
CLI_STAGE_BIN="$CLI_STAGE_DIR/traycer"
USER_CLI_BIN="$HOME/.traycer/cli/bin/traycer"
INSTALLED_APP="$INSTALL_DIR/$APP_NAME"

log() { printf '==> %s\n' "$*"; }

ensure_node24() {
  local major
  if command -v node >/dev/null 2>&1; then
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    if [[ "${major:-0}" -ge 24 ]]; then
      return 0
    fi
  fi
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm use 24 >/dev/null
    major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$major" -ge 24 ]]; then
      log "using Node $(node -v) via nvm"
      return 0
    fi
  fi
  echo "error: Node >= 24 required for build:sea (got $(node -v 2>/dev/null || echo missing))" >&2
  echo "hint: source ~/.nvm/nvm.sh && nvm use 24" >&2
  exit 1
}

ensure_storage_key() {
  mkdir -p "$(dirname "$KEY_FILE")"
  if [[ ! -s "$KEY_FILE" ]]; then
    log "creating stable storage key at $KEY_FILE"
    openssl rand -hex 32 >"$KEY_FILE"
  fi
  export VITE_DESKTOP_LOCAL_STORAGE_KEY
  VITE_DESKTOP_LOCAL_STORAGE_KEY="$(tr -d '[:space:]' <"$KEY_FILE")"
  if [[ ${#VITE_DESKTOP_LOCAL_STORAGE_KEY} -lt 16 ]]; then
    echo "error: storage key in $KEY_FILE looks too short" >&2
    exit 1
  fi
  log "storage key: $KEY_FILE (${#VITE_DESKTOP_LOCAL_STORAGE_KEY} chars)"
}

build_and_stage_cli() {
  ensure_node24
  log "building CLI SEA ($CLI_PLATFORM)"
  (
    cd "$CLI_PKG"
    bun run build:sea
  )
  local sea_bin="$CLI_PKG/dist-sea/traycer"
  if [[ ! -x "$sea_bin" ]]; then
    echo "error: expected SEA binary at $sea_bin" >&2
    exit 1
  fi
  mkdir -p "$CLI_STAGE_DIR"
  cp "$sea_bin" "$CLI_STAGE_BIN"
  chmod +x "$CLI_STAGE_BIN"
  printf '{"version":"%s"}\n' "$VERSION" >"$CLI_STAGE_DIR/version.json"
  log "staged CLI → $CLI_STAGE_BIN"
}

maybe_build_cli() {
  if [[ "$SKIP_CLI" -eq 1 ]]; then
    if [[ ! -x "$CLI_STAGE_BIN" ]]; then
      echo "error: --skip-cli but staged CLI missing: $CLI_STAGE_BIN" >&2
      exit 1
    fi
    log "skipping CLI rebuild (reusing $CLI_STAGE_BIN)"
    return 0
  fi
  if [[ "$WITH_CLI" -eq 1 || ! -x "$CLI_STAGE_BIN" ]]; then
    build_and_stage_cli
    return 0
  fi
  # Default when staged CLI exists: rebuild unless --skip-cli.
  # Full rebuild is safer when orchestration CLI changed; use --skip-cli for GUI-only loops.
  build_and_stage_cli
}

package_app() {
  log "stamping production config (version=$VERSION)"
  (
    cd "$DESKTOP"
    restore() {
      bun scripts/set-deploy-target.cjs --restore >/dev/null
      log "restored desktop config.ts to dev defaults"
    }
    trap restore EXIT
    bun scripts/set-deploy-target.cjs --target=production --version="$VERSION"
    log "packaging unsigned app (CSC_IDENTITY_AUTO_DISCOVERY=false)"
    CSC_IDENTITY_AUTO_DISCOVERY=false bun run package:dir
  )
  if [[ ! -d "$RELEASE_APP" ]]; then
    echo "error: packaged app not found at $RELEASE_APP" >&2
    exit 1
  fi
}

install_app() {
  log "quitting running app (if any)"
  osascript -e "quit app \"Thanos Traycer\"" >/dev/null 2>&1 || true
  # Give Electron a moment to release file locks.
  sleep 1

  log "installing → $INSTALLED_APP"
  rm -rf "$INSTALLED_APP"
  ditto "$RELEASE_APP" "$INSTALLED_APP"
  xattr -cr "$INSTALLED_APP"

  if [[ ! -f "$ENTITLEMENTS" ]]; then
    echo "error: entitlements missing: $ENTITLEMENTS" >&2
    exit 1
  fi
  log "ad-hoc codesign"
  codesign --force --deep --sign - --entitlements "$ENTITLEMENTS" "$INSTALLED_APP" >/dev/null

  if [[ "$SYNC_USER_CLI" -eq 1 && -x "$CLI_STAGE_BIN" ]]; then
    mkdir -p "$(dirname "$USER_CLI_BIN")"
    cp "$CLI_STAGE_BIN" "$USER_CLI_BIN"
    chmod +x "$USER_CLI_BIN"
    log "synced user CLI → $USER_CLI_BIN (keeps traycer orchestration working)"
  fi

  if [[ "$OPEN_APP" -eq 1 ]]; then
    log "launching $INSTALLED_APP"
    open "$INSTALLED_APP"
  else
    log "installed (not launched): $INSTALLED_APP"
  fi
}

main() {
  command -v bun >/dev/null || {
    echo "error: bun not found" >&2
    exit 1
  }
  ensure_storage_key
  maybe_build_cli
  package_app
  install_app
  log "done"
}

main
