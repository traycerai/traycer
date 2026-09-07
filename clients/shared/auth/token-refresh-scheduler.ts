/**
 * Proactive access-token refresh scheduler shared by the Desktop renderer and the CLI/monitor.
 * This scheduler closes that gap: it decodes the access token's `exp` and arms a timer to invoke the same single-flight `revalidate` shortly before expiry, then re-arms off whichever token the refresh settled on.
 */
import { readAccessTokenExpiryMs } from "./jwt-exp";

/** Refresh this long before the token's `exp`. */
export const DEFAULT_REFRESH_LEAD_MS = 10 * 60_000;

export const DEFAULT_REFRESH_MIN_DELAY_MS = 60_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ProactiveRefreshScheduler {
  /** (Re-)arm off the current token. Idempotent; safe to call on every rotation. */
  start(): void;
  /** Cancel any pending refresh and stop re-arming. */
  stop(): void;
  /**
   * Re-evaluate now (drop the sleep-frozen timer, refresh if inside the lead window, else re-arm) - call on device wake.
   */
  notifyResumed(): void;
}

export interface ProactiveRefreshSchedulerOptions<THandle> {
  /** Current access token, or `null` when signed out (disarms the scheduler). */
  readonly getToken: () => string | null;
  /** Single-flight refresh that rotates + persists the bearer. */
  readonly revalidate: () => Promise<unknown>;
  readonly now: () => number;
  readonly setTimer: (handler: () => void, ms: number) => THandle;
  readonly clearTimer: (handle: THandle) => void;
  readonly leadMs: number;
  readonly minDelayMs: number;
  /** Optional diagnostic sink; `null` to stay silent. */
  readonly onDiagnostic: ((message: string) => void) | null;
}

export function createProactiveRefreshScheduler<THandle>(
  options: ProactiveRefreshSchedulerOptions<THandle>,
): ProactiveRefreshScheduler {
  let handle: THandle | null = null;
  let stopped = true;

  const clearScheduled = (): void => {
    if (handle !== null) {
      options.clearTimer(handle);
      handle = null;
    }
  };

  const arm = (): void => {
    clearScheduled();
    if (stopped) {
      return;
    }
    const token = options.getToken();
    if (token === null || token.length === 0) {
      return;
    }
    const expMs = readAccessTokenExpiryMs(token);
    if (expMs === null) {
      options.onDiagnostic?.(
        "proactive token refresh disabled: access token carries no decodable exp",
      );
      return;
    }
    const delay = Math.min(
      Math.max(expMs - options.leadMs - options.now(), options.minDelayMs),
      MAX_TIMER_DELAY_MS,
    );
    handle = options.setTimer(() => {
      void onFire();
    }, delay);
  };

  const onFire = async (): Promise<void> => {
    handle = null;
    if (stopped) {
      return;
    }
    const token = options.getToken();
    if (token === null || token.length === 0) {
      return;
    }
    const expMs = readAccessTokenExpiryMs(token);
    if (expMs === null) {
      return;
    }
    // Another path (reactive 401 refresh, cross-window rotation) may have already refreshed the bearer, pushing `exp` past the lead window.
    // Re-arm off the newer token instead of burning a single-use refresh token.
    if (expMs - options.now() > options.leadMs) {
      arm();
      return;
    }
    options.onDiagnostic?.("proactively refreshing access token before expiry");
    try {
      await options.revalidate();
    } catch {
      // `revalidate` is a boundary that maps failures to outcomes rather than throwing; guard anyway so a rejection can never escape the background timer as an unhandled rejection.
    }
    if (stopped) {
      return;
    }
    arm();
  };

  return {
    start(): void {
      stopped = false;
      arm();
    },
    stop(): void {
      stopped = true;
      clearScheduled();
    },
    notifyResumed(): void {
      if (stopped) {
        return;
      }
      // Drop the sleep-frozen timer and re-run the fire evaluation now; the
      // single-flight `revalidate` coalesces with any concurrent reactive refresh.
      clearScheduled();
      void onFire();
    },
  };
}
