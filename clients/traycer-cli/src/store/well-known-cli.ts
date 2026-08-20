import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Environment } from "../runner/environment";
import { cliInstallHomeDir } from "./paths";

// The well-known per-environment CLI binary location,
// `<cliInstallHomeDir>/bin/traycer[.exe]`.
//
// This path is a CONTRACT with the host daemon: the host's
// `resolveCliExecutablePath` (traycer-host, update-reconciler) shells the
// CLI for doctor / update / service-status EXCLUSIVELY at this path - it
// reads neither the CLI manifest nor $PATH. An install whose binary lives
// anywhere else (npm global, brew cellar, hand-placed `~/.local/bin`) is
// invisible to the host until something stages this slot, which is what
// `stageWellKnownCliBinary` below exists for.
//
// Mirrors what Desktop's `cliBinDir()` / `cliBinaryName()` helpers and the
// dev orchestrator's per-run `cliBinDir` (scripts/dev-desktop.js,
// `buildDevDesktopRunPaths`) agree on. Windows uses `.exe` for SEA
// binaries; `.cmd` wrappers (dev orchestrator on Windows) are NOT included
// here - Windows service registration goes through Scheduled Tasks via
// `windows.ts`, which has its own convention.
export function wellKnownCliBinaryPath(environment: Environment): string {
  const binaryName = process.platform === "win32" ? "traycer.exe" : "traycer";
  return join(cliInstallHomeDir(environment), "bin", binaryName);
}

export type WellKnownCliStageOutcome =
  // The binary already IS the well-known slot; nothing to do. This guard is
  // what keeps a Desktop-staged slot binary intact when something anchors
  // the slot path itself - without it, staging would replace the real
  // binary with a copy of itself mid-flight.
  | { readonly staged: "already-well-known"; readonly wellKnownPath: string }
  // The slot now holds a fresh COPY of the binary's bytes.
  | { readonly staged: "staged"; readonly wellKnownPath: string }
  // Best-effort failure: the caller's primary contract (manifest write,
  // service registration against the real binary) still holds; only the
  // host's view through this slot stays degraded. Callers surface this.
  | {
      readonly staged: "failed";
      readonly wellKnownPath: string;
      readonly errorName: string;
      readonly errorMessage: string;
    };

// Stage the well-known CLI slot with a COPY of the bytes at `binaryPath`.
// Never throws: staging is an availability upgrade layered on top of the
// caller's primary write, so failure is data, not an abort.
//
// A copy, deliberately NOT a symlink - keep this in lockstep with
// Desktop's `installBundledCli` (clients/desktop .../cli/cli-discovery.ts),
// which is the sibling writer of this same slot and learned both lessons
// in the field:
//
//   - Its POSIX slot used to be a symlink; any target remove/replace left
//     a DANGLING link that lstat still shows while exec fails ENOENT. A
//     copy cannot dangle - if the anchored binary later moves or dies,
//     the slot keeps serving the last-anchored bytes (the accepted
//     stale-but-functional worst case) instead of taking the host's CLI
//     access and the registered service down with it. Freshness is
//     event-driven, not link-driven: every writer of live CLI bytes
//     (mark-source / re-anchor, both `cli upgrade` swap paths, the
//     packaged self-invocation fallback) re-stages this slot.
//   - On Windows the slot binary is routinely the RUNNING image (the
//     registered service launches from it), which holds a delete lock but
//     allows RENAME: move the old image aside, copy into the now-free
//     name, and sweep `.old-*` leftovers once their processes exit.
//
// The staging name is per-invocation (pid + uuid): a fixed temp name is
// shared mutable state between concurrent installers, and rename() is only
// atomic with respect to a source nobody else is writing.
export async function stageWellKnownCliBinary(opts: {
  readonly environment: Environment;
  readonly binaryPath: string;
}): Promise<WellKnownCliStageOutcome> {
  const wellKnownPath = wellKnownCliBinaryPath(opts.environment);
  const source = resolve(opts.binaryPath);
  if (resolve(wellKnownPath) === source) {
    return { staged: "already-well-known", wellKnownPath };
  }
  const staging = `${wellKnownPath}.staging-${process.pid}-${randomUUID()}`;
  // Non-null once the Windows branch has moved a pre-existing slot binary
  // out of the stable name. Between that rename and the publish below the
  // slot does not exist, so a publish failure must put the old binary BACK -
  // see the restore in the catch.
  let asidePath: string | null = null;
  try {
    await mkdir(dirname(wellKnownPath), { recursive: true });
    await copyFile(source, staging);
    if (process.platform === "win32") {
      await sweepAsideSlotBinaries(wellKnownPath);
      asidePath = await renameSlotBinaryAside(wellKnownPath);
    } else {
      await chmod(staging, 0o755);
    }
    await rename(staging, wellKnownPath);
    return { staged: "staged", wellKnownPath };
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    // The whole point of copying rather than linking is that the slot
    // degrades to stale-but-functional, never to absent. Publishing is the
    // one window where that can be violated on Windows: the old image is
    // aside and the new one never landed (antivirus holding the staged
    // file, a racing installer, a transient share violation). Put the old
    // binary back so an already-registered service and the host daemon keep
    // launching the CLI they were launching before this attempt.
    if (asidePath !== null) {
      await rename(asidePath, wellKnownPath).catch(() => undefined);
    }
    const named = error instanceof Error ? error : new Error(String(error));
    return {
      staged: "failed",
      wellKnownPath,
      errorName: named.name,
      errorMessage: named.message,
    };
  }
}

// Move a (possibly running) slot binary out of the stable name so a new
// copy can take its place, returning where it went so a failed publish can
// restore it. Windows-only concern: a running image blocks delete and
// rename-onto, but permits being renamed itself. A missing binary (first
// staging) is not an error and yields `null` - there is nothing to restore.
//
// The pid suffix keeps two installers staging in the same millisecond from
// renaming onto each other's aside file and destroying one of them; the
// sweep below matches on the `.old-` prefix alone, so the extra segment
// costs nothing.
async function renameSlotBinaryAside(
  wellKnownPath: string,
): Promise<string | null> {
  const asidePath = `${wellKnownPath}.old-${Date.now()}-${process.pid}`;
  try {
    await rename(wellKnownPath, asidePath);
    return asidePath;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

// Best-effort sweep of `<binary>.old-<ts>` leftovers from previous
// rename-aside stagings. Deletion fails while a renamed image is still
// executing; those unlock once the old process exits, so each staging pass
// retries the whole set and the trash never outlives one host generation
// by much.
async function sweepAsideSlotBinaries(wellKnownPath: string): Promise<void> {
  const dir = dirname(wellKnownPath);
  const prefix = `${basename(wellKnownPath)}.old-`;
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    await rm(join(dir, entry), { force: true }).catch(() => undefined);
  }
}
