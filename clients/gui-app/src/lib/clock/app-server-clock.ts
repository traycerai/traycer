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
 * Feeds the `iat` of a token THIS process just minted against authn.
 *
 * The bar is mint-proven, not merely adopted, and it is narrow on purpose. An
 * `iat` is only a server-time reading while the token's age is bounded by the
 * round trip that produced it; for anything else it is the token's AGE, and
 * feeding that in reports a skew that does not exist. Two shapes of caller must
 * therefore stay out: a token read back from the credentials file (its `iat` is
 * however long ago the last session started), and a pair some other window
 * committed (valid, same user, arbitrary age). Both are ordinary events on a
 * perfectly correct clock — a window backgrounded past the 5-minute threshold
 * hits the first every time it reconciles.
 *
 * Today's single caller is the `applied` arm of `AuthService`'s locked rotate.
 */
export function recordRotatedBearer(token: string): void {
  appServerClock.recordFreshlyIssuedToken(token);
}

export type { ServerClockState };
