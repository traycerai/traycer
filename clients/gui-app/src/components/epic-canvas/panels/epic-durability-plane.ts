import {
  useEpicCloudFreshnessView,
  useEpicDurabilityPauseReason,
  useEpicDurabilityPromotionState,
  useEpicDurabilityView,
  type EpicCloudFreshnessView,
  type EpicDurabilityView,
} from "@/lib/epic-selectors";
import { formatCompactRelativeTime, useSampledNow } from "@/lib/relative-time";
import type {
  EpicDurabilityPauseReasonV15,
  EpicPromotionState,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * Host routing truth as ONE plane of the connection pill: where the epic
 * stands (not synced yet, syncing, offline against its mirror, paused),
 * whether this session's edits are held anywhere, and how current the served
 * copy is.
 *
 * ## The clauses never say "cloud" or "local"
 *
 * The person reading the pill knows their epic; which side of the sync each
 * fact came from is not a thing they hold in their head, and a sentence built
 * from that vocabulary ("Cloud mirror — offline · Local copy — may be out of
 * date") reads as plumbing. Every clause below names the condition as the
 * person experiences it (offline, not synced, not backed up, may be out of
 * date) and, where there is one, what to do. The task list follows the same
 * rule (`history-pin-availability.ts`).
 *
 * ## A plane, not a badge
 *
 * This used to be its own pill beside the connection dot, and it said
 * everything inline: "Offline — sync paused · Saved copy — may be out of
 * date · synced 3d" sat in the status row for the whole of an outage. Three
 * clauses is the honest reading of that state, and rendered inline it was a
 * banner, which reads as an alarm rather than a status. So the whole reading
 * now feeds `EpicConnectionPill` as one more plane: the dot's colour is the
 * summary, the sentence is its tooltip and accessible name, and a second
 * degraded plane rides the same hover instead of claiming its own light.
 *
 * The one thing that stays in the row is an ACTION. The paused-only remedies
 * (Upgrade, Export artifacts) are things a person has to click, and a tooltip
 * is not a place to click - `EpicDurabilityRemedies`, which lives in its own
 * `.tsx` beside this file because a module that exports a component may
 * export nothing else (`react(only-export-components)`).
 */
export interface EpicDurabilityPlane {
  /**
   * The pill's severity vocabulary. `danger` is a stated fact about work that
   * will be lost (not backed up, sync blocked, deleted under unsynced
   * edits); `warning` is a statement the host could not make, or a
   * mirror that may be behind; `activity` is a promotion or a reconciliation
   * in flight; `steady` is a fact with nothing to worry about (not synced
   * yet, a saved copy, delete bookkeeping). A reading with several
   * things to say takes the strongest, because the dot is what a glance reads
   * and a glance must not see calm over a loss.
   */
  readonly severity: "steady" | "activity" | "warning" | "danger";
  /**
   * The whole statement, in reading order: where the epic lives, then the
   * protection risk beside it, then how current the local copy is and when
   * it was last reconciled. One string, so the tooltip and the accessible
   * name can never say different things.
   */
  readonly sentence: string;
}

/**
 * The composed durability reading for the open epic, or `null` when there is
 * nothing to say.
 *
 * Subscribes to the shared 60s clock for the "synced 3d" stamp. That clock
 * tick re-renders the caller, so call this from the status row rather than
 * from the shell - the row is a handful of controls and a minute is a long
 * time.
 */
export function useEpicDurabilityPlane(): EpicDurabilityPlane | null {
  const view = useEpicDurabilityView();
  const freshness = useEpicCloudFreshnessView();
  const pauseReason = useEpicDurabilityPauseReason();
  const promotionState = useEpicDurabilityPromotionState();
  const now = useSampledNow();
  return deriveEpicDurabilityPlane({
    view,
    freshness,
    pauseReason,
    promotionState,
    now,
  });
}

export interface EpicDurabilityPlaneInputs {
  readonly view: EpicDurabilityView;
  readonly freshness: EpicCloudFreshnessView;
  readonly pauseReason: EpicDurabilityPauseReasonV15 | null;
  readonly promotionState: EpicPromotionState | null;
  /** The sampled clock the "synced 3d" stamp is measured against. */
  readonly now: number;
}

/** The pure half of {@link useEpicDurabilityPlane}, for tests and reuse. */
export function deriveEpicDurabilityPlane(
  inputs: EpicDurabilityPlaneInputs,
): EpicDurabilityPlane | null {
  const { view, pauseReason, promotionState, now } = inputs;
  // `s5-mirror-first-serving`. Mirror-first paints a usable document before it
  // is known to be up to date, so the two calm arms below can now be reached by
  // an epic that is genuinely durable AND genuinely behind. Freshness is
  // consulted BEFORE they return null, or the one state this ticket exists to
  // make visible would be the one state the plane stays silent about.
  const freshness = cloudFreshnessCopy(inputs.freshness);
  // Two silences, and only ONE of them is nothing to say.
  //
  // `cloudDurable` is the host positively stating that the epic is in the
  // cloud and this session is locally protected, so there is genuinely
  // nothing to add - that is the ordinary online case and it stays silent.
  // `legacy` is a pre-`@1.6` peer with no durability answer, which is exactly
  // the rendering it had before this minor.
  //
  // What used to join them is `indeterminate`, and it does not any more: an
  // unknown or unprotected session said nothing at all, so it looked
  // identical to a protected one. It now speaks.
  if (
    view.kind === "cloudDurable" &&
    freshness === null &&
    // Cloud durability is calm about the DURABILITY axis only, so silence is
    // licensed by a POSITIVE statement on the protection axis too - never by
    // the absence of one. `unavailable` means offline edits die with the
    // process; `unknown` is the host saying it cannot tell, which `@1.6`
    // defines as "rendered as unknown, never as protected". Excluding only
    // `unavailable` here left that second case pixel-identical to `armed` -
    // the same silence-as-reassurance inference this minor exists to break,
    // one axis over.
    view.protection === "armed"
  ) {
    return null;
  }
  if (view.kind === "legacy" && view.status === null && freshness === null) {
    return null;
  }
  const status = statusCopy(view, pauseReason, promotionState);
  const risk = durabilityRiskCopy(view);
  const clauses: string[] = [];
  if (status !== null) clauses.push(status.label);
  if (risk !== null) clauses.push(risk.label);
  if (freshness !== null) clauses.push(freshnessClause(freshness, now));
  return {
    severity: strongestSeverity([
      status?.severity ?? null,
      risk?.severity ?? null,
      freshness?.severity ?? null,
    ]),
    sentence: clauses.join(" · "),
  };
}

const SEVERITY_RANK: Readonly<Record<EpicDurabilityPlane["severity"], number>> =
  {
    steady: 0,
    activity: 1,
    warning: 2,
    danger: 3,
  };

function strongestSeverity(
  severities: ReadonlyArray<EpicDurabilityPlane["severity"] | null>,
): EpicDurabilityPlane["severity"] {
  let strongest: EpicDurabilityPlane["severity"] = "steady";
  for (const severity of severities) {
    if (
      severity !== null &&
      SEVERITY_RANK[severity] > SEVERITY_RANK[strongest]
    ) {
      strongest = severity;
    }
  }
  return strongest;
}

/**
 * What the plane says about freshness, or `null` when there is nothing to say.
 *
 * ## The two silent arms, and why they are not the same silence
 *
 * `unknown` is silent because the host omits `freshness` for the cases where
 * the question does not apply - a local-homed epic has no cloud copy to be
 * behind, and a cloud row this host has no record of has no evidence either
 * way. Rendering "freshness unknown" for those would be a warning about
 * nothing, on every epic, forever. This is the one place in the s5 status pass
 * where absence is calm, and it is calm because the host's absence is a
 * STATEMENT of inapplicability rather than a failure to answer - the protocol
 * doc is explicit that a `@1.6` host emits the key wherever it applies.
 *
 * `current` is silent because it is the reassuring answer and the plane's
 * whole design is that it speaks only when there is something to say.
 *
 * Everything else speaks, including `syncing`: an epic whose document is
 * being checked against the cloud is one whose contents may still change
 * under the reader, and that is worth a word.
 */
interface CloudFreshnessCopy {
  readonly label: string;
  readonly severity: EpicDurabilityPlane["severity"];
  /** Rendered after the label when a reconciliation was ever recorded. */
  readonly reconciledAtEpochMs: number | null;
  /** Said in place of a timestamp when none was ever recorded. */
  readonly noTimestampLabel: string | null;
}

function cloudFreshnessCopy(
  view: EpicCloudFreshnessView,
): CloudFreshnessCopy | null {
  if (view.kind === "unknown") return null;
  const reconciledAtEpochMs = view.reconciledAtEpochMs;
  switch (view.state) {
    case "current":
      return null;
    case "local-copy":
      return {
        label: "Saved copy",
        severity: "steady",
        reconciledAtEpochMs,
        noTimestampLabel: null,
      };
    case "syncing":
      return {
        label: "Checking for updates",
        severity: "activity",
        reconciledAtEpochMs,
        noTimestampLabel: null,
      };
    case "stale":
      return {
        // Names the consequence rather than the mechanism, and does not
        // pretend to know HOW far behind: the host knows when it last
        // reconciled, not what changed since.
        label: "Saved copy — may be out of date",
        severity: "warning",
        reconciledAtEpochMs,
        // A closed mirror with no recorded reconciliation is the
        // `freshnessUnknown` arm, and saying so is the point: "never" is a
        // fact a person can act on, an empty space is not.
        noTimestampLabel: "never synced",
      };
  }
}

/**
 * The freshness clause with its "· synced 3d" / "· never synced" tail.
 *
 * The persisted last-reconciliation stamp is the datum that survives a
 * restart of a CLOSED mirror - nothing was running to keep a transition
 * label - so it is what makes "may be out of date" actionable instead of
 * merely worrying.
 */
function freshnessClause(copy: CloudFreshnessCopy, now: number): string {
  if (copy.reconciledAtEpochMs !== null) {
    return `${copy.label} · synced ${formatCompactRelativeTime(copy.reconciledAtEpochMs, now)}`;
  }
  if (copy.noTimestampLabel === null) return copy.label;
  return `${copy.label} · ${copy.noTimestampLabel}`;
}

/**
 * The concrete durability value, or `null` for indeterminate.
 *
 * Exported for `EpicDurabilityRemedies`, which gates its provider-bound hooks
 * on the same `paused` reading this uses.
 */
export function viewStatus(
  view: EpicDurabilityView,
): "local" | "promoting" | "paused" | "offline" | null {
  if (view.kind === "stated") return view.status;
  if (
    view.kind === "legacy" &&
    view.status !== null &&
    view.status !== "unknown" &&
    // A pre-`@1.6` peer cannot emit the two `@1.6`-only members; the guard
    // exists for the type, not for a reachable frame.
    view.status !== "cloud"
  ) {
    return view.status;
  }
  return null;
}

interface DurabilityClause {
  readonly label: string;
  readonly severity: EpicDurabilityPlane["severity"];
}

/**
 * The protection axis BESIDE a stated status, not instead of it.
 *
 * `localProtection` and `durability` are separate axes in the wire contract,
 * and `unavailable` is the one value on either that describes a RISK: edits in
 * an unprotected session do not survive process exit. The `indeterminate` arm
 * of {@link statusCopy} already says so, because there is no status competing
 * for the sentence there - but a frame carrying `offline` or `paused`
 * ALONGSIDE `unavailable` takes the `stated` arm, which reads only the
 * status and would say "Cloud mirror — offline" with the risk invisible.
 *
 * `unknown` gets the doubt treatment, not the loss one: it is the absence of
 * a statement, and painting an absence in the same alarm colour as a
 * confirmed loss is its own dishonesty.
 */
function durabilityRiskCopy(view: EpicDurabilityView): DurabilityClause | null {
  if (view.kind !== "stated" && view.kind !== "cloudDurable") return null;
  // Scoped to NEW edits, and prospective, on purpose. Beside `cloudDurable`
  // the task itself is backed up, and only what is typed here while the WAL
  // is unarmed lives nowhere but this window until it syncs - so "Not backed
  // up" without a subject read as a claim about the whole task, and "Recent
  // changes only in this window" claimed edits this plane cannot see exist
  // (it receives no dirty signal; a read-only or freshly opened task is in
  // this state with nothing typed). The clause names the risk to what WILL be
  // typed, which is what the protocol value actually states.
  if (view.protection === "unavailable") {
    return {
      label: "New edits only in this window until synced",
      severity: "danger",
    };
  }
  // The `stated` sibling of `statusCopy`'s cloudDurable unknown arm, and the
  // reason that arm was not enough on its own: a stated status answers WHERE
  // the epic lives, `localProtection` answers whether this session's edits are
  // held anywhere, and `unknown` on the second beside `local` on the first is
  // the exact reading `@1.6` exists to forbid - "Not synced yet" telling the
  // reader their work is safely held when no WAL is known to hold it.
  // `cloudDurable` is excluded because `statusCopy` names it there already,
  // and one sentence saying it twice is worse than saying it once.
  // Same subject as the arm above: it is the protection of NEW edits that is
  // unknown, never the task's copy - which a stated status beside this clause
  // has already described.
  if (view.kind === "stated" && view.protection === "unknown") {
    return { label: "New edits — backup status unknown", severity: "warning" };
  }
  return null;
}

/**
 * What the plane says about WHERE the epic lives, TOTAL over the view -
 * `s5-status-truthfulness`.
 *
 * The `indeterminate` arms are the reason this function exists in this
 * shape. A `switch` over the raw status enum returned `undefined` for
 * anything it did not name, so `@1.6`'s `unknown` member would have thrown
 * rather than degraded. More importantly, the states that reached here as
 * `null` said NOTHING, which is how an unprotected session came to look
 * exactly like a protected one.
 */
function statusCopy(
  view: EpicDurabilityView,
  pauseReason: EpicDurabilityPauseReasonV15 | null,
  promotionState: EpicPromotionState | null,
): DurabilityClause | null {
  if (view.kind === "cloudDurable") {
    // `null`, not "Storage status unknown", once the epic is positively
    // cloud-durable: the durability half genuinely has nothing to say, and
    // falling through to the unknown copy would answer a question nobody
    // asked and contradict the `"cloud"` the host sent.
    //
    // Except when the PROTECTION leg is the unknown one. The label names that
    // axis specifically - and its subject, NEW edits - rather than reusing
    // "Storage status unknown" or an unqualified "Backup status unknown",
    // either of which would read as doubt about the durable copy the host
    // just positively reported. `unavailable` is not here because it is
    // already the risk copy's job.
    return view.protection === "unknown"
      ? { label: "New edits — backup status unknown", severity: "warning" }
      : null;
  }
  if (view.kind === "indeterminate") {
    // `unavailable` is a stated FACT about risk, not an absence, so it gets
    // the stronger treatment and names the consequence rather than the
    // mechanism - "new edits only in this window" is what a person can act
    // on; "the WAL is unarmed" is not. Same subject and tense as the risk
    // clause below: what will be typed, never the task.
    return view.protection === "unavailable"
      ? {
          label: "New edits only in this window until synced",
          severity: "danger",
        }
      : { label: "Storage status unknown", severity: "warning" };
  }
  const status = viewStatus(view);
  if (status === null) {
    return { label: "Storage status unknown", severity: "warning" };
  }
  if (status === "promoting" && promotionState === "pending") {
    return { label: "Sync pending", severity: "warning" };
  }
  switch (status) {
    case "local":
      return { label: "Not synced yet", severity: "steady" };
    case "promoting":
      return { label: "Syncing", severity: "activity" };
    // The epic HAS a synced copy and this host is serving its mirror of it
    // while the link is down. "Offline" is the condition; "sync paused" is
    // what it means for edits made now, and the freshness clause beside it
    // says how current the served copy is.
    case "offline":
      return { label: "Offline — sync paused", severity: "warning" };
    case "paused":
      return pausedCopy(pauseReason);
  }
}

/**
 * The paused arm, widened for `@1.6`'s three delete-path reasons -
 * `s5-status-truthfulness` instance 2.
 *
 * All three used to arrive as a bare `paused` and read "Sync paused", which
 * is true and useless. `orphaned-local-edits-after-cloud-delete` is the
 * actionable one: the epic holds local edits the deleted cloud copy never
 * received, so it is the only member here that is a warning rather than a
 * status.
 */
function pausedCopy(
  pauseReason: EpicDurabilityPauseReasonV15 | null,
): DurabilityClause {
  switch (pauseReason) {
    case "access-revoked":
      return { label: "Sync blocked — access revoked", severity: "danger" };
    case "orphaned-local-edits-after-cloud-delete":
      return {
        // The same sentence the task list's preserved-orphan section wears,
        // so the row and the open epic agree.
        label: "Deleted — unsynced edits kept",
        severity: "danger",
      };
    case "delete-pending-acknowledgement":
      return { label: "Delete pending", severity: "steady" };
    case "delete-tombstone-unscoped-cleared":
      return { label: "Delete recorded — tidying up", severity: "steady" };
    case "entitlement-lapsed":
    case null:
      return { label: "Sync paused", severity: "warning" };
  }
}
