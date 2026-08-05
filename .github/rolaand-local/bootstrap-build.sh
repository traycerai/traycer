#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(pwd)"
ARTIFACTS="$ROOT/artifacts"
DIAGNOSTICS="$ROOT/diagnostics"
ROLFOX_RAW="https://raw.githubusercontent.com/Rolaand-Jayz/Rolfox/main"
HOST_VERSION="${HOST_VERSION:-1.1.9}"
HOST_SHA256="${HOST_SHA256:-ac7d0e47d8fe27f966b670d5867aa733705748037a1ea07132cf1ea46bb4d68d}"
TEST_HOME=/tmp/traycer-local-smoke-home
HOST_PID=""

cleanup_host() {
  if [[ -n "$HOST_PID" ]]; then
    kill "$HOST_PID" 2>/dev/null || true
    wait "$HOST_PID" 2>/dev/null || true
  fi
}

capture_failure() {
  local exit_code=$?
  cleanup_host
  mkdir -p "$DIAGNOSTICS"
  for file in \
    protocol/src/config/local-identity.ts \
    clients/gui-app/src/lib/analytics.ts \
    clients/desktop/src/electron-main/startup/desktop-startup.ts \
    scripts/local-only/traycer-local-preload.cjs \
    /tmp/traycer-host-smoke.log \
    /tmp/traycer-host-rpc.json; do
    if [[ -f "$file" ]]; then
      cp "$file" "$DIAGNOSTICS/$(basename "$file")"
    fi
  done
  if compgen -G '/tmp/traycer-host-network.trace*' >/dev/null; then
    cp /tmp/traycer-host-network.trace* "$DIAGNOSTICS/" || true
  fi
  printf 'Build failed with exit code %s\n' "$exit_code" > "$DIAGNOSTICS/FAILURE.txt"
  exit "$exit_code"
}
trap capture_failure ERR
trap cleanup_host EXIT

rm -rf "$ARTIFACTS" "$DIAGNOSTICS" /tmp/host-stage /tmp/packaged-host "$TEST_HOME"
rm -f /tmp/traycer-local.patch* /tmp/apply-optimizations.py
rm -f /tmp/traycer-host-network.trace* /tmp/traycer-host-smoke.log /tmp/traycer-host-rpc.json

# Apply the previously verified optimization payload to the pinned source tree.
curl -fsSL --retry 3 \
  "$ROLFOX_RAW/.github/patches/apply_patches.py.gz.b64" \
  | base64 -d | gunzip > /tmp/apply-optimizations.py
python3 /tmp/apply-optimizations.py "$ROOT"

# Reassemble and verify the accountless/local-only source patch.
: > /tmp/traycer-local.patch.gz.b64
for part in $(seq -w 0 8); do
  curl -fsSL --retry 3 \
    "$ROLFOX_RAW/.github/patches/traycer-local-only.parts/part-$part" \
    >> /tmp/traycer-local.patch.gz.b64
done
echo "0a7d746622e3c9be7108a66f28a5f06f72a1ea141823ba4ae50946d558008151  /tmp/traycer-local.patch.gz.b64" \
  | sha256sum --check
base64 -d /tmp/traycer-local.patch.gz.b64 | gunzip > /tmp/traycer-local.patch
echo "3c1995d5a4d019c945ebf046c4a5f4c078fffd59c593dec61cc50cdb623cc545  /tmp/traycer-local.patch" \
  | sha256sum --check
patch --batch --forward -p1 < /tmp/traycer-local.patch
python3 .github/rolaand-local/fix-source.py "$ROOT"

bun install --frozen-lockfile
bun x prettier --write \
  LOCAL_ONLY_NOTES.md \
  protocol/src/config/index.ts \
  protocol/src/config/local-identity.ts \
  scripts/local-only/traycer-local-preload.cjs \
  clients/desktop/package.json \
  clients/desktop/src/config.ts \
  clients/desktop/src/electron-main/ipc/auth-ipc.ts \
  clients/desktop/src/electron-main/startup/desktop-startup.ts \
  clients/gui-app/src/components/auth/user-menu.tsx \
  clients/gui-app/src/components/layout/header/app-header.tsx \
  clients/gui-app/src/components/settings/settings-modal-content.tsx \
  clients/gui-app/src/lib/analytics.ts \
  clients/gui-app/src/lib/provider-ordering.ts \
  clients/gui-app/src/lib/settings-sections.ts \
  clients/gui-app/src/traycer-app.tsx \
  clients/traycer-cli/src/commands/host-start.ts \
  clients/traycer-cli/src/config.ts \
  clients/traycer-cli/src/host/ensure.ts

bun run compile
bun x vitest run --config clients/shared/vitest.config.ts \
  clients/shared/host-transport/remote/__tests__/chunker.test.ts \
  clients/shared/host-transport/remote/__tests__/scheduler.test.ts \
  clients/shared/host-transport/remote/__tests__/remote-session.test.ts
