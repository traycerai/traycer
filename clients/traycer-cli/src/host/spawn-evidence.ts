import type { Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import {
  parseBootstrapLogLine,
  type BootstrapLogEntry,
  type BootstrapPhase,
} from "./bootstrap-log";
import { readHostPidMetadata, type HostPidMetadata } from "./pid-metadata";
import type { Environment } from "../runner/environment";
import { bootstrapLogPath, hostPidMetadataPath } from "../store/paths";

/**
 * File-identity-aware spawn-evidence substrate (Finding F).
 *
 * Markers and pid.json carry no attempt ownership for older CLIs, so evidence
 * correlates against a **pre-action baseline** captured before the decision
 * point. The baseline records file identity (dev/inode when available) **and**
 * length — never a bare length. `host-log-rotation.ts` rotates an oversized
 * dead-host log *before* start, landing `starting` at offset 0 of a fresh
 * file; a length-only baseline would miss that marker. Replacement,
 * truncation, or any size decrease ⇒ new log, read from zero.
 *
 * win32 uses this substrate for `/Run` verification and readiness extension.
 * T6 (darwin cycle state machine) reuses the same baseline/reader for
 * marker diagnostics — cycle-skip authority stays launchctl-only.
 */

export interface LogFileBaseline {
  readonly path: string;
  /** False when the path did not exist (or was unreadable) at capture. */
  readonly exists: boolean;
  readonly size: number;
  /** `stat.dev` when the file existed; null when missing. */
  readonly dev: number | null;
  /** `stat.ino` when the file existed; null when missing. */
  readonly ino: number | null;
  readonly mtimeMs: number | null;
}

export interface PidMetadataBaseline {
  readonly path: string;
  readonly exists: boolean;
  readonly mtimeMs: number | null;
  readonly pid: number | null;
}

export interface SpawnEvidenceBaseline {
  readonly log: LogFileBaseline;
  readonly pidMetadata: PidMetadataBaseline;
}

export type SpawnEvidenceKind =
  "pid-metadata" | "starting-marker" | "terminal-marker";

export interface SpawnEvidence {
  readonly kind: SpawnEvidenceKind;
  readonly reason: string;
  readonly marker: BootstrapLogEntry | null;
  readonly pid: number | null;
}

export interface SpawnEvidenceReader {
  collect(environment: Environment | undefined): Promise<SpawnEvidence | null>;
}

export interface SpawnEvidenceFileDeps {
  openRead(path: string): Promise<FileHandle>;
}

const defaultSpawnEvidenceFileDeps: SpawnEvidenceFileDeps = {
  openRead: (path) => open(path, "r"),
};

let spawnEvidenceFileDeps: SpawnEvidenceFileDeps = defaultSpawnEvidenceFileDeps;

/** Test-only seam for deterministic path-stat → open rotation interleavings. */
export function setSpawnEvidenceFileDepsForTests(
  deps: SpawnEvidenceFileDeps | null,
): void {
  spawnEvidenceFileDeps = deps ?? defaultSpawnEvidenceFileDeps;
}

const TERMINAL_PHASES: ReadonlySet<BootstrapPhase> = new Set([
  "exited",
  "crashed",
  "killed",
  "failed-to-spawn",
]);

export async function captureLogFileBaseline(
  path: string,
): Promise<LogFileBaseline> {
  try {
    const info = await stat(path);
    return {
      path,
      exists: true,
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return {
      path,
      exists: false,
      size: 0,
      dev: null,
      ino: null,
      mtimeMs: null,
    };
  }
}

export async function capturePidMetadataBaseline(
  path: string,
  environment: Environment | undefined,
): Promise<PidMetadataBaseline> {
  let mtimeMs: number | null = null;
  let exists = false;
  try {
    const info = await stat(path);
    exists = true;
    mtimeMs = info.mtimeMs;
  } catch {
    exists = false;
    mtimeMs = null;
  }
  const metadata = await readHostPidMetadata(environment);
  return {
    path,
    exists,
    mtimeMs,
    pid: metadata === null ? null : metadata.pid,
  };
}

export async function captureSpawnEvidenceBaseline(
  environment: Environment | undefined,
): Promise<SpawnEvidenceBaseline> {
  const logPath = bootstrapLogPath(environment);
  const pidPath = hostPidMetadataPath(environment);
  const [log, pidMetadata] = await Promise.all([
    captureLogFileBaseline(logPath),
    capturePidMetadataBaseline(pidPath, environment),
  ]);
  return { log, pidMetadata };
}

/**
 * Resolve the byte offset from which post-baseline content should be read.
 * Returns 0 when the live file is a replacement/truncation relative to the
 * baseline (new identity, size decrease, or baseline file was missing and
 * a file now exists — the new file is read from zero either way).
 */
export async function resolvePostBaselineReadOffset(
  baseline: LogFileBaseline,
): Promise<number> {
  let info: Stats;
  try {
    info = await stat(baseline.path);
  } catch {
    // File gone: nothing to read.
    return 0;
  }
  return offsetForBaseline(baseline, info);
}

function offsetForBaseline(baseline: LogFileBaseline, info: Stats): number {
  if (!baseline.exists) return 0;
  if (
    baseline.dev !== null &&
    baseline.ino !== null &&
    (info.dev !== baseline.dev || info.ino !== baseline.ino)
  ) {
    return 0;
  }
  return info.size < baseline.size ? 0 : baseline.size;
}

/**
 * Read the host log slice written after the baseline, identity-aware.
 * Handles rotation that lands new markers at offset 0 of a fresh file.
 */
export async function readPostBaselineLogText(
  baseline: LogFileBaseline,
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await spawnEvidenceFileDeps.openRead(baseline.path);
  } catch {
    return "";
  }
  try {
    const info = await handle.stat();
    // Identity and offset must come from the opened handle. A path stat before
    // open can observe the old log while open lands on a rotated replacement.
    const offset = offsetForBaseline(baseline, info);
    if (info.size <= offset) return "";
    const length = info.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export function createPostBaselineMarkerReader(baseline: LogFileBaseline): {
  readonly read: () => Promise<readonly BootstrapLogEntry[]>;
} {
  let offset: number | null = null;
  let dev: number | null = null;
  let ino: number | null = null;
  let pending = "";
  let entries: readonly BootstrapLogEntry[] = [];

  return {
    read: async (): Promise<readonly BootstrapLogEntry[]> => {
      let handle: FileHandle;
      try {
        handle = await spawnEvidenceFileDeps.openRead(baseline.path);
      } catch {
        return [];
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
        entries = [
          ...entries,
          ...parseBootstrapMarkersFromText(lines.join("\n")),
        ].slice(-64);
        return entries;
      } finally {
        await handle.close();
      }
    },
  };
}

export function parseBootstrapMarkersFromText(
  text: string,
): readonly BootstrapLogEntry[] {
  const entries: BootstrapLogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parsed = parseBootstrapLogLine(line);
    if (parsed !== null) entries.push(parsed);
  }
  return entries;
}

export async function readPostBaselineMarkers(
  baseline: LogFileBaseline,
): Promise<readonly BootstrapLogEntry[]> {
  const text = await readPostBaselineLogText(baseline);
  return parseBootstrapMarkersFromText(text);
}

/**
 * True when pid.json was written after the baseline in a way that proves a
 * fresh host published metadata — never mere file presence of a stale
 * pre-baseline pid.json.
 *
 * Rules:
 * - baseline missing → any well-formed pid.json is evidence
 * - baseline present → mtime must advance AND pid must change
 */
export async function hasPostBaselinePidMetadata(
  baseline: PidMetadataBaseline,
  environment: Environment | undefined,
): Promise<{
  readonly evidence: boolean;
  readonly metadata: HostPidMetadata | null;
  readonly mtimeMs: number | null;
}> {
  let mtimeMs: number | null = null;
  try {
    const info = await stat(baseline.path);
    mtimeMs = info.mtimeMs;
  } catch {
    return { evidence: false, metadata: null, mtimeMs: null };
  }
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) {
    return { evidence: false, metadata: null, mtimeMs };
  }
  if (!baseline.exists) {
    return { evidence: true, metadata, mtimeMs };
  }
  const mtimeAdvanced = baseline.mtimeMs !== null && mtimeMs > baseline.mtimeMs;
  const pidChanged = metadata.pid !== baseline.pid;
  return {
    evidence: mtimeAdvanced && pidChanged,
    metadata,
    mtimeMs,
  };
}

export function findPostBaselineStartingMarker(
  markers: readonly BootstrapLogEntry[],
): BootstrapLogEntry | null {
  for (let i = markers.length - 1; i >= 0; i--) {
    const entry = markers[i];
    if (entry !== undefined && entry.phase === "starting") return entry;
  }
  return null;
}

export function findPostBaselineTerminalMarker(
  markers: readonly BootstrapLogEntry[],
): BootstrapLogEntry | null {
  for (let i = markers.length - 1; i >= 0; i--) {
    const entry = markers[i];
    if (entry !== undefined && TERMINAL_PHASES.has(entry.phase)) return entry;
  }
  return null;
}

export function terminalMarkerReason(marker: BootstrapLogEntry): string {
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

/**
 * Collect post-baseline spawn evidence for win32 `/Run` verification and
 * readiness extension. Order of preference:
 * 1. terminal marker (spawn attempted but died — still counts as spawn
 *    evidence for the short start-verify window; readiness treats it as
 *    fail-now separately)
 * 2. starting marker
 * 3. post-baseline pid metadata
 */
export async function collectSpawnEvidence(
  baseline: SpawnEvidenceBaseline,
  environment: Environment | undefined,
): Promise<SpawnEvidence | null> {
  const markers = await readPostBaselineMarkers(baseline.log);
  const terminal = findPostBaselineTerminalMarker(markers);
  if (terminal !== null) {
    return {
      kind: "terminal-marker",
      reason: terminalMarkerReason(terminal),
      marker: terminal,
      pid: null,
    };
  }
  const starting = findPostBaselineStartingMarker(markers);
  if (starting !== null) {
    return {
      kind: "starting-marker",
      reason: "post-baseline starting marker",
      marker: starting,
      pid: null,
    };
  }
  const pid = await hasPostBaselinePidMetadata(
    baseline.pidMetadata,
    environment,
  );
  if (pid.evidence && pid.metadata !== null) {
    return {
      kind: "pid-metadata",
      reason: `pid metadata published (pid=${pid.metadata.pid})`,
      marker: null,
      pid: pid.metadata.pid,
    };
  }
  return null;
}

export function createSpawnEvidenceReader(
  baseline: SpawnEvidenceBaseline,
): SpawnEvidenceReader {
  const markerReader = createPostBaselineMarkerReader(baseline.log);
  return {
    collect: async (environment): Promise<SpawnEvidence | null> => {
      const markers = await markerReader.read();
      const terminal = findPostBaselineTerminalMarker(markers);
      if (terminal !== null) {
        return {
          kind: "terminal-marker",
          reason: terminalMarkerReason(terminal),
          marker: terminal,
          pid: null,
        };
      }
      const starting = findPostBaselineStartingMarker(markers);
      if (starting !== null) {
        return {
          kind: "starting-marker",
          reason: "post-baseline starting marker",
          marker: starting,
          pid: null,
        };
      }
      const pid = await hasPostBaselinePidMetadata(
        baseline.pidMetadata,
        environment,
      );
      if (pid.evidence && pid.metadata !== null) {
        return {
          kind: "pid-metadata",
          reason: `pid metadata published (pid=${pid.metadata.pid})`,
          marker: null,
          pid: pid.metadata.pid,
        };
      }
      return null;
    },
  };
}

/** Convenience for callers that only need a boolean. */
export async function hasPostBaselineSpawnEvidence(
  baseline: SpawnEvidenceBaseline,
  environment: Environment | undefined,
): Promise<boolean> {
  return (await collectSpawnEvidence(baseline, environment)) !== null;
}

/**
 * Sleep helper kept local so platform seams (windows start verify, readiness
 * extension) can poll without pulling a shared timer util.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
