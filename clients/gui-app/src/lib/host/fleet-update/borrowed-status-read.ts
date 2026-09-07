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

/** Reads `host.status` for a remote row over a session that ALREADY EXISTS, or declines. */
export async function readUpdateStatusOverBorrowedSession(input: {
  readonly hostId: string;
  /** Read AFTER the queued round trip, never before it. */
  readonly now: () => number;
  readonly abortSignal: AbortSignal | null;
}): Promise<FleetUpdateObservation | null> {
  const borrowed = tryAcquireReadyRemoteSession<HostRpcRegistry>(input.hostId);
  if (borrowed === null) {
    // No live owner, or only a lingering entry.
    // Declining is the correct outcome and NOT a degraded one: this row simply keeps whatever the registry knows, and a poll that dialed to fill it would be the failure this whole design exists to prevent.
    return null;
  }
  try {
    // The BORROW is taken first and the gate is entered second, so a host with no ready session declines immediately instead of queueing behind four real round trips to discover it has nothing to send.
    const status = await runWithFleetReadSlot(() =>
      borrowed.sendUnary("host.status", {}, input.abortSignal, undefined),
    );
    return observationFromStatus({
      hostId: input.hostId,
      status,
      // Stamped here, after the slot wait AND the round trip.
      nowMs: input.now(),
      // A borrowed read is one `host.status` round trip and nothing more;
      // this leg never asks for installation info, so it has no park to
      // derive. `null` is "not observed" here, exactly as it is on the wire.
      legacyFacts: null,
    });
  } catch {
    // Every failure mode lands here and all of them mean the same thing: we did not learn anything this round.
    // The session dying underneath the borrow is expected (its owner may release at any moment - see `borrowCount`'s note), so it must not be louder than a timeout.
    return null;
  } finally {
    // Balanced on every path, including the abort.
    // `release` is idempotent and schedules nothing, so this can never be the thing that keeps a session alive - but leaving a borrow outstanding would still be a leak a test can see, and the coordinator asserts it is zero.
    borrowed.release();
  }
}

/** Stamps a raw `host.status` response into an observation. */
export function observationFromStatus(input: {
  readonly hostId: string;
  readonly status: ResponseOfMethod<HostRpcRegistry, "host.status">;
  readonly nowMs: number;
  readonly source?: FleetUpdateWireObservation["source"];
  /**
   * Record-derived park facts, or `null` when this leg had no installation
   * read beside the status. Explicit rather than defaulted so a new caller
   * has to SAY it did not look — the Overview is the one leg that does.
   */
  readonly legacyFacts: FleetUpdateWireObservation["legacyFacts"];
}): FleetUpdateWireObservation {
  const provisional: FleetUpdateWireObservation = {
    hostId: input.hostId,
    source: input.source ?? "borrowed",
    observedAtMs: input.nowMs,
    // SYNTHETIC, and the only such value left in this feature - every other site that constructed one has been removed, because an infinite freshness deadline is precisely how the Overview turned a retained response into a permanent lifecycle lock.
    freshUntilMs: Number.POSITIVE_INFINITY,
    operation: input.status.updateOperation,
    transaction: input.status.updateTransaction,
    coarseProgress: input.status.updateProgress,
    legacyFacts: input.legacyFacts,
  };
  const view = projectFleetUpdateView({
    observation: provisional,
    nowMs: input.nowMs,
    // Irrelevant to the cadence decision: `connected` only splits restarting/reconnecting, and both earn the fast poll.
    // Asserted rather than assumed - a test pins that the two phases resolve to the same `fleetPollDelayMs`, so if that ever stops holding this line fails a test instead of quietly stamping a deadline off the wrong cadence.
    connected: true,
  });
  return {
    ...provisional,
    freshUntilMs: fleetFreshUntilMs(input.nowMs, fleetPollDelayMs(view)),
  };
}
