import {
  DEFAULT_SKEW_ENTER_MS,
  DEFAULT_SKEW_EXIT_MS,
  ServerTimeOffsetTracker,
  type ServerClockState,
} from "@traycer-clients/shared/clock/server-time-offset-tracker";
import type { AuthServerTimeObservation } from "@traycer-clients/shared/auth/auth-validation-types";

/**
 * The renderer's single server-time offset tracker.
 *
 * App-wide, like `transportEvidenceRelay` and `appHostCredentialMintFlow`, and
 * for the same reason: the local clock is a property of the MACHINE, not of any
 * host binding, tab, or session. One instance means the banner, every stream
 * transport, and every error surface read one verdict — two trackers could
 * disagree, and a session parked by one would never hear the other's recovery
 * edge.
 *
 * It is fed exclusively by `AuthService` (the only renderer code that sees
 * authn responses and freshly rotated tokens) and read by
 * `useServerClockSkew()` plus the stream client's park gates.
 */
export const appServerClock = new ServerTimeOffsetTracker({
  nowMs: () => Date.now(),
  // The suspect clock and the reference must be DIFFERENT sources, or the
  // divergence check compares a value with itself and can never fire.
  monotonicNowMs: () => performance.now(),
  enterSkewMs: DEFAULT_SKEW_ENTER_MS,
  exitSkewMs: DEFAULT_SKEW_EXIT_MS,
});

/**
 * How often the wall-vs-monotonic divergence check runs. Cheap enough to be
 * uninteresting, and short enough that a user who has just fixed their clock
 * sees the app recover while they are still looking at it.
 */
const WALL_CLOCK_TICK_INTERVAL_MS = 10_000;

/**
 * Arms the divergence check and returns its teardown. Driven from a mounted
 * component rather than at import time so nothing that merely imports this
 * module (a unit test, a storybook render) leaves a live interval behind.
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
 * Feeds an authn response's server-time observation in, when the response
 * carried one. A no-op otherwise — an absent `Date` header is silence, not
 * evidence that the clock is fine.
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

/**
 * Feeds the `iat` of a token authn minted moments ago. Call ONLY from the
 * rotation-adoption path: a token read back from the credentials file is not a
 * server-time sample, and treating one as fresh would report an offset the size
 * of however long the app was closed.
 */
export function recordRotatedBearer(token: string): void {
  appServerClock.recordFreshlyIssuedToken(token);
}

export type { ServerClockState };