bun x vitest run --config protocol/vitest.config.ts \
  protocol/src/config/__tests__/credentials.test.ts \
  protocol/src/config/__tests__/credentials-mutation.test.ts

# Persist the modified source itself into Rolaand-traycer. This push does not
# retrigger the bootstrap because the workflow is path-gated to the trigger.
git config user.name "Rolaand Traycer Build"
git config user.email "Rolaand-Jayz@users.noreply.github.com"
git add -A
git commit -m "feat: add accountless optimized Traycer distribution"
git push origin HEAD:rolaand/accountless-optimized

# Bundle the complete released Host runtime, with the local-only preload.
curl --fail --location --retry 3 \
  "https://github.com/traycerai/traycer/releases/download/host-v${HOST_VERSION}/traycer-host-linux-x64.tar.gz" \
  -o /tmp/traycer-host-linux-x64.tar.gz
echo "$HOST_SHA256  /tmp/traycer-host-linux-x64.tar.gz" | sha256sum --check
mkdir -p /tmp/host-stage
tar -xzf /tmp/traycer-host-linux-x64.tar.gz -C /tmp/host-stage
test -x /tmp/host-stage/host-runtime/traycer-host
cp scripts/local-only/traycer-local-preload.cjs \
  /tmp/host-stage/host-runtime/traycer-local-preload.cjs
chmod 644 /tmp/host-stage/host-runtime/traycer-local-preload.cjs
tar -C /tmp/host-stage -czf /tmp/host-runtime-linux-x64.tar.gz host-runtime

(
  cd clients/traycer-cli
  TRAYCER_CLI_VERSION=1.0.0-local bun run build:sea
)
stage=clients/desktop/resources/cli/linux-x64
rm -rf "$stage"
mkdir -p "$stage"
cp clients/traycer-cli/dist-sea/traycer "$stage/traycer"
chmod +x "$stage/traycer"
printf '{"version":"1.0.0-local"}\n' > "$stage/version.json"
cp /tmp/host-runtime-linux-x64.tar.gz "$stage/host-runtime-linux-x64.tar.gz"
echo "$HOST_SHA256  original-host-runtime-linux-x64.tar.gz" > "$stage/UPSTREAM_HOST_SHA256.txt"

# Create a local identity and prove authenticated Host RPC while tracing all
# Host network syscalls. Only loopback traffic is accepted.
mkdir -p "$TEST_HOME/.traycer/host/smoke"
chmod 700 "$TEST_HOME"
cat > .traycer-local-create-identity.ts <<'TS'
import { ensureLocalIdentity } from "./protocol/src/config/local-identity";
const result = await ensureLocalIdentity("production");
console.log(JSON.stringify({
  userId: result.authenticatedUser.user.id,
  authnBaseUrl: result.credentials.authnBaseUrl,
  jwks: result.paths.jwks,
}));
TS
HOME="$TEST_HOME" bun .traycer-local-create-identity.ts
test -s "$TEST_HOME/.traycer/local-identity/private-key.pem"
test -s "$TEST_HOME/.traycer/local-identity/jwks.json"
test -s "$TEST_HOME/.traycer/cli/credentials"

mkdir -p /tmp/packaged-host
tar -xzf "$stage/host-runtime-linux-x64.tar.gz" -C /tmp/packaged-host
PRELOAD=/tmp/packaged-host/host-runtime/traycer-local-preload.cjs
DATA="$TEST_HOME/.traycer/host/smoke"
TRACE=/tmp/traycer-host-network.trace
(
  cd /tmp/packaged-host/host-runtime
  HOME="$TEST_HOME" \
    TRAYCER_LOCAL_IDENTITY_DIR="$TEST_HOME/.traycer/local-identity" \
    NODE_OPTIONS="--require=$PRELOAD" \
    timeout 50s strace -ff -e trace=network -s 256 -o "$TRACE" \
    ./traycer-host --host-data-dir "$DATA"
) >/tmp/traycer-host-smoke.log 2>&1 &
HOST_PID=$!

PID_FILE=''
for _ in $(seq 1 200); do
  PID_FILE="$(find "$DATA" -name pid.json -type f -print -quit 2>/dev/null || true)"
  [[ -z "$PID_FILE" ]] || break
  sleep 0.2
done
if [[ -z "$PID_FILE" ]]; then
  cat /tmp/traycer-host-smoke.log
  false
fi

