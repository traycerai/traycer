import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { HOST_READY_EXTENDED_TIMEOUT_MS } from "@traycer/protocol/host/lifecycle-constants";
import {
  canReachHostWebsocketUrl,
  isCurrentHostWebsocketUrl,
  sleep,
} from "./host-lifecycle";
import { TraycerCliError } from "../cli/traycer-cli";

// Host-readiness + CLI-error helpers used by the post-auth host-ensure
// flow (ipc/host-ensure-ipc.ts). The CLI's `host ensure` can report
// success the moment the service is registered/started, but the OS service
// manager still has to spawn the host and have it publish its pid metadata
// + bind its WS port.
// We poll that on-disk source of truth before telling the renderer the
// host is ready, so the gate never flips to "ready" against a host that
// hasn't actually bound its port yet.

// Sized to absorb a slow shell init + native-module/Prisma load on first
// spawn (mirrors HostLifecycle.HOST_READY_TIMEOUT_MS).
export const HOST_READY_TIMEOUT_MS = 60_000;
export const HOST_READY_POLL_MS = 250;
// Re-export so ensure/callers share one constant with the protocol budget.
export { HOST_READY_EXTENDED_TIMEOUT_MS };

export interface HostReadinessResult {
  readonly ready: boolean;
  readonly version: string | null;
  readonly pid: number | null;
  readonly reason: string;
}

/**
 * Pre-action snapshot of host.log + pid.json used to decide readiness
 * extension / terminal fail-fast (Finding F). Captured before the start
 * or register action so post-baseline evidence is attributable to *this*
 * attempt. Identity-aware: records dev/inode + size, never a bare length
 * (log rotation lands `starting` at offset 0 of a fresh file).
 */
export interface HostSpawnEvidenceBaseline {
  readonly logPath: string;
  readonly logExists: boolean;
  readonly logSize: number;
  readonly logDev: number | null;
  readonly logIno: number | null;
  readonly pidPath: string;
  readonly pidExists: boolean;
  readonly pidMtimeMs: number | null;
  readonly pid: number | null;
  // Set only after CLI ensure returns. New-format markers earlier than this
  // cannot belong to its final Windows `/Run`; legacy markers retain baseline
  // correlation for compatibility with older supervisors.
  readonly markerAuthoritySinceMs: number | null;
}

export interface WaitForHostReadyOptions {
  // null disables spawn-evidence extension / terminal fail-fast (darwin
  // SMAppService path today; T6 wires launchctl-gated authority there).
  readonly spawnEvidenceBaseline: HostSpawnEvidenceBaseline | null;
  // Absolute hard cap when extending past `timeoutMs` on post-baseline
  // spawn evidence. Ignored when baseline is null.
  readonly extendedTimeoutMs: number;
}

export async function captureHostSpawnEvidenceBaseline(
  logPath: string,
  pidPath: string,
): Promise<HostSpawnEvidenceBaseline> {
  const [logStat, pidStat, pidSnapshot] = await Promise.all([
    statOrNull(logPath),
    statOrNull(pidPath),
    readPidMetadataForReady(pidPath),
  ]);
  return {
    logPath,
    logExists: logStat !== null,
    logSize: logStat === null ? 0 : logStat.size,
    logDev: logStat === null ? null : logStat.dev,
    logIno: logStat === null ? null : logStat.ino,
    pidPath,
    pidExists: pidStat !== null,
    pidMtimeMs: pidStat === null ? null : pidStat.mtimeMs,
    pid: pidSnapshot === null ? null : pidSnapshot.pid,
    markerAuthoritySinceMs: null,
  };
}

