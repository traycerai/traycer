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

// Exported so the install swap's error reporting can distinguish "the
// lock-contention class this retry exists for" from a genuine I/O failure
// without duplicating the code list.
export function isRetryableRenameCode(code: string): boolean {
  return RENAME_RETRY_CODES.has(code);
}

const DEFAULT_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800, 1000];

// A caller-tuned retry: `delaysMs` sets both the attempt count and the
// backoff, and `onRetry` (when non-null) runs after each retryable failure
// before the backoff sleep - the install swap uses it to re-kill lingering
// host processes whose handles are exactly what made the rename fail. The
// hook is best-effort: a throw from it is swallowed so it can never mask
// the rename's own error.
//
// `maxTotalMs` is a wall-clock ceiling across ALL attempts, hooks, and
// backoff sleeps. The schedule alone does not bound the retry when the
// hook is slow - the Windows re-kill can spend a 10s WMI scan plus a 30s
// taskkill per pass on a degraded machine, stretching a ~24s schedule
// into minutes while the caller holds the cli-lock with the service
// stopped. Once the ceiling is exceeded, the next retryable failure is
// thrown as final. Null bounds the retry by the schedule alone.
export interface RenameRetryPlan {
  readonly delaysMs: readonly number[];
  readonly onRetry: (() => Promise<void>) | null;
  readonly maxTotalMs: number | null;
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  await renameWithRetryPlan(from, to, {
    delaysMs: DEFAULT_DELAYS_MS,
    onRetry: null,
    maxTotalMs: null,
  });
}

export async function renameWithRetryPlan(
  from: string,
  to: string,
  plan: RenameRetryPlan,
): Promise<void> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? String((cause as { code?: unknown }).code)
          : "";
      if (attempt >= plan.delaysMs.length || !RENAME_RETRY_CODES.has(code)) {
        throw cause;
      }
      if (
        plan.maxTotalMs !== null &&
        Date.now() - startedAt >= plan.maxTotalMs
      ) {
        throw cause;
      }
      if (plan.onRetry !== null) {
        await plan.onRetry().catch(() => undefined);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, plan.delaysMs[attempt]),
      );
    }
  }
}
