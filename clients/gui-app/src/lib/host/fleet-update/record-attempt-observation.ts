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
 * Absent facts, an unrecognised phase, and a terminal phase that is NOT
 * `failed` all return `null`, which projects the ordinary `unknown`.
 *
 * ## Why `failed` is the exception
 *
 * This originally dropped every terminal phase, on the reasoning that carrying
 * one into a host-down window renders history as if it were current. That holds
 * for `complete` and `superseded` and does not hold for `failed`, and the live
 * path already says so: it maps `failed` → `failed` and only collapses
 * `superseded` → `idle`. So the one phase the live path considers worth showing
 * was the one this dropped — precisely when the host is unreachable and this
 * record is the ONLY evidence that exists. Packaged-macOS activation failing
 * after bootout is exactly that case: no live `host.status` can ever report it.
 *
 * It is not rendered as a live phase. The projector's record arm returns
 * `kind: "unknown"` with `lastKnownKind` carrying the phase, and surfaces
 * qualify that ("last seen …"), so the objection above is answered by the
 * channel rather than by discarding the fact. Nothing new is introduced here:
 * this function only stops suppressing the observation, and the existing
 * retained-phase projection does the rest.
 *
 * The memorial is BOUNDED, which is what makes it honest. A terminal record
 * past `TERMINAL_ATTEMPT_RETENTION_MS` (seven days) is pruned at attempt-store
 * open — and, because a stable host may not open the store for months, the
 * read seams enforce the same bound without waiting for a contender: Desktop's
 * `readLocalAttemptFacts` answers `null` for an expired record, and the host's
 * `projectUpdateOperation` projects it as `none`. So "a failure stays
 * discoverable until it is superseded or ages out" is a real guarantee rather
 * than "forever" — which is what the unconditional drop was implicitly
 * defending against.
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
  // `failed` survives; `complete` and `superseded` do not. A completed update
  // needs no host-down memorial, and `superseded` already projects `idle` even
  // on the live path — a newer attempt replaced it, and that attempt is what
  // the record now describes.
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
 * `LocalAttemptFacts.phase` is now DECLARED as the protocol union, but the
 * value still crosses an IPC boundary as runtime data read off disk — the
 * type describes what a well-behaved producer sends, not what arrives. The
 * narrowing stays as the runtime enforcement of that declaration: refusing
 * beats guessing, and a phase this build does not know is not evidence it
 * can render.
 */
function narrowPhase(value: string): HostUpdateAttemptPhase | null {
  return HOST_UPDATE_ATTEMPT_PHASES.find((phase) => phase === value) ?? null;
}
