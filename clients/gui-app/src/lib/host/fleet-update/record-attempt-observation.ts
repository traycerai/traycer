import {
  HOST_UPDATE_ATTEMPT_PHASES,
  isTerminalPhase,
  type HostUpdateAttemptPhase,
} from "@traycer/protocol/config/host-update-attempt";
import type { LocalAttemptFacts } from "@traycer-clients/shared/platform/runner-host";
import type { FleetUpdateRecordObservation } from "@/lib/host/fleet-update/fleet-update-view";

/**
 * Map durable attempt facts to the record-derived arm.
 * Null unless the phase is live or `failed`.
 */
export function recordObservationFromLocalAttempt(input: {
  readonly hostId: string;
  readonly localAttempt: LocalAttemptFacts | null;
  readonly observedAtMs: number;
}): FleetUpdateRecordObservation | null {
  const facts = input.localAttempt;
  if (facts === null) return null;
  const phase = narrowPhase(facts.phase);
  // Unrecognised: a phase this build does not know is not evidence it can render.
  // Refusing beats guessing, and a newer host writing a newer vocabulary is exactly when guessing would be confident and wrong.
  if (phase === null) return null;
  // `failed` survives; `complete` and `superseded` do not.
  // A completed update needs no host-down memorial, and `superseded` already projects `idle` even on the live path - a newer attempt replaced it, and that attempt is what the record now describes.
  if (isTerminalPhase(phase) && phase !== "failed") return null;
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
 * `LocalAttemptFacts.phase` is now DECLARED as the protocol union, but the value still crosses an IPC boundary as runtime data read off disk - the type describes what a well-behaved producer sends, not what arrives.
 */
function narrowPhase(value: string): HostUpdateAttemptPhase | null {
  return HOST_UPDATE_ATTEMPT_PHASES.find((phase) => phase === value) ?? null;
}