cat > .traycer-local-probe-host.ts <<'TS'
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostRpcRegistry } from "./protocol/src/host/registry";
import { MutableBearerLease } from "./clients/shared/auth/bearer-source";
import { WsRpcClient } from "./clients/shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "./clients/shared/host-transport/whatwg-ws-factory";
import type { HostRequestAuthority } from "./clients/shared/host-transport/host-messenger";
const [pidPath, credentialsPath] = process.argv.slice(2);
if (!pidPath || !credentialsPath) throw new Error("missing probe paths");
const metadata = JSON.parse(await readFile(pidPath, "utf8"));
const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
const abort = new AbortController();
const client = new WsRpcClient({
  registry: hostRpcRegistry,
  requestId: () => randomUUID(),
  webSocketFactory: createWhatwgWebSocketFactory(),
  dialTimeoutMs: 5_000,
  frameTimeoutMs: 15_000,
  hostAttestationWindowMs: 1_000,
});
const authority: HostRequestAuthority = {
  endpoint: { hostId: metadata.hostId, websocketUrl: metadata.websocketUrl },
  bearer: new MutableBearerLease(credentials.token, credentials.user.id),
  abortSignal: abort.signal,
};
try {
  const response = await client.request("host.status", {}, authority);
  console.log(JSON.stringify({ ok: true, response }));
} finally {
  abort.abort();
}
TS
HOME="$TEST_HOME" bun .traycer-local-probe-host.ts \
  "$PID_FILE" "$TEST_HOME/.traycer/cli/credentials" \
  | tee /tmp/traycer-host-rpc.json
grep -q '"ok":true' /tmp/traycer-host-rpc.json

cleanup_host
HOST_PID=""
rm -f .traycer-local-create-identity.ts .traycer-local-probe-host.ts
cat "$TEST_HOME/.traycer/local-identity/network-events.jsonl" || true
if grep -HE 'connect\([^\n]*(AF_INET|AF_INET6)' /tmp/traycer-host-network.trace* \
  | grep -Ev '127\.0\.0\.1|::1|0\.0\.0\.0|::ffff:127\.'; then
  echo "External network connection detected during Host smoke test" >&2
  false
fi

# Build and inspect the AppImage.
(
  cd clients/desktop
  CSC_IDENTITY_AUTO_DISCOVERY=false bun run build:app
  bun run prepack:check-cli
  bun run prepack:check-icons
  bun run prepack:check-tray
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    bun x electron-builder --linux AppImage --x64 --publish never
  APPIMAGE="$(find release -maxdepth 1 -name '*.AppImage' -type f -print -quit)"
  test -n "$APPIMAGE"
  chmod +x "$APPIMAGE"
  rm -rf squashfs-root
  "$APPIMAGE" --appimage-extract >/tmp/appimage-extract.log
  test -x squashfs-root/resources/cli/linux-x64/traycer
  test -s squashfs-root/resources/cli/linux-x64/host-runtime-linux-x64.tar.gz
  tar -tzf squashfs-root/resources/cli/linux-x64/host-runtime-linux-x64.tar.gz \
    | grep -q '^host-runtime/traycer-local-preload.cjs$'
  rm -rf squashfs-root
)

# Produce a complete source archive that also contains the staged runtime.
git add -f clients/desktop/resources/cli/linux-x64
git commit -m "build: stage verified local runtime for source archive"
git archive --format=zip --prefix=rolaand-traycer-local/ \
  -o "$ROOT/rolaand-traycer-local-source.zip" HEAD

mkdir -p "$ARTIFACTS/app" "$ARTIFACTS/source" "$ARTIFACTS/report"
APPIMAGE="$(find clients/desktop/release -maxdepth 1 -name '*.AppImage' -type f -print -quit)"
cp "$APPIMAGE" "$ARTIFACTS/app/Rolaand-Traycer-Local-x86_64.AppImage"
cp LOCAL_ONLY_NOTES.md "$ARTIFACTS/app/"
cp "$ROOT/rolaand-traycer-local-source.zip" "$ARTIFACTS/source/"
cp LOCAL_ONLY_NOTES.md "$ARTIFACTS/source/"
{
  echo "Source repository: Rolaand-Jayz/Rolaand-traycer"
  echo "Source base: 0ed93ea2a4f0f8a680ba65211b97cbd7d7a16257"
  echo "Released Host version: $HOST_VERSION"
  echo "Released Host SHA-256: $HOST_SHA256"
  echo "Workspace compile: passed"
  echo "Focused regression tests: passed"
  echo "Authenticated local Host RPC: passed"
  echo "Host external-network trace audit: passed"
  echo "AppImage resource inspection: passed"
} > "$ARTIFACTS/report/BUILD_VALIDATION.txt"
sha256sum "$ARTIFACTS/app"/* > "$ARTIFACTS/app/SHA256SUMS.txt"
sha256sum "$ARTIFACTS/source"/* > "$ARTIFACTS/source/SHA256SUMS.txt"
cp "$ARTIFACTS/report/BUILD_VALIDATION.txt" "$ARTIFACTS/app/"
cp "$ARTIFACTS/report/BUILD_VALIDATION.txt" "$ARTIFACTS/source/"

trap - ERR EXIT
cleanup_host
printf 'Rolaand Traycer Local build completed successfully.\n'
