import { tryAcquireReadyRemoteSession } from "@traycer-clients/shared/host-transport/remote/index";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import {
  fleetFreshUntilMs,
  fleetPollDelayMs,
} from "@/lib/host/fleet-update/fleet-poll-policy";
import { runWithFleetReadSlot } from "@/lib/host/fleet-update/fleet-read-gate";
import {
  projectFleetUpdateView,
  type FleetUpdateObservation,
  type FleetUpdateWireObservation,
} from "@/lib/host/fleet-update/fleet-update-view";

/**
 * Reads `host.status` for a remote row over a session that ALREADY EXISTS, or
 * declines.
 *
 * This is the whole "other remote row" leg of plan §6, and its contract is
 * negative as much as positive: it may improve a badge, and it may never cause
 * a connection. The borrow enforces that structurally
 * ({@link tryAcquireReadyRemoteSession} has no session factory to call), so
 * this module's job is only to avoid re-introducing a dial by some other route
 * — which is why it takes no `HostClient`. A `HostClient` for an unconnected
 * host is precisely the thing that would build a transport.
 *
 * `null` means "declined, nothing observed": no borrowable session, or the read
 * failed. Both project `unknown`, never failure — a host we could not reach is
 * a host we know nothing about, not a host with a broken update.
 */
export async function readUpdateStatusOverBorrowedSession(input: {
  readonly hostId: string;
  /**
   * Read AFTER the queued round trip, never before it.
   *
   * A `nowMs` number here was stamped at CALL time, which is upstream of the
   * `runWithFleetReadSlot` gate below. That gate admits four reads at a time,
   * so on a fleet with more borrowable hosts than slots the later ones wait
   * behind whole round trips — and then stamped an `observedAtMs` from before
   * the wait, describing data as older than it is. `freshUntilMs` derives from
   * the same instant, so a host on the active cadence (~2s) could be handed a
   * deadline that had already passed when its read returned: stale on arrival,
   * every round, for every host past the fourth.
   *
   * A function rather than a number is what makes the timestamp unforgeable
   * here — there is no instant available to the caller that would be correct.
   * The canonical leg already holds this discipline by reading the cache
   * entry's own `dataUpdatedAt`; this is the borrowed leg keeping it too.
   */
  readonly now: () => number;
  readonly abortSignal: AbortSignal | null;
}): Promise<FleetUpdateObservation | null> {
  const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(input.hostId);
  if (borrowed === null) {
    // No live owner, or only a lingering entry. Declining is the correct
    // outcome and NOT a degraded one: this row simply keeps whatever the
    // registry knows, and a poll that dialed to fill it would be the failure
    // this whole design exists to prevent.
    return null;
  }
  try {
    // The BORROW is taken first and the gate is entered second, so a host with
    // no ready session declines immediately instead of queueing behind four
    // real round trips to discover it has nothing to send. Holding a borrow
    // while queued is safe by the borrow's own contract — it cannot create a
    // session and cannot prolong one — and `release()` below is balanced on
    // every path including the wait.
    const status = await runWithFleetReadSlot(() =>
      borrowed.sendUnary("host.status", {}, input.abortSignal, undefined),
    );
    return observationFromStatus({
      hostId: input.hostId,
      status,
      // Stamped here, after the slot wait AND the round trip.
      nowMs: input.now(),
    });
  } catch {
    // Every failure mode lands here and all of them mean the same thing: we
    // did not learn anything this round. The session dying underneath the
    // borrow is expected (its owner may release at any moment — see
    // `borrowCount`'s note), so it must not be louder than a timeout.
    return null;
  } finally {
    // Balanced on every path, including the abort. `release` is idempotent and
    // schedules nothing, so this can never be the thing that keeps a session
    // alive — but leaving a borrow outstanding would still be a leak a test
    // can see, and the coordinator asserts it is zero.
    borrowed.release();
  }
}

/**
 * Stamps a raw `host.status` response into an observation.
 *
 * Exported because the LOCAL and SELECTED legs read `host.status` through the
 * ordinary host-client query rather than a borrow, and all three legs must
 * produce the same shape — otherwise the three surfaces would be projecting
 * from three subtly different records and the "one derivation" property the
 * view module exists for would be lost at the source instead of at the sink.
 *
 * The freshness deadline is computed from the cadence the resulting view earns,
 * so a host that is actively updating gets a tight deadline (its data goes
 * stale fast because it is expected to change fast) and an idle one a loose
 * one. Computing it from a fixed constant instead would either flicker the
 * active case or let the idle case present minute-old data as current.
 */
export function observationFromStatus(input: {
  readonly hostId: string;
  readonly status: ResponseOfMethod<HostRpcRegistry, "host.status">;
  readonly nowMs: number;
  readonly source?: FleetUpdateWireObservation["source"];
}): FleetUpdateWireObservation {
  const provisional: FleetUpdateWireObservation = {
    hostId: input.hostId,
    source: input.source ?? "borrowed",
    observedAtMs: input.nowMs,
    // ⚠ SYNTHETIC, and the only such value left in this feature — every other
    // site that constructed one has been removed, because an infinite freshness
    // deadline is precisely how the Overview turned a retained response into a
    // permanent lifecycle lock.
    //
    // It is safe HERE for one structural reason: it never leaves this function.
    // The deadline depends on the view and the view depends on an observation,
    // so the first pass needs a placeholder that cannot itself make the reading
    // stale; the returned object spreads `provisional` and overwrites
    // `freshUntilMs` unconditionally on the very next statement. If that spread
    // ever becomes conditional, this becomes the defect again — which is why a
    // test asserts the returned deadline is always finite.
    freshUntilMs: Number.POSITIVE_INFINITY,
    operation: input.status.updateOperation,
    transaction: input.status.updateTransaction,
  };
  const view = projectFleetUpdateView({
    observation: provisional,
    nowMs: input.nowMs,
    // Irrelevant to the cadence decision: `connected` only splits
    // restarting/reconnecting, and both earn the fast poll. Asserted rather
    // than assumed — a test pins that the two phases resolve to the same
    // `fleetPollDelayMs`, so if that ever stops holding this line fails a test
    // instead of quietly stamping a deadline off the wrong cadence.
    connected: true,
  });
  return {
    ...provisional,
    freshUntilMs: fleetFreshUntilMs(input.nowMs, fleetPollDelayMs(view)),
  };
}