// Poll the environment-scoped pid metadata file until the host publishes a
// well-formed, reachable websocket URL or the timeout elapses. `pidPath`
// and `pollIntervalMs` are explicit so callers (and tests) control the
// filesystem dependency.
//
// `skipPid` is the respawn path's hook to distinguish the new host from
// the still-running old one: SMAppService's `unregister` is asynchronous
// to launchd's teardown, so for a brief window after we kick the cycle
// the old process is still bound to its port and its still-on-disk
// pid.json still validates. Passing the pre-respawn pid here makes the
// poll skip matching snapshots so we only return `ready` once the new
// host has actually published. Callers in the install/sign-in flow,
// where there cannot be a stale pid yet, pass `null`.
//
// When `options.spawnEvidenceBaseline` is set (win32), on base-budget
// expiry the poll extends up to `extendedTimeoutMs` if post-baseline
// spawn evidence is present (pid metadata / `starting` marker). A
// post-baseline terminal marker fails immediately with its reason.
export async function waitForHostReady(
  timeoutMs: number,
  pidPath: string,
  pollIntervalMs: number,
  skipPid: number | null,
  options: WaitForHostReadyOptions,
): Promise<HostReadinessResult> {
  const baseDeadline = Date.now() + timeoutMs;
  const hardDeadline =
    options.spawnEvidenceBaseline === null
      ? baseDeadline
      : Date.now() + options.extendedTimeoutMs;
  let lastReason = "pid metadata never appeared";
  let extended = false;
  const markerReader =
    options.spawnEvidenceBaseline === null
      ? null
      : createPostBaselineMarkerReader(options.spawnEvidenceBaseline);

  while (true) {
    const now = Date.now();
    if (now >= hardDeadline) {
      return { ready: false, version: null, pid: null, reason: lastReason };
    }
    if (now >= baseDeadline && !extended) {
      if (options.spawnEvidenceBaseline === null) {
        return { ready: false, version: null, pid: null, reason: lastReason };
      }
      const evidence = await inspectPostBaselineSpawnEvidence(
        options.spawnEvidenceBaseline,
        markerReader,
      );
      if (evidence.kind === "terminal") {
        return {
          ready: false,
          version: null,
          pid: null,
          reason: evidence.reason,
        };
      }
      if (evidence.kind === "none") {
        return { ready: false, version: null, pid: null, reason: lastReason };
      }
      // Post-baseline spawn evidence (starting marker or fresh pid
      // metadata): keep polling up to the extended hard cap.
      extended = true;
      lastReason = `${lastReason}; extending wait on ${evidence.reason}`;
    }

    const snapshot = await readPidMetadataForReady(pidPath);
    if (snapshot === null) {
      lastReason = "pid metadata not yet published";
    } else if (skipPid !== null && snapshot.pid === skipPid) {
      lastReason = `old host pid ${skipPid} still bound; waiting for replacement`;
    } else if (!isCurrentHostWebsocketUrl(snapshot.websocketUrl)) {
      lastReason = `websocket URL ${snapshot.websocketUrl} does not match the committed host WS shape`;
    } else if (!(await canReachHostWebsocketUrl(snapshot.websocketUrl))) {
      lastReason = `websocket URL ${snapshot.websocketUrl} is not yet reachable`;
    } else {
      return {
        ready: true,
        version: snapshot.version,
        pid: snapshot.pid,
        reason: "ready",
      };
    }

    // Fail-fast on a post-baseline terminal marker even before base
    // budget expires: the host already died for a known reason.
    if (options.spawnEvidenceBaseline !== null) {
      const evidence = await inspectPostBaselineSpawnEvidence(
        options.spawnEvidenceBaseline,
        markerReader,
      );
      if (evidence.kind === "terminal") {
        return {
          ready: false,
          version: null,
          pid: null,
          reason: evidence.reason,
        };
      }
    }

    await sleep(pollIntervalMs);
  }
}

type PostBaselineEvidence =
  | { readonly kind: "none" }
  | { readonly kind: "spawn"; readonly reason: string }
  | { readonly kind: "terminal"; readonly reason: string };

const TERMINAL_PHASES = new Set([
  "exited",
  "crashed",
  "killed",
  "failed-to-spawn",
]);

