import type { LiveHostAvailability } from "@traycer-clients/shared/host-client/host-directory";
import type { PublishedHostPresence } from "./host-endpoint-reachability";

/**
 * The fold that turns a stream of {@link PublishedHostPresence} observations
 * into the availability the RENDERER is told about.
 *
 * Pure and timer-free on purpose: the owner (`HostLifecycle`) supplies the
 * observations and owns the re-probe clock, so the policy that decides what a
 * failed probe MEANS can be exercised without a fake event loop, and the same
 * policy cannot drift between the watcher edge, the retry ladder, and an
 * out-of-band repair.
 *
 * ### The policy, and the incidents behind each clause
 *
 * 1. **Liveness is the authority.** A `busy` observation - process alive,
 *    endpoint silent - can only ever degrade the verdict to `busy`. It can
 *    never produce "no host": that collapse is what locked every chat on a
 *    healthy staging machine read-only for two hours on 2026-08-11 while the
 *    same host was answering renderer RPCs in milliseconds.
 * 2. **Demotion needs corroboration, promotion does not.** Dropping from
 *    `available` takes {@link DEMOTE_AFTER_CONSECUTIVE_BUSY} consecutive busy
 *    observations, so one transiently refused connect (host mid-GC, a full
 *    socket backlog, a loopback probe that lost a race with a burst of
 *    per-request dials) does not visibly degrade a working session. A single
 *    `available` observation restores it immediately - evidence that the host
 *    IS serving is never worth sitting on.
 * 3. **Nothing here is terminal.** `degraded` is reported alongside the
 *    verdict precisely so the owner can keep a bounded re-probe armed while it
 *    is set - including through the hysteresis hold, where the published
 *    verdict is still `available` and would otherwise look like a state
 *    needing no further attention. The 2026-08-11 wedge survived two hours
 *    because the only thing that could have re-examined the verdict was
 *    edge-triggered on a file that never changed again.
 * 4. **Absence is not hysteresis-protected.** `absent` is POSITIVE evidence
 *    (pid.json gone, or the pid confirmed dead / recycled), not a failure to
 *    observe, and a genuinely dead host must keep locking promptly - the
 *    2026-08-08 two-slot lesson is that a corpse presented as reachable makes
 *    tiles dial it forever.
 */
export const DEMOTE_AFTER_CONSECUTIVE_BUSY = 2;

export interface HostAvailabilityState {
  /**
   * What the renderer is told, or `null` for "there is no host to bind to".
   * `null` is the ONLY value that may reach the renderer as a dead host.
   */
  readonly published: LiveHostAvailability | null;
  /** Consecutive `busy` observations, reset by any other observation. */
  readonly consecutiveBusy: number;
  /**
   * Whether the LAST observation was degraded, regardless of what was
   * published. True through the hysteresis hold, which is exactly the window
   * where `published` alone would say "all good" and the re-probe would be
   * dropped.
   */
  readonly degraded: boolean;
}

export const INITIAL_HOST_AVAILABILITY_STATE: HostAvailabilityState = {
  published: null,
  consecutiveBusy: 0,
  degraded: false,
};

/**
 * Folds one presence observation into the published verdict. See the module
 * doc above for why each arm is shaped the way it is.
 */
export function foldHostAvailability(
  state: HostAvailabilityState,
  presence: PublishedHostPresence,
): HostAvailabilityState {
  if (presence === "absent") {
    return INITIAL_HOST_AVAILABILITY_STATE;
  }
  if (presence === "available") {
    return { published: "available", consecutiveBusy: 0, degraded: false };
  }
  const consecutiveBusy = state.consecutiveBusy + 1;
  // The hold applies only when there is a healthy verdict to protect. Coming
  // from `null` (the host just appeared, alive but not yet answering) or from
  // an existing `busy`, `busy` is published immediately: there is no working
  // session to shield, and pretending a host answers when it has never been
  // observed answering would be a lie in the other direction.
  const holdsAvailable =
    state.published === "available" &&
    consecutiveBusy < DEMOTE_AFTER_CONSECUTIVE_BUSY;
  return {
    published: holdsAvailable ? "available" : "busy",
    consecutiveBusy,
    degraded: true,
  };
}

/**
 * Should the owner keep a bounded re-probe armed?
 *
 * True whenever the last observation was degraded - including the hysteresis
 * hold. Deliberately NOT derived from `published`: during the hold `published`
 * is `available`, and reading only that is how a degraded verdict becomes a
 * state nothing ever revisits.
 */
export function needsReprobe(state: HostAvailabilityState): boolean {
  return state.degraded;
}
