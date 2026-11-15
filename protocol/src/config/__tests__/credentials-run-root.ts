import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    credentialsTestRoot: string;
  }
}

const WORKERS_DIRECTORY = ".workers";

export function createRunRoot(): string {
  return mkdtempSync(join(tmpdir(), "traycer-cred-run-"));
}

/**
 * A credentials store keeps writing after `dispose()` returns: its disk reserve
 * refills and its continuation retry drain nothing at dispose. A case's
 * directory therefore stays until the run root goes, and the root goes only
 * once every worker that used it has exited. That holds for the default forks
 * pool, where each worker is its own process; under a pool that runs workers
 * in the main process, the recorded process is the one running the removal and
 * the root is kept.
 */
export function createCaseWorkDir(prefix: string): string {
  const root = inject("credentialsTestRoot");
  recordWorker(root, process.pid);
  return mkdtempSync(join(root, prefix));
}

export function recordWorker(root: string, pid: number): void {
  mkdirSync(join(root, WORKERS_DIRECTORY), { recursive: true });
  writeFileSync(join(root, WORKERS_DIRECTORY, String(pid)), "");
}

export function workerRecords(root: string): string[] {
  return readdirSync(join(root, WORKERS_DIRECTORY));
}

/** Ends a case without removing its directory, which a writer may still hold. */
export function endCaseWorkDir(workDir: string): void {
  chmodSync(workDir, 0o700);
}

export type RunRootRemoval =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: string };

export function processExists(pid: number): boolean | "unknown" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "ESRCH") return false;
    }
    return "unknown";
  }
}

/**
 * Removes the run root only when every recorded worker process is provably
 * gone: `kill(pid, 0)` reports no such process for each. A live, unreadable or
 * unrecognised record keeps the root, as does a failed removal. A reused pid
 * keeps it too, which only leaves an unused directory in the OS temp dir.
 */
export function removeRunRootOnceWorkersGone(root: string): RunRootRemoval {
  let recorded: string[];
  try {
    recorded = workerRecords(root);
  } catch (error) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    if (!missing) {
      return { removed: false, reason: "worker records unreadable" };
    }
    recorded = [];
  }
  for (const name of recorded) {
    const pid = Number(name);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { removed: false, reason: `unrecognised worker record ${name}` };
    }
    if (processExists(pid) !== false) {
      return { removed: false, reason: `worker ${pid} may still be running` };
    }
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    return { removed: false, reason: "removal failed" };
  }
  return { removed: true };
}
