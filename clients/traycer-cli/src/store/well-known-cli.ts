import { copyFile, mkdir, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  // The binary already IS the well-known slot; nothing to do.
  | { readonly staged: "already-well-known"; readonly wellKnownPath: string }
  // A symlink at the well-known slot now points at the binary. Stays fresh
  // across in-place upgrades (`cli upgrade` swaps bytes at the same path).
  | { readonly staged: "symlink"; readonly wellKnownPath: string }
  // Windows fallback when symlinks are unavailable (needs Developer Mode or
  // elevation there): a byte copy. Refreshed on every mark-source /
  // re-anchor; between those it can serve a stale-but-functional CLI, the
  // same worst case `host update`'s preserved-invocation contract accepts.
  | { readonly staged: "copy"; readonly wellKnownPath: string }
  // Best-effort failure: the caller's primary contract (manifest write,
  // service registration against the real binary) still holds; only the
  // host's view through this slot stays degraded. Callers surface this.
  | {
      readonly staged: "failed";
      readonly wellKnownPath: string;
      readonly errorName: string;
      readonly errorMessage: string;
    };

// Stage the well-known CLI slot to point at `binaryPath`, atomically
// (create under a temp name, rename over whatever is there - a previous
// symlink, a stale copy, or a Desktop-staged binary being re-anchored
// away from). Never throws: staging is an availability upgrade layered on
// top of the caller's primary write, so failure is data, not an abort.
export async function stageWellKnownCliBinary(opts: {
  readonly environment: Environment;
  readonly binaryPath: string;
}): Promise<WellKnownCliStageOutcome> {
  const wellKnownPath = wellKnownCliBinaryPath(opts.environment);
  const target = resolve(opts.binaryPath);
  if (resolve(wellKnownPath) === target) {
    return { staged: "already-well-known", wellKnownPath };
  }
  const staging = `${wellKnownPath}.staging-${process.pid}`;
  try {
    await mkdir(dirname(wellKnownPath), { recursive: true });
    await rm(staging, { force: true });
    try {
      await symlink(target, staging);
      await rename(staging, wellKnownPath);
      return { staged: "symlink", wellKnownPath };
    } catch (symlinkError) {
      // Windows without Developer Mode / elevation refuses file symlinks
      // (EPERM). A copy keeps the contract; elsewhere symlink failure is
      // a real error worth reporting as-is.
      if (process.platform !== "win32") throw symlinkError;
      await rm(staging, { force: true });
      await copyFile(target, staging);
      await rename(staging, wellKnownPath);
      return { staged: "copy", wellKnownPath };
    }
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    const named = error instanceof Error ? error : new Error(String(error));
    return {
      staged: "failed",
      wellKnownPath,
      errorName: named.name,
      errorMessage: named.message,
    };
  }
}
