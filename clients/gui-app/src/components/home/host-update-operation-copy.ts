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
  /**
   * Whether this surface's CLI-FLOOR lane is active — the executing CLI on that
   * machine is below the projected release's floor, so the region is rendering
   * the remedy row and its `Show installation help` instead of Update now.
   *
   * It changes exactly one sentence: a work park's. See
   * {@link waitingForWorkSentence}. Everything else about a floor-blocked host
   * is already said by the remedy row itself, and this must never become a
   * general "the floor is unmet" annotation on unrelated phases — a download in
   * flight is not blocked by a floor the summary walk found on some other
   * candidate.
   *
   * `false` from the landing banner, and that is not an oversight: the banner
   * has no floor lane and no installation-help affordance, so the substituted
   * sentence would name a way forward that is nowhere on that screen. The
   * count sentence is at least honest there, and Settings is one click away.
   */
  readonly cliFloorBlocked: boolean;
}): UpdateOperationCopy {
  const { view, hostName } = input;
  const primary = primarySentence(view, input.cliFloorBlocked);
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

function primarySentence(
  view: FleetUpdateView,
  cliFloorBlocked: boolean,
): string {
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
    return `Last seen: ${phaseSentence(lastKnown, view, cliFloorBlocked)}`;
  }
  return phaseSentence(view.kind, view, cliFloorBlocked);
}

/**
 * One phase, in words — taking the kind as an ARGUMENT rather than reading
 * `view.kind`, which is what lets the retained-phase sentence above reuse this
 * table instead of growing a parallel one. A second table is how "Downloading
 * update" and "last seen downloading" end up disagreeing about a version suffix.
 */
/**
 * Every phase that names a version uses this, and it is empty when the host did
 * not report one — a sentence must never read "Downloading update to v".
 *
 * Hoisted out of {@link phaseSentence} rather than inlined there so the switch
 * below stays within the complexity budget as the kind union grows; it was
 * always a single expression with a single reason.
 */
function versionSuffix(target: string | null): string {
  return target === null ? "" : ` to v${target}`;
}

function phaseSentence(
  kind: FleetUpdateViewKind,
  view: FleetUpdateView,
  cliFloorBlocked: boolean,
): string {
  const target = view.targetVersion;
  const to = versionSuffix(target);
  switch (kind) {
    case "updating":
      // The coarse marker's whole vocabulary: in flight, phase unknown. Never
      // narrower than that — "Installing" during a three-minute download reads
      // as a stall, and the marker cannot tell the two apart.
      return `Updating host${to}`;
    case "downloading":
      return `Downloading update${to}`;
    case "preparing":
      return `Preparing update${to}`;
    case "applying":
      return `Installing update${to}`;
    case "waiting-for-work":
      return waitingForWorkSentence(view.blockingSessionCount, cliFloorBlocked);
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
    case "finalizing-record":
      // The success first, because the ORDER is the message: the update
      // landed, and the leftover is bookkeeping. Leading with the bookkeeping
      // would read as a qualification on the success.
      //
      // A STATE, not an action. This was "Finalizing the update record." —
      // present-continuous, and wrong, because nothing is in progress: the
      // record is concluded by the next update RUN, so no work is happening on
      // this host and the card has no expiry of its own. (`complete` retires
      // when the record goes terminal and the host moves to `idle`; this kind
      // is DEFINED by a record that has not concluded.) A card with no Retry,
      // no Diagnostics, no poll and no affordance could therefore carry a
      // claim of ongoing work indefinitely — the one sentence on it that gets
      // falser the longer it is shown.
      //
      // The closing clause is what makes the fact bearable: naming the record
      // is right (it is why `traycer host update` just exited non-zero, and a
      // bare "Updated" would leave that contradiction unexplained), but "still
      // open" alone is jargon on a surface offering nothing to do about it.
      // Saying what closes it says nothing is owed of the reader.
      //
      // Deliberately true in both worlds: today nothing on this host ever
      // concludes the record, and once the host reconciler closes that gap the
      // state becomes transient. This sentence survives that change; a
      // present-continuous one would only have become correct by accident.
      //
      // `to` already collapses to "" for an unreported target, so a host that
      // named no version reads "Updated. The update record is still open; …"
      // rather than "Updated to v.".
      return `Updated${to}. The update record is still open; the next update reconciles it.`;
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
function waitingForWorkSentence(
  blockingSessionCount: number | null,
  cliFloorBlocked: boolean,
): string {
  // The FLOOR outranks the count, because on a floor-blocked host the count is
  // not merely uninformative — it is false. Observed on real hardware: an
  // rc-era CLI in the slot, a host sitting `Online · Idle`, and the card
  // reading "Update waits for 0 sessions to finish" while the host's
  // reconciler refused the resume every tick. Nothing was finishing because
  // nothing was running; what the park was waiting for was a CLI that could
  // carry the release at all.
  //
  // It points at the affordance rather than restating the fix: the remedy row
  // is on screen with its own sentence and its own `Show installation help`,
  // and two full remedies for one blocker is the layered narration this page
  // keeps deleting — hence the same shape as `Update status unavailable — see
  // Diagnostics` above.
  //
  // That the row is the ONLY way forward is the CALLER's finding, not a fact
  // about the floor. It holds for a record-derived staged wait, whose Force
  // update… the floor gate withholds (a floored stage is not offerable), and
  // NOT for a bound attempt, whose Force routes to `host.update.continue`
  // against a different floor entirely and can render live beside this
  // sentence. So the Overview passes `false` whenever it is showing a working
  // force control for the park — see `host-overview-panel.tsx`, which is where
  // that question can be answered.
  //
  // Only the WORK park. `waiting-to-activate` names a restart, and a restart
  // into bytes that are already placed is not something a CLI upgrade unblocks;
  // substituting there would trade one wrong sentence for another.
  if (cliFloorBlocked) {
    return "Update waits for Traycer's command-line tools to be updated — see installation help";
  }
  // "Waits", not "will continue": the park is a fact about the stage, and
  // what resumes it is the next update run - a host's own automatic check
  // where one is enabled, or the next Update now - which this sentence has
  // no evidence of. The same copy serves the attempt's own park and the
  // record-derived legacy one.
  if (blockingSessionCount === null) {
    return "Update waits for work to finish";
  }
  return `Update waits for ${describeSessions(blockingSessionCount)} to finish`;
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
 *
 * A `restarting` kind projected from the DURABLE RECORD (D13 — an active
 * record whose holder a probe found alive, within the proof's five-second
 * life) draws the bar for the same reason the wire's `restarting` does, and
 * that is consistent rather than an exception: it is not a retained phase.
 * `kind` is the live phase and `qualified` is false, because a live holder is
 * an observation, not a memory. The instant the proof lapses the projection
 * returns to `unknown` + `lastKnownKind`, and the bar goes with it — through
 * the rule above, with no arm of its own here.
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