async function inspectPostBaselineSpawnEvidence(
  baseline: HostSpawnEvidenceBaseline,
  markerReader: PostBaselineMarkerReader | null,
): Promise<PostBaselineEvidence> {
  const markers = (
    markerReader === null ? [] : await markerReader.read()
  ).filter((entry) => isMarkerInAuthorityWindow(entry, baseline));
  const currentAttempt = findNewestIdentifiedAttempt(markers);
  if (currentAttempt !== null) {
    if (currentAttempt.phase === "terminal") {
      return {
        kind: "terminal",
        reason: terminalMarkerReason(currentAttempt.marker),
      };
    }
    const terminal = markers
      .slice(currentAttempt.index + 1)
      .find(
        (entry) =>
          markerIdentity(entry) === currentAttempt.identity &&
          TERMINAL_PHASES.has(entry.phase),
      );
    if (terminal !== undefined) {
      return { kind: "terminal", reason: terminalMarkerReason(terminal) };
    }
    return { kind: "spawn", reason: "post-baseline starting marker" };
  }
  for (let i = markers.length - 1; i >= 0; i--) {
    const entry = markers[i];
    if (entry === undefined) continue;
    if (TERMINAL_PHASES.has(entry.phase)) {
      return {
        kind: "terminal",
        reason: terminalMarkerReason(entry),
      };
    }
  }
  for (let i = markers.length - 1; i >= 0; i--) {
    const entry = markers[i];
    if (entry !== undefined && entry.phase === "starting") {
      return { kind: "spawn", reason: "post-baseline starting marker" };
    }
  }
  const pidEvidence = await hasPostBaselinePidMetadata(baseline);
  if (pidEvidence) {
    return { kind: "spawn", reason: "post-baseline pid metadata" };
  }
  return { kind: "none" };
}

interface ParsedMarker {
  readonly timestampMs: number | null;
  readonly phase: string;
  readonly fields: Record<string, string>;
}

interface PostBaselineMarkerReader {
  read(): Promise<readonly ParsedMarker[]>;
}

const MARKER_LINE_RE = /^\[([^\]]+)\] phase=(\w[\w-]*)(?:\s+(.*))?$/;

function createPostBaselineMarkerReader(
  baseline: HostSpawnEvidenceBaseline,
): PostBaselineMarkerReader {
  let offset: number | null = null;
  let dev: number | null = null;
  let ino: number | null = null;
  let pending = "";
  let entries: readonly ParsedMarker[] = [];

  return {
    read: async (): Promise<readonly ParsedMarker[]> => {
      let handle: FileHandle;
      try {
        handle = await open(baseline.logPath, "r");
      } catch {
        return entries;
      }
      try {
        const info = await handle.stat();
        const sameFileIdentity =
          offset !== null && dev === info.dev && ino === info.ino;
        const shrankOpenFile =
          sameFileIdentity && offset !== null && info.size < offset;
        const sameOpenFile = sameFileIdentity && !shrankOpenFile;
        const readOffset = shrankOpenFile
          ? 0
          : sameOpenFile && offset !== null
            ? offset
            : offsetForBaseline(baseline, info);
        if (!sameOpenFile) {
          pending = "";
          entries = [];
        }
        dev = info.dev;
        ino = info.ino;
        offset = info.size;
        if (info.size <= readOffset) return entries;
        const length = info.size - readOffset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, readOffset);
        offset = readOffset + bytesRead;
        const text = pending + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = text.split(/\r?\n/);
        pending = lines.pop() ?? "";
        const fresh: ParsedMarker[] = [];
        for (const line of lines) {
          if (line.length === 0) continue;
          const match = MARKER_LINE_RE.exec(line);
          if (match === null) continue;
          fresh.push({
            timestampMs: Date.parse(match[1] ?? ""),
            phase: match[2] ?? "",
            fields: parseMarkerFields(match[3] ?? ""),
          });
        }
        entries = [...entries, ...fresh].slice(-64);
        return entries;
      } finally {
        await handle.close();
      }
    },
  };
}

function isMarkerInAuthorityWindow(
  marker: ParsedMarker,
  baseline: HostSpawnEvidenceBaseline,
): boolean {
  const identity = markerIdentity(marker);
  if (identity === null || baseline.markerAuthoritySinceMs === null)
    return true;
  return (
    marker.timestampMs !== null &&
    marker.timestampMs >= baseline.markerAuthoritySinceMs
  );
}

function markerIdentity(marker: ParsedMarker): string | null {
  const attempt = marker.fields.attempt;
  const supervisorPid = marker.fields.supervisorPid;
  if (
    typeof attempt !== "string" ||
    attempt.length === 0 ||
    typeof supervisorPid !== "string" ||
    supervisorPid.length === 0
  ) {
    return null;
  }
  return `${attempt}:${supervisorPid}`;
}

