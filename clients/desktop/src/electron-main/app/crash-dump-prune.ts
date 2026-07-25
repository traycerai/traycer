import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { log } from "./logger";

// Mirrors WSL's own crash-collection file-count cap. Crashpad prunes its
// database too, but only at a loose ceiling (128 MB / age based); this keeps
// a repeatedly-crashing environment (e.g. one crash per overnight sleep
// under WSL) bounded to a handful of recent minidumps regardless of how many
// sessions it takes to notice. Deliberately platform-neutral (settled in
// review): dump-count growth is not WSL-specific, and the newest ten are all
// diagnostics ever needs - Sentry uploads recent dumps when enabled.
export const MAX_RETAINED_CRASH_DUMP_FILES = 10;

export interface CrashDumpFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Newest-first retention: keeps the `maxRetained` most recent dumps (the
 * ones Sentry may still be uploading, and the ones worth attaching to a
 * fresh bug report) and returns the older remainder for deletion.
 */
export function selectCrashDumpsToPrune(
  files: readonly CrashDumpFile[],
  maxRetained: number,
): string[] {
  return [...files]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(maxRetained)
    .map((file) => file.path);
}

/**
 * Bounds the on-disk crashpad minidump backlog under
 * `app.getPath("crashDumps")`. With uploads disabled or unreachable, crash
 * reports otherwise accumulate until crashpad's own loose prune threshold.
 * Touches only `*.dmp` report files - crashpad's database metadata recovers
 * gracefully from a missing report. Best-effort by design: it runs inside a
 * `timed` boot step whose boundary already logs a failure without aborting
 * startup, and per-file errors just leave that file for the next launch.
 */
export async function pruneStaleCrashDumps(): Promise<void> {
  const root = app.getPath("crashDumps");
  // Absent until the first crash ever recorded - nothing to prune.
  const entries = await readdir(root, {
    withFileTypes: true,
    recursive: true,
  }).catch(() => null);
  if (entries === null) {
    return;
  }
  const dumpPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".dmp"))
    .map((entry) => join(entry.parentPath, entry.name));
  if (dumpPaths.length <= MAX_RETAINED_CRASH_DUMP_FILES) {
    return;
  }
  const files = await Promise.all(
    dumpPaths.map((path) =>
      stat(path).then(
        (stats): CrashDumpFile => ({ path, mtimeMs: stats.mtimeMs }),
        (): null => null,
      ),
    ),
  );
  const toPrune = selectCrashDumpsToPrune(
    files.filter((file): file is CrashDumpFile => file !== null),
    MAX_RETAINED_CRASH_DUMP_FILES,
  );
  const results = await Promise.all(
    toPrune.map((path) =>
      unlink(path).then(
        () => true,
        () => false,
      ),
    ),
  );
  log.info("[crash-dump-prune] pruned stale crash dumps", {
    found: dumpPaths.length,
    pruned: results.filter(Boolean).length,
    maxRetained: MAX_RETAINED_CRASH_DUMP_FILES,
  });
}
