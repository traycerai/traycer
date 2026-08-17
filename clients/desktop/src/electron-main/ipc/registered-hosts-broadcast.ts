import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import type { RegisteredHostsPush } from "../../ipc-contracts/host-types";
import type { DesktopHostFleetSource } from "../selection/desktop-selection-ports";

/**
 * The app's ONE registry cadence (redesign P4.1/F22, connection registry §6).
 *
 * Kept in step with the renderer's `HOST_DIRECTORY_REFRESH_POLL_MS`, which is
 * still the cadence in the browser/dev topology that has no main process. The
 * number is unchanged by this move; only its OWNER is. Liveness is relay
 * attachment, so polling faster than the lease buys a fresher answer to
 * nothing - what keeps the directory current is the event set around this
 * interval (a picker opening, the request context changing, the local host
 * publishing, a deregister), all of which still refresh immediately.
 */
const REGISTERED_HOSTS_POLL_MS = 60_000;

/**
 * Structural surface of `RunnerIpcBridge` this module depends on - declared
 * here (like `HostControllerStatusBroadcastBridge` next door) so tests can
 * pass a lightweight double instead of constructing the real class, whose
 * private members make it unsatisfiable structurally.
 */
export interface RegisteredHostsBroadcastBridge {
  readonly disposeFns: Array<() => void>;
  fanOut(channel: string, payload: unknown): void;
}

/**
 * The publisher half: hands one fetched registry response to every window.
 *
 * Passed into `DesktopHostFleetSource` as its `publishRegistryResponse`, so
 * the rows that reach the renderer are the SAME bytes the authority's fleet
 * port just read - one `GET /api/v3/hosts` per tick for the whole app, however
 * many windows are open. Before this, each window ran its own 60s timer and
 * its own fetch through the `listRegisteredHosts` invoke.
 *
 * Blind fan-out is correct here for the same reason it is on the selection
 * channels: a window that is not listening yet has done its own initial read
 * and will hear the next tick, and the payload asserts nothing a late listener
 * could act on wrongly.
 */
export function createRegisteredHostsPublisher(
  bridge: RegisteredHostsBroadcastBridge,
): (push: RegisteredHostsPush) => void {
  return (push) => {
    bridge.fanOut(RunnerHostEvent.registeredHostsChange, push);
  };
}

/**
 * The cadence half: one interval per app, driving `fleet.refresh()`.
 *
 * It deliberately does NOT fetch. `DesktopHostFleetSource.refresh()` already
 * captures the identity generation at fetch start, reads the bearer, drops a
 * non-ok result without clobbering known membership, and is TOTAL by contract
 * (it never rejects) - so driving it is how these ticks inherit every one of
 * those race rules instead of re-implementing them a second time, subtly
 * differently. The publisher above rides the same call.
 *
 * ## Unconditional, and not gated on window visibility
 *
 * The renderer timer this replaces skipped its tick while the document was
 * hidden, so an app with every window hidden used to issue no fetches at all
 * and now issues one a minute. That trade is deliberate, and the reason is not
 * load arithmetic: this fleet feeds the selection AUTHORITY, not just window
 * chrome. Membership decides failover candidates, deregister-driven preferred
 * clearing, and the lease set every surface resolves against, and none of that
 * may have its freshness coupled to whether a window happens to be visible - a
 * hidden app whose effective host died should be CORRECT when the user comes
 * back, not stale and then scrambling. Gating on visibility would also buy a
 * new state coupling (minimized, tray-alive, the last window closing mid-tick)
 * for a saving of one request per minute.
 *
 * ⚠ A PERF AUDIT RE-FILED THIS AS A DEFECT (2026-08-17), measuring the one
 * fetch a minute against a released build that issued none and reading it as a
 * lost visibility gate. The measurement was correct and the conclusion was not.
 * Recorded here because the reasoning above was already written and did not
 * stop it: the risk to this trade is not someone breaking it by accident, it is
 * someone FIXING it, correctly following a number, and silently coupling
 * authority freshness to whether a window is visible.
 *
 * ⚠ DECLARED COVERAGE GAP - `timer.unref()` is the leg that makes an
 * unconditional 60s poll safe (without it the cadence keeps the main process
 * alive, which is the only version of this that IS a defect), and no test in
 * `__tests__/registered-hosts-broadcast.test.ts` asserts it. That is a limit of
 * the harness rather than a decision: the suite's cadence arms drive vitest's
 * faked clock, and a `vi.spyOn(globalThis, "setInterval")` there records ZERO
 * calls from this module under both faked and real timers, so the call this
 * module makes is not reachable from that test realm. Pinning it would mean
 * injecting the timer factory - a production seam added purely for a test - and
 * that was judged not worth it. The cadence and disposal ARE pinned; `unref` is
 * not, and this note is here so nobody reads three green arms as covering it.
 */
export function registerRegisteredHostsBroadcast(
  bridge: RegisteredHostsBroadcastBridge,
  fleet: DesktopHostFleetSource,
): void {
  const timer = setInterval(() => {
    void fleet.refresh();
  }, REGISTERED_HOSTS_POLL_MS);
  // The cadence must never be what keeps the main process alive.
  timer.unref();
  bridge.disposeFns.push(() => {
    clearInterval(timer);
  });
}
