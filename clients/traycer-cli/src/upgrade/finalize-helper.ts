import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { clearPendingUpgrade, readCliManifest } from "../manifest/cli-manifest";
import type { Environment } from "../runner/environment";
import { isErrnoException } from "../runner/errors";
import { cliPostFinalizeMarkerPath, ensureCliHomeDir } from "../store/paths";
import { windowsTaskName, type ServiceLabel } from "../service";

// Pending CLI upgrade finalize - detached helper path.
//
// `traycer cli upgrade` stages a new CLI binary on disk and records
// `pendingUpgrade` in the install manifest when it can't atomically
// replace the live binary (Windows: the live `.exe` is held open by
// the current CLI process or its supervisor; cross-platform: the
// install dir is read-only). `traycer host restart` then tries to
// finalise the swap in-process between service stop and service start.
//
// That in-process attempt is sufficient on POSIX, where rename
// succeeds even on an open file. On Windows the *current* CLI process
// that's running `host restart` is itself running from the live
// .exe, so even after the host supervisor releases its lock the
// MoveFileEx in renameSync fails with EBUSY. We can't release that
// lock without exiting the CLI process.
//
// The detached helper closes that gap:
//
//   1. The CLI writes a short PowerShell (Windows) or POSIX shell
//      script to a temp path and launches it detached with the parent
//      CLI's pid as an argument.
//   2. The CLI returns its result to the caller with status
//      "scheduled-helper" and exits, releasing its lock on the live
//      binary.
//   3. The helper polls the parent pid (sub-second). Once the CLI
//      process is gone it atomically replaces the live binary
//      (`Move-Item -Force` / `mv -f`) and starts/restarts the OS
//      service.
//   4. The helper writes a marker file at
//      `~/.traycer/cli/post-finalize.json` describing the outcome
//      (swapped / swap-failed / parent-still-alive).
//   5. The next CLI invocation - Doctor, `host restart`, etc. -
//      calls `reconcilePostFinalizeMarker(environment)`, which folds the
//      marker into the install manifest (clearing pendingUpgrade and
//      updating version on success) and deletes the marker.
//
// Fail-safe: if the helper cannot complete (the script fails to
// schedule, the move fails, the OS service start fails), the marker
// either isn't written or records "swap-failed", and `pendingUpgrade`
// stays populated. Doctor continues to emit `CLI_UPGRADE_PENDING` and
// Settings/Doctor surface it via the existing card.

export interface ScheduleHelperOptions {
  readonly environment: Environment;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly serviceLabel: ServiceLabel;
  // pid of the current CLI process. The helper waits for this pid to
  // exit before attempting the binary swap.
  readonly parentPid: number;
  // Maximum seconds the helper will wait for parent exit before giving
  // up and writing a "parent-still-alive" marker.
  readonly parentExitTimeoutSeconds: number;
  // Platform the helper script targets. Threaded through explicitly
  // (instead of reading os.platform()) so tests can validate the
  // Windows code path from a POSIX dev machine.
  readonly platform: NodeJS.Platform;
  // Test seam - replace the actual spawn() / writeFileSync() calls
  // with stubs that record arguments instead of touching the OS.
  readonly spawnImpl: SpawnImpl;
  readonly writeImpl: WriteImpl;
}

// Narrow surface of `child_process.spawn` we use. Tests substitute a
// stub that records the spawn call without launching anything.
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { readonly pid: number | undefined; unref: () => void };

export type WriteImpl = (path: string, body: string) => Promise<void>;

export interface ScheduleHelperResult {
  readonly status: "scheduled" | "skipped" | "failed";
  readonly platform: NodeJS.Platform;
  readonly scriptPath: string | null;
  readonly markerPath: string;
  readonly helperPid: number | null;
  readonly errorMessage: string | null;
}

// Real implementations used by `host restart` in production. Exposed
// for tests that want to round-trip a real helper invocation; the
// scheduling tests substitute their own.
export const defaultSpawnImpl: SpawnImpl = (command, args, options) => {
  const child = spawn(command, [...args], options);
  return {
    pid: child.pid,
    unref: () => child.unref(),
  };
};

export const defaultWriteImpl: WriteImpl = async (path, body) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { encoding: "utf8", mode: 0o700 });
};

