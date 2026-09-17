import { appLogger } from "@/lib/logger";

/**
 * Backoff for a failed leg of a desktop bridge channel, and the length of the
 * array IS the budget.
 */
export const RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];

export interface BoundedRetry {
  /** Cancel anything pending, reset the budget, and attempt again now. */
  restart(): void;
  cancel(): void;
}

/**
 * Run `attempt` until it resolves, at most {@link RETRY_DELAYS_MS} times.
 *
 * Bounded because a channel that is broken rather than blipping must not spin
 * forever. Giving up restores the pre-retry behaviour for that leg rather than
 * anything worse, and the budget resets on the next `restart`.
 *
 * CANCELLING IS ABOUT THE ATTEMPT, NOT ONLY ABOUT THE TIMER. The pending
 * `attempt()` promise is the half a `clearTimeout` cannot reach, and it is the
 * half that outlives teardown: an invoke still in flight when the window
 * uninstalls rejects afterwards, lands in the catch, and arms a timer that
 * reports through a channel nobody owns any more. Each attempt therefore
 * carries the generation it was started in, and a completion whose generation
 * has moved on is not this retry's news - neither its failure (no timer) nor
 * its success (no budget reset, which would otherwise hand a stale resolve the
 * power to un-exhaust a live leg's budget).
 *
 * Shared by `cross-window-epic-visibility.ts` (both legs) and
 * `desktop-window-visibility.ts` (the startup snapshot); `label` names the leg
 * in the warning.
 */
export function createBoundedRetry(
  label: string,
  attempt: () => Promise<void>,
): BoundedRetry {
  let timer: number | null = null;
  let failures = 0;
  let generation = 0;
  const cancel = (): void => {
    generation += 1;
    if (timer === null) return;
    window.clearTimeout(timer);
    timer = null;
  };
  const run = (): void => {
    const attemptGeneration = generation;
    const superseded = (): boolean => attemptGeneration !== generation;
    void attempt()
      .then(() => {
        if (superseded()) return;
        failures = 0;
      })
      .catch((error: unknown) => {
        if (superseded()) return;
        appLogger.warn(`[epic-visibility] ${label} failed`, {
          error: error instanceof Error ? error.message : "unknown error",
          attempt: failures,
        });
        if (failures >= RETRY_DELAYS_MS.length) return;
        const delayMs = RETRY_DELAYS_MS[failures];
        failures += 1;
        timer = window.setTimeout(() => {
          timer = null;
          run();
        }, delayMs);
      });
  };
  return {
    restart: (): void => {
      cancel();
      failures = 0;
      run();
    },
    cancel,
  };
}
