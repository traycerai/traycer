/**
 * Proactive access-token refresh scheduler shared by the Desktop renderer and
 * the CLI/monitor.
 *
 * Both clients already refresh *reactively* - on a host `UNAUTHORIZED` the
 * `auth-aware-messenger` (unary RPC) and `StreamAuthRevalidator` (stream) call
 * `revalidateCurrentContext()`, which refreshes, rotates the bearer lease, and
 * persists. What neither does today is refresh *before* the ~4h token TTL, so a
 * session left open overnight carries a dead bearer into the next live cloud
 * call (e.g. the host's `/api/v3/user` lookup on an A2A send) and 401s.
 *
 * This scheduler closes that gap: it decodes the access token's `exp` and arms
 * a timer to invoke the SAME single-flight `revalidate` shortly before expiry,
 * then re-arms off whichever token the refresh settled on. It never owns the
 * refresh mechanics - only the timing - so the reactive paths and this proactive
 * one share one rotation primitive and can't drift.
 *
 * The delay is measured from the wall-clock `exp`, but `setTimeout` counts down
 * in MONOTONIC time, frozen while the OS sleeps - so a session that sleeps
 * through the TTL wakes with a dead bearer and a stale timer. `notifyResumed()`
 * is the wake hook: it re-evaluates against the wall clock at once.
 *
 * The scheduler is timer- and clock-injected so it is environment-agnostic
 * (`window.setTimeout` in the renderer, `setTimeout` in the CLI) and
 * deterministically testable.
 */
import { readAccessTokenExpiryMs } from "./jwt-exp";

/** Refresh this long before the token's `exp`. */
export const DEFAULT_REFRESH_LEAD_MS = 10 * 60_000;

/**
 * Floor for the scheduled delay. Doubles as the retry cadence: when a refresh
 * leaves the bearer unchanged (network error) or the token is already inside
 * the lead window at arm time, the next attempt is scheduled this far out
 * rather than immediately, so a persistent outage can't spin the timer.
 */
export const DEFAULT_REFRESH_MIN_DELAY_MS = 60_000;

/**
 * Cap for a scheduled delay. `setTimeout`/`setInterval` coerce the delay to a
 * 32-bit signed int; anything above 2^31-1 ms (~24.8 days) overflows and the
 * timer fires almost immediately. A far-future (or malformed-but-huge) `exp`
 * could produce such a delay, so we clamp: the timer fires at the cap, re-arms,
 * and converges once the token is actually inside the lead window.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ProactiveRefreshScheduler {
  /** (Re-)arm off the current token. Idempotent; safe to call on every rotation. */
  start(): void;
  /** Cancel any pending refresh and stop re-arming. */
  stop(): void;
  /**
   * Re-evaluate now (drop the sleep-frozen timer, refresh if inside the lead
   * window, else re-arm) - call on device wake. No-op while stopped, so it is
   * safe to call on every wake regardless of auth state.
   */
  notifyResumed(): void;
}

export interface ProactiveRefreshSchedulerOptions<THandle> {
  /** Current access token, or `null` when signed out (disarms the scheduler). */
  readonly getToken: () => string | null;
  /**
   * Single-flight refresh that rotates + persists the bearer. Its return value
   * is ignored - the scheduler re-reads `getToken()` afterwards to re-arm - so
   * the renderer's `ValidationOutcome | null` and the CLI's `RevalidateOutcome`
   * both satisfy this shape.
   */
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
    // Another path (reactive 401 refresh, cross-window rotation) may have
    // already refreshed the bearer, pushing `exp` past the lead window. Re-arm
    // off the newer token instead of burning a single-use refresh token.
    if (expMs - options.now() > options.leadMs) {
      arm();
      return;
    }
    options.onDiagnostic?.("proactively refreshing access token before expiry");
    try {
      await options.revalidate();
    } catch {
      // `revalidate` is a boundary that maps failures to outcomes rather than
      // throwing; guard anyway so a rejection can never escape the background
      // timer as an unhandled rejection. The re-arm below retries on the floor.
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
