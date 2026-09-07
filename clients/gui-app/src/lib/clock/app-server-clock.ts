import {
  DEFAULT_SKEW_ENTER_MS,
  DEFAULT_SKEW_EXIT_MS,
  ServerTimeOffsetTracker,
  type ServerClockState,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";
import type { AuthServerTimeObservation } from "@traycer-clients/shared/auth/auth-validation-types";

/** The renderer's single server-time offset tracker. */
export const appServerClock = new ServerTimeOffsetTracker({
  nowMs: () => Date.now(),
  // The suspect clock and the reference must be DIFFERENT sources, or the
  // divergence check compares a value with itself and can never fire.
  monotonicNowMs: () => performance.now(),
  enterSkewMs: DEFAULT_SKEW_ENTER_MS,
  exitSkewMs: DEFAULT_SKEW_EXIT_MS,
});

/**
 * How often the wall-vs-monotonic divergence check runs.
 * Cheap enough to be uninteresting, and short enough that a user who has just fixed their clock sees the app recover while they are still looking at it.
 */
const WALL_CLOCK_TICK_INTERVAL_MS = 10_000;

/**
 * Arms the divergence check and returns its teardown.
 * Driven from a mounted component rather than at import time so nothing that merely imports this module (a unit test, a storybook render) leaves a live interval behind.
 */
export function startAppServerClockMonitor(): () => void {
  const handle = setInterval(() => {
    appServerClock.noteWallClockTick();
  }, WALL_CLOCK_TICK_INTERVAL_MS);
  return () => {
    clearInterval(handle);
  };
}

/**
 * Feeds an authn response's server-time observation in, when the response carried one.
 * A no-op otherwise - an absent `Date` header is silence, not evidence that the clock is fine.
 */
export function recordAuthServerTime(
  observation: AuthServerTimeObservation | undefined,
): void {
  if (observation === undefined) {
    return;
  }
  appServerClock.recordServerTimeMs(
    observation.serverEpochMs,
    observation.observedAtMs,
  );
}

/** Feeds the `iat` of a token THIS process just minted against authn. */
export function recordRotatedBearer(token: string): void {
  appServerClock.recordFreshlyIssuedToken(token);
}

export type { ServerClockState };