// Schedule the detached helper. Returns a structured result so the
// host-restart command can surface scheduling outcomes in its
// NDJSON payload without throwing on best-effort failures. Throws
// only for programmer errors (e.g. an unsupported platform reached
// this path).
export async function scheduleFinalizationHelper(
  opts: ScheduleHelperOptions,
): Promise<ScheduleHelperResult> {
  const platform = opts.platform;
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  // Remove any stale marker from a prior helper attempt so the next
  // reconcile reads only the fresh outcome.
  try {
    await unlink(markerPath);
  } catch {
    // best-effort; absent file is fine
  }
  await ensureCliHomeDir(opts.environment);

  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") {
    return {
      status: "skipped",
      platform,
      scriptPath: null,
      markerPath,
      helperPid: null,
      errorMessage: `finalize helper does not support platform '${platform}'`,
    };
  }

  const scriptPath = makeHelperScriptPath(opts.environment, platform);
  const scriptBody =
    platform === "win32"
      ? renderWindowsHelperScript({
          parentPid: opts.parentPid,
          stagedBinaryPath: opts.stagedBinaryPath,
          livePath: opts.livePath,
          serviceLabel: opts.serviceLabel,
          markerPath,
          timeoutSeconds: opts.parentExitTimeoutSeconds,
        })
      : renderPosixHelperScript({
          parentPid: opts.parentPid,
          stagedBinaryPath: opts.stagedBinaryPath,
          livePath: opts.livePath,
          serviceLabel: opts.serviceLabel,
          markerPath,
          timeoutSeconds: opts.parentExitTimeoutSeconds,
        });

  try {
    await opts.writeImpl(scriptPath, scriptBody);
  } catch (err) {
    return {
      status: "failed",
      platform,
      scriptPath,
      markerPath,
      helperPid: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const spawnDescriptor = buildSpawnDescriptor({
    platform,
    scriptPath,
  });
  try {
    const child = opts.spawnImpl(
      spawnDescriptor.command,
      spawnDescriptor.args,
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // Inherit env so PATH-based PowerShell/sh resolution works.
        env: process.env,
      },
    );
    child.unref();
    return {
      status: "scheduled",
      platform,
      scriptPath,
      markerPath,
      helperPid: child.pid ?? null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      status: "failed",
      platform,
      scriptPath,
      markerPath,
      helperPid: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function makeHelperScriptPath(
  environment: Environment,
  platform: NodeJS.Platform,
): string {
  const ext = platform === "win32" ? ".ps1" : ".sh";
  const stamp = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  return join(tmpdir(), `traycer-cli-finalize-${environment}-${stamp}${ext}`);
}

function buildSpawnDescriptor(opts: {
  readonly platform: NodeJS.Platform;
  readonly scriptPath: string;
}): { readonly command: string; readonly args: readonly string[] } {
  if (opts.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        opts.scriptPath,
      ],
    };
  }
  return { command: "/bin/sh", args: [opts.scriptPath] };
}

// PowerShell helper. Polls `Get-Process -Id <pid>` until the parent
// CLI exits, then `Move-Item -Force` swaps the binary and
// `Start-Service` / schtasks /Run kicks the supervisor back up.
function renderWindowsHelperScript(opts: {
  readonly parentPid: number;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly serviceLabel: ServiceLabel;
  readonly markerPath: string;
  readonly timeoutSeconds: number;
}): string {
  // The Windows service controller registers a Scheduled Task per
  // ServiceLabel - schtasks /Run is the cross-version equivalent of
  // Start-Service for a per-user task. We `try` Start-Service for
  // forward-compat with future installs and fall back to schtasks.
  const taskName = windowsTaskName(opts.serviceLabel);
  return `# traycer-cli pending-upgrade finalize helper (Windows)
$ErrorActionPreference = "Continue"
$ParentPid = ${opts.parentPid}
$StagedBinary = ${psString(opts.stagedBinaryPath)}
$LiveBinary = ${psString(opts.livePath)}
$MarkerPath = ${psString(opts.markerPath)}
$TaskName = ${psString(taskName)}
$ServiceId = ${psString(opts.serviceLabel.id)}
$TimeoutSec = ${opts.timeoutSeconds}

function Write-Marker([hashtable]$Payload) {
  $Payload["attemptedAt"] = (Get-Date).ToUniversalTime().ToString("o")
  $Payload["livePath"] = $LiveBinary
  $Payload["stagedBinaryPath"] = $StagedBinary
  $json = $Payload | ConvertTo-Json -Depth 6
  $dir = Split-Path -Parent $MarkerPath
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tmp = "$MarkerPath.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -Force -LiteralPath $tmp -Destination $MarkerPath
}

# 1. Wait for parent CLI process to exit.
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  Write-Marker @{
    status = "parent-still-alive";
    errorMessage = "parent CLI process $ParentPid did not exit within $TimeoutSec seconds";
  }
  exit 0
}

# 2. Swap the live binary. Move-Item -Force calls MoveFileEx with
# MOVEFILE_REPLACE_EXISTING; atomic on NTFS for files on the same
# volume - which they are, since cli-upgrade staged the binary
# next to the live path on the same filesystem.
try {
  Move-Item -Force -LiteralPath $StagedBinary -Destination $LiveBinary
} catch {
  Write-Marker @{
    status = "swap-failed";
    errorMessage = $_.Exception.Message;
  }
  exit 0
}

# 3. Best-effort service start. The swap is already committed; if
# we can't start the service the existing SERVICE_STOPPED Doctor
# issue will surface it.
$serviceErr = $null
try {
  Start-Service -Name $ServiceId -ErrorAction Stop
} catch {
  $serviceErr = $_.Exception.Message
  try {
    & schtasks.exe /Run /TN $TaskName | Out-Null
    if ($LASTEXITCODE -eq 0) { $serviceErr = $null }
  } catch {
    # Keep the original Start-Service error message.
  }
}

Write-Marker @{
  status = "swapped";
  serviceStartError = $serviceErr;
}
exit 0
`;
}

function psString(value: string): string {
  // Single-quoted PowerShell strings are literal; escape embedded
  // single quotes by doubling them. The helper paths come from
  // process.pid / tmpdir() / manifest fields so this is defensive.
  return `'${value.replace(/'/g, "''")}'`;
}

// POSIX helper. We don't strictly need a detached helper on POSIX
// (rename succeeds on open files there), but the same shape is
// useful for read-only-install cases and lets test rigs exercise
// the marker reconciler on a POSIX dev machine.
function renderPosixHelperScript(opts: {
  readonly parentPid: number;
  readonly stagedBinaryPath: string;
  readonly livePath: string;
  readonly serviceLabel: ServiceLabel;
  readonly markerPath: string;
  readonly timeoutSeconds: number;
}): string {
  return `#!/usr/bin/env sh
# traycer-cli pending-upgrade finalize helper (POSIX)
set -u
PARENT_PID=${shString(String(opts.parentPid))}
STAGED=${shString(opts.stagedBinaryPath)}
LIVE=${shString(opts.livePath)}
MARKER=${shString(opts.markerPath)}
SERVICE_ID=${shString(opts.serviceLabel.id)}
TIMEOUT=${shString(String(opts.timeoutSeconds))}

# JSON construction: prefer python3 (universally available on standard
# macOS / Linux release runners, including hosted GitHub runners) so
# trusted-comment edge characters in STAGED / LIVE never produce a
# malformed marker. Falls back to a strict-escape printf path that
# rejects \\b\\f\\r and replaces \\ " \\n \\t per RFC 8259 §7.
write_marker() {
  status="$1"; errmsg="$2"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$(dirname "$MARKER")"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.dumps({"status":sys.argv[1],"attemptedAt":sys.argv[2],"livePath":sys.argv[3],"stagedBinaryPath":sys.argv[4],"errorMessage":(sys.argv[5] or None),"serviceStartError":None}))' \\
      "$status" "$ts" "$LIVE" "$STAGED" "$errmsg" > "$MARKER.tmp"
  else
    safe_status="$(strict_escape "$status")"
    safe_ts="$(strict_escape "$ts")"
    safe_live="$(strict_escape "$LIVE")"
    safe_staged="$(strict_escape "$STAGED")"
    safe_err="$(json_str "$errmsg")"
    printf '{"status":"%s","attemptedAt":"%s","livePath":"%s","stagedBinaryPath":"%s","errorMessage":%s,"serviceStartError":null}\\n' \\
      "$safe_status" "$safe_ts" "$safe_live" "$safe_staged" "$safe_err" > "$MARKER.tmp"
  fi
  mv -f "$MARKER.tmp" "$MARKER"
}

# Escape backslash, double-quote, newline, tab. Anything else passes
# through. Sufficient for the absolute filesystem paths the helper sees
# in practice.
strict_escape() {
  printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e ':a;N;$!ba;s/\\n/\\\\n/g' -e 's/\\t/\\\\t/g'
}

json_str() {
  if [ -z "$1" ]; then
    printf 'null'
  else
    printf '"%s"' "$(strict_escape "$1")"
  fi
}

deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$PARENT_PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$PARENT_PID" 2>/dev/null; then
  write_marker "parent-still-alive" "parent CLI process $PARENT_PID did not exit within $TIMEOUT seconds"
  exit 0
fi

if mv -f "$STAGED" "$LIVE"; then
  write_marker "swapped" ""
else
  write_marker "swap-failed" "mv -f $STAGED $LIVE failed"
  exit 0
fi

# Best-effort service restart. macOS LaunchAgents and systemd user
# units both expose the label-as-id; failure here is non-fatal -
# the Doctor SERVICE_STOPPED issue surfaces it.
if command -v launchctl >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$SERVICE_ID" >/dev/null 2>&1 || true
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user restart "$SERVICE_ID" >/dev/null 2>&1 || true
fi
exit 0
`;
}

function shString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type PostFinalizeMarkerStatus =
  "swapped" | "swap-failed" | "parent-still-alive";

export interface PostFinalizeMarker {
  readonly status: PostFinalizeMarkerStatus;
  readonly attemptedAt: string;
  readonly livePath: string;
  readonly stagedBinaryPath: string;
  readonly errorMessage: string | null;
  readonly serviceStartError: string | null;
}

function isPostFinalizeMarker(value: unknown): value is PostFinalizeMarker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (
    obj.status !== "swapped" &&
    obj.status !== "swap-failed" &&
    obj.status !== "parent-still-alive"
  ) {
    return false;
  }
  if (typeof obj.attemptedAt !== "string") return false;
  if (typeof obj.livePath !== "string") return false;
  if (typeof obj.stagedBinaryPath !== "string") return false;
  if (obj.errorMessage !== null && typeof obj.errorMessage !== "string") {
    return false;
  }
  if (
    obj.serviceStartError !== null &&
    obj.serviceStartError !== undefined &&
    typeof obj.serviceStartError !== "string"
  ) {
    return false;
  }
  return true;
}

