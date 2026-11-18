import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import { describeLogError, log } from "../app/logger";

/**
 * Dedicated, append-only sink for renderer performance telemetry.
 *
 * Perf events (prefixed `[traycer-perf]` in the renderer console, see
 * `gui-app/src/lib/perf/perf-telemetry.ts`) are routed here by the window
 * factory's `console-message` handler INSTEAD of electron-log, so they land in
 * one machine-parseable NDJSON file separate from the human log.
 *
 *   File:   <userData>/traycer-perf.ndjson  (one JSON object per line)
 *   Rotate: when the file exceeds ~5 MB, rename to `traycer-perf.ndjson.1`
 *           (single backup kept) and start fresh.
 *
 * Writes are QUEUED sequentially onto a serialized append chain (mirroring the
 * discipline in `app/json-file-store.ts`) so concurrent events can't interleave
 * a half-written line. The whole path is best-effort: a write failure is logged
 * once and swallowed - it must never throw into the app.
 */

const PERF_FILE_NAME = "traycer-perf.ndjson";
const PERF_BACKUP_FILE_NAME = "traycer-perf.ndjson.1";
const MAX_PERF_FILE_BYTES = 5 * 1024 * 1024;

export type PerfFieldValue = number | string | boolean | null;

export interface PerfTelemetryEvent {
  readonly name: string;
  readonly tsMs: number;
  readonly fields: Readonly<Record<string, PerfFieldValue>>;
}

// Serialized append chain: each event awaits the prior write so lines never
// interleave. The chain always resolves (failures are caught) so a single bad
// write can't wedge the queue.
let writeChain: Promise<void> = Promise.resolve();

function perfFilePath(): string {
  return join(app.getPath("userData"), PERF_FILE_NAME);
}

async function currentSize(filePath: string): Promise<number> {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  const size = await currentSize(filePath);
  if (size < MAX_PERF_FILE_BYTES) return;
  const backup = join(dirname(filePath), PERF_BACKUP_FILE_NAME);
  // `rename` fails if the destination exists on Windows, so drop the previous
  // backup first (force ignores a missing file). Keeps exactly one backup.
  await rm(backup, { force: true });
  await rename(filePath, backup);
}

async function persist(event: PerfTelemetryEvent): Promise<void> {
  const filePath = perfFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await rotateIfNeeded(filePath);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * Queue one perf event for append. Fire-and-forget by design: it returns
 * immediately, never throws, and a failed write is logged once (not rethrown).
 */
export function appendPerfEvent(event: PerfTelemetryEvent): void {
  writeChain = writeChain
    .then(() => persist(event))
    .catch((err) => {
      log.warn("[perf-telemetry] write failed", describeLogError(err));
    });
}

/**
 * Resolve once every queued write has settled. Test seam - the app itself is
 * fire-and-forget and never awaits the chain.
 */
export function flushPerfWrites(): Promise<void> {
  return writeChain.then(() => undefined);
}
