import { randomUUID } from "node:crypto";
import { readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ILogger } from "../logger";
import { renameWithRetry } from "./rename-retry";

// Generic `<target>.<infix>*` sibling helpers shared by every tree that
// keeps rename-aside copies next to a canonical target - `install/`
// (`.old-*`, ticket 2's install-trash parity) and `staged/` (`.old-*` for
// pure litter/restore candidates, `.dead-*` for invalidated ones; ticket
// 1's `stage-reconcile.ts`). Standalone (not defined in either
// `install.ts` or `stage-reconcile.ts`) so both of those can depend on it
// without depending on each other - `install.ts`'s own aside handling
// otherwise couldn't reuse `stage-reconcile.ts`'s layered-invalidation
// logic without an import cycle (that module already imports
// `renameWithRetry`/`currentInstallPlatform`/etc. FROM `install.ts`).

// `<target>.<infix>*` siblings, newest first. The suffix is a
// `Date.now()` millisecond timestamp (see the various rename-aside call
// sites) - lexicographic sort on same-length numeric strings is a numeric
// sort, and will remain so until the year 2286 (13-digit epoch ms).
export async function listAsideDirsNewestFirst(
  target: string,
  infix: string,
): Promise<string[]> {
  const parent = dirname(target);
  const prefix = `${basename(target)}.${infix}`;
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(parent, name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

// Invalidates an aside that is being discarded outright (pure litter) -
// never for a crash-recovery restore path, which needs the sidecar intact
// to validate a candidate.
//
// Layered so a partial failure at any one layer can never leave a fully
// intact, restorable aside behind (the vulnerability a single "unlink
// sidecar, then best-effort rm" pass still had: if BOTH steps failed -
// e.g. a Windows open-file handle blocking both - the aside stayed
// completely valid and could resurrect an explicitly-replaced tree on a
// later reconcile pass):
//   1. Rename to a `.dead-*` sibling - a structurally different name the
//      `.old-*` prefix scan never matches, so a restore step can never
//      again consider it a candidate regardless of what happens to its
//      contents afterward. `sweepDeadAsideDirs` deletes `.dead-*` siblings
//      best-effort on a later pass. Tried first (and via
//      `renameWithRetry`) because a directory rename has the best chance
//      of succeeding even when a file inside is open.
//   2. If the rename fails, unlink just the sidecar - without it, the
//      corresponding record reader returns null and the deletion/restore
//      rules both treat the directory as invalid, so it's unrecoverable
//      even though it lingers (and will still be listed as `.old-*`
//      litter, swept by a subsequent reconcile pass's own retry of this
//      same function).
//   3. If that also fails, attempt a full recursive removal.
//   4. If every layer fails, log and accept the residual - the aside
//      remains a fully valid, in principle restorable candidate. Narrow:
//      it requires rename, unlink, AND rm to all independently fail on
//      the same directory.
export async function invalidateAsideDir(
  target: string,
  aside: string,
  sidecarFilename: string,
  logger: ILogger,
): Promise<boolean> {
  // Unique per call: batch callers invalidate several asides in one tick
  // (`Promise.all`), and a shared timestamp-only name would make every
  // rename after the first hit ENOTEMPTY and burn its retry budget.
  const deadAside = `${target}.dead-${Date.now()}-${randomUUID()}`;
  try {
    await renameWithRetry(aside, deadAside);
    return true;
  } catch {
    // Fall through to layer 2.
  }
  try {
    await unlink(join(aside, sidecarFilename));
    return true;
  } catch {
    // Fall through to layer 3.
  }
  try {
    await rm(aside, { recursive: true, force: true });
    return true;
  } catch {
    logger.warn(
      "Could not invalidate a replaced aside on any layer - it remains restorable",
      { aside },
    );
    return false;
  }
}

function listDeadAsideDirsNewestFirst(target: string): Promise<string[]> {
  return listAsideDirsNewestFirst(target, "dead-");
}

// Best-effort cleanup of `.dead-*` siblings `invalidateAsideDir` leaves
// behind on its (common) layer-1 success path - deliberately not deleted
// synchronously there, since the whole point of layer 1 is to succeed via
// a cheap rename even when the directory's contents can't yet be removed
// (e.g. a Windows file handle still closing).
export async function sweepDeadAsideDirs(target: string): Promise<void> {
  const dead = await listDeadAsideDirsNewestFirst(target);
  await Promise.all(
    dead.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}
