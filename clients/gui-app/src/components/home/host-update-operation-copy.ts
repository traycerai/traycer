import type {
  FleetUpdateView,
  FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";
import { formatHostTransfer } from "@/lib/host/host-progress-copy";

/**
 * The one place an update phase becomes words.
 *
 * Shared by the landing banner, the Settings selector badge and the
 * selected-host Overview so the three cannot describe the same attempt
 * differently — which is the whole reason the projection is a single function
 * one layer down.
 *
 * The governing rule from the experience doc: **"Updating this host…" is not**
 * **sufficient. Every active operation names its phase.** So there is no generic
 * fallback string here; each arm says what is actually happening.
 */

export interface UpdateOperationCopy {
  /** The sentence. Names the phase, never a generic "updating". */
  readonly primary: string;
  /**
   * The screen-reader label. Includes host name, target and phase so two hosts
   * updating at once are distinguishable by ear — the accessibility
   * requirement, and one that the visible copy alone does not satisfy because
   * the banner's host is implied by its placement.
   */
  readonly accessibleLabel: string;
  /**
   * Whether phase changes should be announced politely. Failures use alert
   * semantics instead, so the caller picks the live-region politeness from
   * this rather than hard-coding one for the whole banner.
   */
  readonly assertive: boolean;
  /**
   * Whether the CALLER still has to mark this view as not-current.
   *
   * `false` when {@link primary} already says so in words. A qualified view has
   * two possible renderings — a live phase the host could not confirm
   * ("Downloading update to v2, (last known)") and a phase we simply stopped
   * being able to refresh ("Last seen: Downloading update to v2") — and the
   * second carries the qualification inside the sentence. Without this flag a
   * surface appending its own marker produces "Last seen: Downloading update to
   * v2 (last known)", which reads as two different claims about one fact.
   */
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
    // A RETAINED failure is not asserted. `kind` is `unknown` for anything we
    // are only remembering, so this reads the present tense only — announcing
    // "update failed" with alert semantics for a failure we saw before losing
    // contact would interrupt someone over old news.
    assertive: view.kind === "failed",
    needsQualifiedMarker: view.qualified && !carriesQualificationInline(view),
  };
}

/** True exactly when {@link primarySentence} spells the qualification out. */
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
    // The phase we last saw, marked as past IN THE SENTENCE. The projection
    // keeps this precisely so an offline host can still be described — the
    // experience contract's offline row asks for the last known state, and
    // before the view carried it the only available answer was the generic
    // unknown above.
    return `Last seen: ${phaseSentence(lastKnown, view)}`;
  }
  return phaseSentence(view.kind, view);
}

/**
 * One phase, in words — taking the kind as an ARGUMENT rather than reading
 * `view.kind`, which is what lets the retained-phase sentence above reuse this
 * table instead of growing a parallel one. A second table is how "Downloading
 * update" and "last seen downloading" end up disagreeing about a version suffix.
 */
function phaseSentence(
  kind: FleetUpdateViewKind,
  view: FleetUpdateView,
): string {
  const target = view.targetVersion;
  // Every phase that names a version uses this, and it is empty when the host
  // did not report one — a sentence must never read "Downloading update to v".
  const to = target === null ? "" : ` to v${target}`;
  switch (kind) {
    case "downloading":
      return `Downloading update${to}`;
    case "preparing":
      return `Preparing update${to}`;
    case "applying":
      return `Installing update${to}`;
    case "waiting-for-work":
      return waitingForWorkSentence(view.blockingSessionCount);
    case "waiting-to-activate":
      // The plan names this string explicitly (§3.1): a parked activation must
      // NOT keep saying "Updating". It is placed, it is waiting for a restart,
      // and the host is still serving in the meantime.
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
      // Unreachable through `primarySentence`, which handles `unknown` above so
      // it can consult the retained phase. Kept as an arm because this switch is
      // exhaustive over the kind union and a retained `unknown` — a host we
      // never learned anything about — must still produce a sentence.
      return "Update state unknown";
    case "idle":
      return "Host is up to date";
  }
}

/**
 * Names the BLOCKER rather than the phase, because this is the one active state
 * a person can act on — and the count is what makes the Force affordance beside
 * it legible. A `null` count keeps the sentence deliberately unquantified
 * rather than saying "0".
 */
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

/**
 * The percentage to render, or `null` for an explicitly indeterminate operation.
 *
 * `null` here means "use an indeterminate indicator", never "use zero". A
 * zero-width determinate bar and an unmeasured one are indistinguishable for
 * the first instant and then diverge into a claim the host never made.
 */
export function operationProgressPercent(view: FleetUpdateView): number | null {
  return view.progress.kind === "determinate"
    ? Math.round(view.progress.percent)
    : null;
}

/**
 * Whether to draw the progress BAR — as distinct from the numbers beside it.
 *
 * Shared by both surfaces rather than re-derived at each, because they had the
 * same expression written out twice and this adds a third condition to it.
 *
 * That third condition: a RETAINED phase never gets a bar. Text under "Last
 * seen: Downloading update to v2" is a claim about the past and reads as one;
 * an indeterminate bar is an animation, and motion is a claim about the
 * present that no amount of qualifying copy beside it can withdraw. A frozen
 * determinate bar is only marginally better — it invites the "is it stuck?"
 * reading that `projectProgress` already refuses to create for parked
 * attempts. The measured numbers still render, because a static "80 MB of
 * 200 MB" under an explicitly past-tense sentence claims nothing.
 */
export function showsProgressBar(view: FleetUpdateView): boolean {
  if (view.progress.kind === "none") return false;
  // Parked on live work: the bar would sit still while the sentence explains
  // that it is waiting, which reads as a stall rather than as a pause.
  if (view.kind === "waiting-for-work") return false;
  // `unknown` with progress can only be a retained attempt — a live view never
  // reaches this kind carrying measurements.
  if (view.kind === "unknown") return false;
  return true;
}

/**
 * The measured byte detail — `"80 MB of 200 MB"`, `"80 MB"`, or `null`.
 *
 * INDEPENDENT of {@link operationProgressPercent}, which is the whole point.
 * The contract asks for "real percentage/bytes when known" and the wire makes
 * the three fields separately nullable, so a host streaming an unsized body
 * reports bytes with no percentage at all. Gating the counters on the
 * percentage — which both surfaces effectively did by rendering neither —
 * discarded a complete `80 MB of 200 MB` and left an anonymous moving bar.
 *
 * Formatting goes through `formatHostTransfer`, the app's ONE byte vocabulary.
 * This deliberately does not roll its own: the file that owns that helper
 * records what happened when Settings and the boot surface each had their own
 * (the two disagreed on wording AND on units, MB against MiB, for the same
 * download), and a third copy here would be the same mistake with a longer
 * comment.
 */
export function operationProgressBytes(view: FleetUpdateView): string | null {
  const progress = view.progress;
  if (progress.kind === "none") return null;
  return formatHostTransfer(progress.bytes, progress.totalBytes);
}