function findNewestIdentifiedAttempt(markers: readonly ParsedMarker[]): {
  readonly index: number;
  readonly identity: string;
  readonly phase: "starting" | "terminal";
  readonly marker: ParsedMarker;
} | null {
  let newestStarting: {
    readonly index: number;
    readonly identity: string;
    readonly phase: "starting";
    readonly marker: ParsedMarker;
  } | null = null;
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (marker === undefined || marker.phase !== "starting") continue;
    const identity = markerIdentity(marker);
    if (identity !== null) {
      newestStarting = { index, identity, phase: "starting", marker };
      break;
    }
  }
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (
      marker === undefined ||
      marker.phase !== "failed-to-spawn" ||
      (newestStarting !== null && index <= newestStarting.index)
    ) {
      continue;
    }
    const identity = markerIdentity(marker);
    if (identity !== null) {
      return { index, identity, phase: "terminal", marker };
    }
  }
  return newestStarting;
}

function parseMarkerFields(rest: string): Record<string, string> {
  // Minimal key=value parser matching the CLI bootstrap-log grammar well
  // enough to recover `error` / `code` / `signal` for fail-fast reasons.
  // Full fidelity lives in traycer-cli's bootstrap-log (separate bundle).
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i] ?? "")) i++;
    if (i >= rest.length) break;
    const eqIdx = rest.indexOf("=", i);
    if (eqIdx === -1) break;
    const key = rest.slice(i, eqIdx);
    let valueStart = eqIdx + 1;
    let value: string;
    if (rest[valueStart] === '"') {
      valueStart++;
      let valueEnd = valueStart;
      let unescaped = "";
      while (valueEnd < rest.length) {
        const ch = rest[valueEnd] ?? "";
        if (ch === '"' && rest[valueEnd + 1] === '"') {
          unescaped += '"';
          valueEnd += 2;
          continue;
        }
        if (ch === '"') break;
        unescaped += ch;
        valueEnd++;
      }
      value = unescaped;
      i = valueEnd + 1;
    } else {
      let valueEnd = valueStart;
      while (valueEnd < rest.length && !/\s/.test(rest[valueEnd] ?? "")) {
        valueEnd++;
      }
      value = rest.slice(valueStart, valueEnd);
      i = valueEnd;
    }
    fields[key] = value;
  }
  return fields;
}

function offsetForBaseline(
  baseline: HostSpawnEvidenceBaseline,
  info: { readonly size: number; readonly dev: number; readonly ino: number },
): number {
  if (!baseline.logExists) return 0;
  if (
    baseline.logDev !== null &&
    baseline.logIno !== null &&
    (info.dev !== baseline.logDev || info.ino !== baseline.logIno)
  ) {
    return 0;
  }
  if (info.size < baseline.logSize) return 0;
  return baseline.logSize;
}

async function hasPostBaselinePidMetadata(
  baseline: HostSpawnEvidenceBaseline,
): Promise<boolean> {
  const info = await statOrNull(baseline.pidPath);
  if (info === null) return false;
  const snapshot = await readPidMetadataForReady(baseline.pidPath);
  if (snapshot === null) return false;
  if (!baseline.pidExists) {
    return true;
  }
  return (
    baseline.pidMtimeMs !== null &&
    info.mtimeMs > baseline.pidMtimeMs &&
    snapshot.pid !== baseline.pid
  );
}

function terminalMarkerReason(marker: ParsedMarker): string {
  const error = marker.fields.error;
  if (typeof error === "string" && error.length > 0) {
    return `host ${marker.phase}: ${error}`;
  }
  const code = marker.fields.code;
  if (typeof code === "string" && code.length > 0) {
    return `host ${marker.phase} (code=${code})`;
  }
  const signal = marker.fields.signal;
  if (typeof signal === "string" && signal.length > 0) {
    return `host ${marker.phase} (signal=${signal})`;
  }
  return `host ${marker.phase}`;
}

async function statOrNull(
  path: string,
): Promise<{ size: number; dev: number; ino: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return {
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

// Distinct from host-lifecycle's `readPidMetadata`: readiness does not
// require `hostId` to be present yet - a freshly spawned host can publish
// its port/version before the full identity record, and we only need
// version/pid/websocketUrl to confirm the WS endpoint is up.
async function readPidMetadataForReady(path: string): Promise<{
  readonly version: string;
  readonly pid: number;
  readonly websocketUrl: string;
} | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.version !== "string" ||
    typeof obj.pid !== "number" ||
    typeof obj.websocketUrl !== "string"
  ) {
    return null;
  }
  return { version: obj.version, pid: obj.pid, websocketUrl: obj.websocketUrl };
}

