import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";
import { formatHostTransfer } from "@/lib/host/host-progress-copy";

/** Shared by the landing banner, the Settings selector badge and the selected-host Overview so the three cannot
 * describe the same attempt differently. */

export interface UpdateOperationCopy {
  /** The sentence. Names the phase, never a generic "updating". */
  readonly primary: string;
  /** Includes host name, target and phase so two hosts updating at once are distinguishable by ear. */
  readonly accessibleLabel: string;
  /** Failures use alert semantics instead, so the caller picks the live-region politeness from this rather than
   * hard-coding one for the whole banner. */
  readonly assertive: boolean;
  /** `false` when primary already says so in words. Without this flag a surface appending its own marker produces
   * "Last seen: Downloading update to v2 (last known)", which reads as two different claims about one fact. */
  readonly needsQualifiedMarker: boolean;
}

export function describeUpdateOperation(input: {
  readonly view: FleetUpdateView;
  readonly hostName: string;
}): UpdateOperationCopy {
  const { view, hostName } = input;
  const primary = primarySentence(view);
  return {
    primary,
    accessibleLabel: `${hostName}: ${primary}`,
    // `kind` is `unknown` for anything we are only remembering, so this reads the present tense only.
    assertive: view.kind === "failed",
    needsQualifiedMarker: view.qualified && !carriesQualificationInline(view),
  };
}

function carriesQualificationInline(view: FleetUpdateView): boolean {
  return view.kind === "unknown" && view.lastKnownKind !== null;
}

function primarySentence(view: FleetUpdateView): string {
  if (view.kind === "unknown") {
    const lastKnown = view.lastKnownKind;
    // Nothing retained: say only what is true, which is nothing.
    if (lastKnown === null || lastKnown === "unknown") {
      return "Update state unknown";
    }
    // The projection keeps this precisely so an offline host can still be described.
    return `Last seen: ${phaseSentence(lastKnown, view)}`;
  }
  return phaseSentence(view.kind, view);
}

/** One phase, in words - taking the kind as an argument rather than reading `view.kind`, which is what lets the
 * retained-phase sentence above reuse this table instead of growing a parallel one. */
function phaseSentence(
  kind: FleetUpdateViewKind,
  view: FleetUpdateView,
): string {
  const target = view.targetVersion;
  // Every phase that names a version uses this, and it is empty when the host did not report one - a sentence
  // must never read "Downloading update to v".
  const to = target === null ? "" : ` to v${target}`;
  switch (kind) {
    case "updating":
      // Never narrower than that - "Installing" during a three-minute download reads as a stall, and the marker
      // cannot tell the two apart.
      return `Updating host${to}`;
    case "downloading":
      return `Downloading update${to}`;
    case "preparing":
      return `Preparing update${to}`;
    case "applying":
      return `Installing update${to}`;
    case "waiting-for-work":
      return waitingForWorkSentence(view.blockingSessionCount);
    case "waiting-to-activate":
      // The plan names this string explicitly (§3.1): a parked activation must not keep saying "Updating". It is
      // placed, it is waiting for a restart, and the host is still serving in the meantime.
      return "Update installed — restart host to finish";
    case "restarting":
      return `Restarting host${to}`;
    case "reconnecting":
      return "Waiting for host to reconnect";
    case "verifying":
      return `Verifying updated host${to}`;
    case "complete":
      return completeSentence(target);
    case "failed":
      return failedSentence(view.errorMessage);
    case "unavailable":
      // Deliberately not "failed". The record could not be read; the update may
      // be fine. This wording points at the repair path Diagnostics offers.
      return "Update status unavailable — see Diagnostics";
    case "unknown":
      // Kept as an arm because this switch is exhaustive over the kind union and a retained `unknown` - a host we
      // never learned anything about - must still produce a sentence.
      return "Update state unknown";
    case "idle":
      return "Host is up to date";
  }
}

/** Names the blocker rather than the phase, because this is the one active state a person can act on - and the
 * count is what makes the Force affordance beside it legible. */
function waitingForWorkSentence(blockingSessionCount: number | null): string {
  if (blockingSessionCount === null) {
    return "Update will continue when work finishes";
  }
  const verb = blockingSessionCount === 1 ? "finishes" : "finish";
  return `Update will continue when ${describeSessions(blockingSessionCount)} ${verb}`;
}

function completeSentence(targetVersion: string | null): string {
  return targetVersion === null
    ? "Host updated"
    : `Updated to v${targetVersion}`;
}

function failedSentence(errorMessage: string | null): string {
  return errorMessage === null
    ? "Update failed"
    : `Update failed: ${errorMessage}`;
}

function describeSessions(count: number): string {
  return count === 1 ? "1 session" : `${String(count)} sessions`;
}

/** A zero-width determinate bar and an unmeasured one are indistinguishable for the first instant and then
 * diverge into a claim the host never made. */
export function operationProgressPercent(view: FleetUpdateView): number | null {
  return view.progress.kind === "determinate"
    ? Math.round(view.progress.percent)
    : null;
}

/** Whether to draw the progress bar - as distinct from the numbers beside it. That third condition: a retained
 * phase never gets a bar. */
export function showsProgressBar(view: FleetUpdateView): boolean {
  if (view.progress.kind === "none") return false;
  // Parked on live work: the bar would sit still while the sentence explains
  // that it is waiting, which reads as a stall rather than as a pause.
  if (view.kind === "waiting-for-work") return false;
  // `unknown` with progress can only be a retained attempt - a live view never reaches this kind carrying
  // measurements.
  if (view.kind === "unknown") return false;
  return true;
}

/** This deliberately does not roll its own: the file that owns that helper records what happened when Settings
 * and the boot surface each had their own (the two disagreed on wording and on units, MB against MiB. */
export function operationProgressBytes(view: FleetUpdateView): string | null {
  const progress = view.progress;
  if (progress.kind === "none") return null;
  return formatHostTransfer(progress.bytes, progress.totalBytes);
}
