import {
  HOST_UPDATE_ATTEMPT_PHASES,
  isTerminalPhase,
  type HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";
import type { LocalAttemptFacts } from "@traycer-clients/shared/platform/runner-host";
import type { FleetUpdateRecordObservation } from "@/lib/host/fleet-update/fleet-update-view";

/**
 * Turn Desktop's published durable-record FACTS into the projector's
 * record-derived arm (Ticket 07 §5.2.7).
 *
 * This is the production consumer of `LocalAttemptFacts`. Desktop re-reads
 * `update-attempt.json` and broadcasts it on the controller status precisely so
 * the renderer can still say something true while the host is unreachable; a
 * renderer that discarded it left §5.2.7 an isolated projector rather than a
 * feature.
 *
 * ## FACTS ONLY
 *
 * Everything here comes off the record. Nothing invents `execution`,
 * `trigger`, `liveness`, busy counts, or an error — those are things only a
 * RUNNING host can report, and the whole reason this arm exists is that there
 * is no running host to report them.
 *
 * ## `null` is the fail-closed answer, and it has three causes
 *
 * Absent facts, an unrecognised phase, and a TERMINAL phase all return `null`,
 * which projects the ordinary `unknown`. The terminal case is the one worth
 * naming: a completed, failed or superseded attempt is finished, and carrying
 * its phase into a host-down window would render "last seen complete" for a
 * host that is simply off — describing history as if it were the current
 * situation.
 */
export function recordObservationFromLocalAttempt(input: {
  readonly hostId: string;
  readonly localAttempt: LocalAttemptFacts | null;
  readonly observedAtMs: number;
}): FleetUpdateRecordObservation | null {
  const facts = input.localAttempt;
  if (facts === null) return null;
  const phase = narrowPhase(facts.phase);
  // Unrecognised: a phase this build does not know is not evidence it can
  // render. Refusing beats guessing, and a newer host writing a newer
  // vocabulary is exactly when guessing would be confident and wrong.
  if (phase === null) return null;
  if (isTerminalPhase(phase)) return null;
  return {
    hostId: input.hostId,
    source: "durable-record",
    observedAtMs: input.observedAtMs,
    attemptId: facts.attemptId,
    targetVersion: facts.targetVersion,
    phase,
  };
}

/**
 * `LocalAttemptFacts.phase` crosses the IPC boundary as a plain string, so it
 * is narrowed HERE against the canonical list rather than trusted.
 */
function narrowPhase(value: string): HostUpdateAttemptPhase | null {
  return HOST_UPDATE_ATTEMPT_PHASES.find((phase) => phase === value) ?? null;
}
