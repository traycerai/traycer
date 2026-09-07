import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { log } from "./logger";

export const MAX_RETAINED_CRASH_DUMP_FILES = 10;

export interface CrashDumpFile {
  readonly path: string;
  readonly mtimeMs: number;
}

export function selectCrashDumpsToPrune(
  files: readonly CrashDumpFile[],
  maxRetained: number,
): string[] {
  return [...files]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(maxRetained)
    .map((file) => file.path);
}

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
