import { rename } from "node:fs/promises";

// Windows releases a terminated process's directory/file handles
// asynchronously, so a rename issued right after the OS service stop
// (which force-kills the host tree) can still observe EBUSY/EPERM for a
// brief window even though the host is already dead. Retry a few times with
// a short backoff (~2.5s total). POSIX renames don't raise these codes, so
// this is a no-op there.
//
// Standalone (not defined in `install.ts`) so it has no dependents besides
// what it needs itself - `install.ts`, `stage-reconcile.ts`, `aside-dirs.ts`,
// and `download-stage.ts` all reuse this same Windows-safe rename for their
// own swap/restore/invalidate paths without creating an import cycle between
// them.
const RENAME_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export async function renameWithRetry(from: string, to: string): Promise<void> {
  const delaysMs = [50, 100, 200, 400, 800, 1000];
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : "";
      if (attempt >= delaysMs.length || !RENAME_RETRY_CODES.has(code)) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