// Shape of the `traycer host install`/`ensure` terminal payload we
// inspect for a service-registration failure. Mirrors the CLI producers
// (commands/host-install.ts, commands/host-ensure.ts).
export interface HostEnsureResultPayload {
  readonly version?: string;
  readonly running?: boolean;
  readonly registered?: boolean;
  readonly action?: string;
  readonly serviceLifecycle?: {
    readonly priorServiceState?: string;
    readonly stoppedBeforeSwap?: boolean;
    readonly postSwapAction?: string;
    readonly postSwapError?: string | null;
  } | null;
}

export interface ServiceLifecycleSnapshot {
  readonly priorServiceState: string | null;
  readonly postSwapAction: string | null;
  readonly postSwapError: string | null;
}

export function readServiceLifecycle(
  payload: HostEnsureResultPayload | null | undefined,
): ServiceLifecycleSnapshot {
  const lifecycle = payload?.serviceLifecycle ?? null;
  if (lifecycle === null || typeof lifecycle !== "object") {
    return {
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    };
  }
  const postSwapErrorRaw = lifecycle.postSwapError;
  const postSwapError =
    typeof postSwapErrorRaw === "string" && postSwapErrorRaw.length > 0
      ? postSwapErrorRaw
      : null;
  return {
    priorServiceState:
      typeof lifecycle.priorServiceState === "string"
        ? lifecycle.priorServiceState
        : null,
    postSwapAction:
      typeof lifecycle.postSwapAction === "string"
        ? lifecycle.postSwapAction
        : null,
    postSwapError,
  };
}

/**
 * Read the ensure payload's `running` flag. Returns null when the field is
 * absent/malformed so callers can distinguish "CLI said not running" from
 * "older CLI didn't report the flag".
 */
export function readEnsureRunning(
  payload: HostEnsureResultPayload | null | undefined,
): boolean | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload.running !== "boolean") return null;
  return payload.running;
}

export type HostEnsureErrorKind =
  | "offline"
  | "signature"
  | "host-not-ready"
  | "service-registration"
  | "host-busy"
  | "unknown";

export interface HostEnsureError {
  readonly kind: HostEnsureErrorKind;
  readonly message: string;
  readonly code: string | null;
}

// Map a CLI failure into a stable, renderer-friendly error. The renderer
// surfaces `message` in the host gate's unavailable/Doctor card.
export function categorizeHostCliError(err: unknown): HostEnsureError {
  if (err instanceof TraycerCliError) {
    if (
      err.code === "E_NETWORK" ||
      err.code === "E_OFFLINE" ||
      err.code === "E_DOWNLOAD_FAILED" ||
      err.code === "E_REGISTRY_UNAVAILABLE" ||
      // Older CLI builds used this spelling. Keep it as a compatibility alias
      // while the current CLI contract uses E_REGISTRY_UNAVAILABLE.
      err.code === "E_REGISTRY_UNREACHABLE"
    ) {
      return {
        kind: "offline",
        message:
          "Traycer needs to download the host to finish setting up. Check your network connection and try again.",
        code: err.code,
      };
    }
    if (
      err.code === "E_SIGNATURE_INVALID" ||
      err.code === "E_CHECKSUM_MISMATCH" ||
      err.code === "E_HOST_VERIFY_FAILED"
    ) {
      return {
        kind: "signature",
        message:
          "The downloaded host failed verification (signature, checksum, or size mismatch). This is a security check - please reinstall Traycer or contact support.",
        code: err.code,
      };
    }
    if (err.code === "E_HOST_BUSY") {
      return {
        kind: "host-busy",
        message:
          "The host has work in progress, so it was not restarted. Checking whether this build can keep using it…",
        code: err.code,
      };
    }
    return { kind: "unknown", message: err.message, code: err.code };
  }
  return {
    kind: "unknown",
    message: err instanceof Error ? err.message : String(err),
    code: null,
  };
}
