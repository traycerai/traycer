import { randomUUID } from "node:crypto";
import { readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ILogger } from "../logger";
import { renameWithRetry } from "./rename-retry";

/** Explicit compatibility verifier for non-contender cleanup callers only. */
export const legacyMutationVerifier = async (): Promise<void> => undefined;

// Generic `<target>.<infix>*` sibling helpers shared by every tree that keeps rename-aside copies next to a canonical target - `install/` (`.old-*`, ticket 2's install-trash parity) and `staged/` (`.old-*` for pure litter/restore candidates, `.dead-*` for invalidated ones; ticket 1's `stage-reconcile.ts`).
// Standalone (not defined in either `install.ts` or `stage-reconcile.ts`) so both of those can depend on it without depending on each other - `install.ts`'s own aside handling otherwise couldn't reuse `stage-reconcile.ts`'s layered-invalidation logic without an import cycle (that module already imports `renameWithRetry`/`currentInstallPlatform`/etc.

// `<target>.<infix>*` siblings, newest first.
// The suffix is a `Date.now()` millisecond timestamp (see the various rename-aside call sites) - lexicographic sort on same-length numeric strings is a numeric sort, and will remain so until the year 2286 (13-digit epoch ms).
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

// Invalidate an aside being discarded outright so a later reconcile cannot resurrect it.
export async function invalidateAsideDir(
  target: string,
  aside: string,
  sidecarFilename: string,
  logger: ILogger,
  verifyMutationCapability: () => Promise<void>,
): Promise<boolean> {
  // Unique per call: batch callers invalidate several asides in one tick (`Promise.all`), and a shared timestamp-only name would make every rename after the first hit ENOTEMPTY and burn its retry budget.
  const deadAside = `${target}.dead-${Date.now()}-${randomUUID()}`;
  // Verification deliberately sits outside the broad cleanup catches.
  // A capability loss is authority evidence, not an expected Windows handle failure, and must stop the composite rather than falling through to a later destructive layer.
  let authorityFailure: unknown | null = null;
  const verify = async (): Promise<void> => {
    try {
      await verifyMutationCapability();
    } catch (cause) {
      // `renameWithRetry` deliberately invokes its verifier before every retry.
      // Its error must not be mistaken for a Windows rename failure and trigger the following destructive fallback layer.
      authorityFailure = cause;
      throw cause;
    }
  };
  await verify();
  try {
    await renameWithRetry(aside, deadAside, verify);
    return true;
  } catch (cause) {
    if (authorityFailure !== null) throw cause;
    // Fall through to layer 2.
  }
  await verify();
  try {
    await unlink(join(aside, sidecarFilename));
    return true;
  } catch {
    // Fall through to layer 3.
  }
  await verify();
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

// Best-effort cleanup of `.dead-*` siblings `invalidateAsideDir` leaves behind on its (common) layer-1 success path - deliberately not deleted synchronously there, since the whole point of layer 1 is to succeed via a cheap rename even when the directory's contents can't yet be removed (e.g. a Windows file handle still closing).
export async function sweepDeadAsideDirs(
  target: string,
  verifyMutationCapability: () => Promise<void>,
): Promise<void> {
  const dead = await listDeadAsideDirsNewestFirst(target);
  for (const dir of dead) {
    await verifyMutationCapability();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Litter cleanup remains best-effort only for I/O failures. A verifier
      // failure above propagates and prevents another edge.
    }
  }
}