export type ReconcileOutcome =
  | { readonly status: "no-marker" }
  | { readonly status: "marker-invalid"; readonly errorMessage: string }
  | {
      readonly status: "applied-swapped";
      readonly previousVersion: string;
      readonly version: string;
      readonly serviceStartError: string | null;
    }
  | {
      readonly status: "applied-swap-failed";
      readonly errorMessage: string;
    }
  | { readonly status: "applied-parent-still-alive" };

// Read any pending post-finalize marker the detached helper wrote and
// fold its outcome into the CLI install manifest. Idempotent - the
// marker is unlinked after a successful read, so repeated invocations
// are no-ops.
//
// Called from the host-restart command (to apply marker effects
// before the next stop/start cycle) and from the Doctor engine (so
// Doctor's reported state reflects the most recent helper outcome).
export async function reconcilePostFinalizeMarker(opts: {
  readonly environment: Environment;
}): Promise<ReconcileOutcome> {
  const markerPath = cliPostFinalizeMarkerPath(opts.environment);
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { status: "no-marker" };
    }
    return {
      status: "marker-invalid",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    await safeUnlink(markerPath);
    return {
      status: "marker-invalid",
      errorMessage: `marker JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!isPostFinalizeMarker(parsed)) {
    await safeUnlink(markerPath);
    return {
      status: "marker-invalid",
      errorMessage: "marker payload does not match expected shape",
    };
  }
  const manifest = await readCliManifest(opts.environment);
  if (manifest === null || manifest.pendingUpgrade === null) {
    // The helper completed but the manifest no longer references a
    // pending upgrade - either another finalize path beat us to it or
    // the manifest was rewritten. Drop the marker either way.
    await safeUnlink(markerPath);
    if (parsed.status === "swapped") {
      // No manifest change to make, but report success so callers can
      // log the outcome.
      return {
        status: "applied-swapped",
        previousVersion: manifest?.version ?? "",
        version: manifest?.version ?? "",
        serviceStartError: parsed.serviceStartError ?? null,
      };
    }
    return parsed.status === "swap-failed"
      ? {
          status: "applied-swap-failed",
          errorMessage: parsed.errorMessage ?? "swap failed (no error message)",
        }
      : { status: "applied-parent-still-alive" };
  }
  const pending = manifest.pendingUpgrade;

  if (parsed.status === "swapped") {
    // The helper completed the swap; promote the manifest's
    // pendingUpgrade.version to the top-level fields and clear
    // pendingUpgrade. Helper has already moved the staged binary
    // onto the live path on disk, so binaryPath stays the same.
    const previousVersion = manifest.version;
    await clearPendingUpgrade(opts.environment, {
      version: pending.version,
      binaryPath: manifest.binaryPath,
      installedAt: new Date().toISOString(),
    });
    await safeUnlink(markerPath);
    return {
      status: "applied-swapped",
      previousVersion,
      version: pending.version,
      serviceStartError: parsed.serviceStartError ?? null,
    };
  }
  if (parsed.status === "swap-failed") {
    // Helper tried and the swap itself failed. Leave pendingUpgrade
    // in place so Doctor still surfaces it; consume the marker.
    await safeUnlink(markerPath);
    return {
      status: "applied-swap-failed",
      errorMessage: parsed.errorMessage ?? "swap failed (no error message)",
    };
  }
  // parent-still-alive - helper gave up waiting. Manifest unchanged.
  await safeUnlink(markerPath);
  return { status: "applied-parent-still-alive" };
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort; absent file is fine
  }
}
