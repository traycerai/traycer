import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicExportArtifacts } from "@/hooks/epic/use-epic-export-artifacts-mutation";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import {
  useEpicArtifactRecords,
  useEpicCloudFreshnessView,
  useEpicDurabilityPauseReason,
  useEpicDurabilityPromotionState,
  useEpicDurabilityView,
  useEpicSnapshotMeta,
  type EpicCloudFreshnessView,
  type EpicDurabilityView,
} from "@/lib/epic-selectors";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import type {
  EpicDurabilityPauseReasonV15,
  EpicLocalProtection,
  EpicPromotionState,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * Host routing truth, kept separate from the cloud-sync pill: cloud transport
 * is not enough to tell a person whether their epic is local, promoting, or a
 * locally served cloud mirror.
 */
export function EpicDurabilityBadge() {
  const view = useEpicDurabilityView();
  const freshness = useEpicCloudFreshnessView();
  const pauseReason = useEpicDurabilityPauseReason();
  const promotionState = useEpicDurabilityPromotionState();
  // `s5-mirror-first-serving`. Mirror-first paints a usable document before it
  // is known to be up to date, so the two calm arms below can now be reached by
  // an epic that is genuinely durable AND genuinely behind. Freshness is
  // consulted BEFORE they return null, or the one state this ticket exists to
  // make visible would be the one state the badge stays silent about.
  const freshnessCopy = cloudFreshnessCopy(freshness);
  // Two silences, and only ONE of them is nothing to say.
  //
  // `cloudDurable` is the host positively stating that the epic is in the
  // cloud and this session is locally protected, so there is genuinely no
  // badge to draw - that is the ordinary online case and it stays silent.
  // `legacy` is a pre-`@1.4` peer with no durability answer, which is exactly
  // the rendering it had before this minor.
  //
  // What used to join them is `indeterminate`, and it does not any more: an
  // unknown or unprotected session drew no badge at all, so it looked
  // identical to a protected one. It now draws.
  if (
    view.kind === "cloudDurable" &&
    freshnessCopy === null &&
    // Cloud durability is calm about the DURABILITY axis only, so silence is
    // licensed by a POSITIVE statement on the protection axis too - never by
    // the absence of one. `unavailable` means offline edits die with the
    // process; `unknown` is the host saying it cannot tell, which `@1.5`
    // defines as "rendered as unknown, never as protected". Excluding only
    // `unavailable` here left that second case pixel-identical to `armed` -
    // the same silence-as-reassurance inference this minor exists to break,
    // one axis over.
    view.protection === "armed"
  ) {
    return null;
  }
  if (
    view.kind === "legacy" &&
    view.status === null &&
    freshnessCopy === null
  ) {
    return null;
  }
  return (
    <EpicDurabilityBadgeContent
      view={view}
      pauseReason={pauseReason}
      promotionState={promotionState}
      freshness={freshness}
      freshnessCopy={freshnessCopy}
    />
  );
}

function EpicDurabilityBadgeContent(props: {
  readonly view: EpicDurabilityView;
  readonly pauseReason: EpicDurabilityPauseReasonV15 | null;
  readonly promotionState: EpicPromotionState | null;
  readonly freshness: EpicCloudFreshnessView;
  readonly freshnessCopy: CloudFreshnessCopy | null;
}) {
  const status = viewStatus(props.view);
  const protection = viewProtection(props.view);
  const badge = badgeCopy(props.view, props.pauseReason, props.promotionState);
  const risk = durabilityRiskCopy(props.view);
  const freshnessState =
    props.freshness.kind === "stated" ? props.freshness.state : null;
  return (
    <span
      data-testid="epic-durability-badge"
      data-durability-status={status ?? "unknown"}
      data-local-protection={protection ?? undefined}
      data-pause-reason={props.pauseReason ?? undefined}
      data-promotion-state={props.promotionState ?? undefined}
      data-cloud-freshness={freshnessState ?? undefined}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-ui-xs font-medium",
        // The risk outranks the status for COLOUR even though it does not
        // replace it for text: a pill that says "No local backup" in the calm
        // muted treatment is the same understatement in a different medium.
        // `doubt` outranks it too - an unknown backup is not a detail to bury
        // under "Stored locally" - but in amber, not in the loss colour.
        risk !== null
          ? durabilityRiskClassName(risk.tone)
          : (badge ?? props.freshnessCopy)?.className,
      )}
    >
      {badge === null ? null : <span>{badge.label}</span>}
      <EpicDurabilityRiskLabel
        label={risk === null ? null : risk.label}
        separated={badge !== null}
      />
      {props.freshnessCopy === null ? null : (
        <EpicCloudFreshnessLabel
          copy={props.freshnessCopy}
          separated={badge !== null || risk !== null}
        />
      )}
      <EpicDurabilityRemedies status={status} pauseReason={props.pauseReason} />
    </span>
  );
}

/**
 * The two paused-only remedies, lifted out of the badge body.
 *
 * They own four hooks and a derived artifact list between them, and none of
 * that has anything to say about the badge's LABEL - keeping them inline made
 * one component responsible for both the statement and the actions.
 */
function EpicDurabilityRemedies(props: {
  readonly status: "local" | "promoting" | "paused" | "offline" | null;
  readonly pauseReason: EpicDurabilityPauseReasonV15 | null;
}) {
  const runnerHost = useRunnerHost();
  const exportArtifacts = useEpicExportArtifacts();
  const records = useEpicArtifactRecords();
  const meta = useEpicSnapshotMeta();
  if (props.status !== "paused") return null;
  const artifacts = records.flatMap((record) =>
    isEpicArtifactKind(record.type)
      ? [{ id: record.id, title: record.name }]
      : [],
  );
  const exportLocalArtifacts = (): void => {
    exportArtifacts.mutate({
      artifacts,
      format: "markdown",
      archive: true,
      archiveTitle: meta?.epicLight?.title ?? "Traycer",
    });
  };
  return (
    <>
      {props.pauseReason === "entitlement-lapsed" ? (
        <UpgradeAction authnBaseUrl={runnerHost.authnBaseUrl} />
      ) : null}
      {exportIsTheRemedy(props.pauseReason) ? (
        <ExportArtifactsAction
          disabled={artifacts.length === 0 || exportArtifacts.isPending}
          pending={exportArtifacts.isPending}
          onExport={exportLocalArtifacts}
        />
      ) : null}
    </>
  );
}

/**
 * The badge-wide treatment a protection statement earns. Kept beside the
 * label rather than inside {@link durabilityRiskCopy}'s return so the two
 * unknown renderings - this one and `badgeCopy`'s cloudDurable arm - stay
 * visibly the same amber instead of drifting apart as two literals.
 */
function durabilityRiskClassName(tone: "risk" | "doubt"): string {
  return tone === "risk"
    ? "bg-destructive/10 text-destructive"
    : "bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

/** The protection-risk segment, composed after the status label. */
function EpicDurabilityRiskLabel(props: {
  readonly label: string | null;
  readonly separated: boolean;
}) {
  if (props.label === null) return null;
  return (
    <span data-testid="epic-durability-risk">
      {props.separated ? "\u00b7 " : null}
      {props.label}
    </span>
  );
}

/** Inline pending indicator, at the size the badge's own type scale wants. */
function BadgeActionSpinner() {
  return (
    <AgentSpinningDots
      className="size-3"
      testId={undefined}
      variant={undefined}
    />
  );
}

/**
 * The link goes through `useRunnerOpenExternalLink` rather than the bridge
 * directly: the mutation owns the shared query key and the runner-error toast,
 * so a rejected `openExternalLink` is reported instead of silently dropped.
 */
function UpgradeAction(props: { readonly authnBaseUrl: string }) {
  const openExternalLink = useRunnerOpenExternalLink();
  return (
    <button
      type="button"
      className="underline underline-offset-2"
      data-testid="epic-durability-upgrade"
      disabled={openExternalLink.isPending}
      onClick={() => {
        openExternalLink.mutate(
          resolveManageSubscriptionUrl(props.authnBaseUrl),
        );
      }}
    >
      Upgrade
      {openExternalLink.isPending ? <BadgeActionSpinner /> : null}
    </button>
  );
}

function ExportArtifactsAction(props: {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onExport: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="h-auto px-0 text-current underline underline-offset-2"
      data-testid="epic-durability-export"
      disabled={props.disabled}
      onClick={props.onExport}
    >
      Export artifacts
      {props.pending ? <BadgeActionSpinner /> : null}
    </Button>
  );
}

/**
 * What the badge says about freshness, or `null` when there is nothing to say.
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
 * doc is explicit that a `@1.4` host emits the key wherever it applies.
 *
 * `current` is silent because it is the reassuring answer and the badge's
 * whole design is that it draws only when there is something to say.
 *
 * Everything else draws, including `syncing`: an epic whose document is being
 * checked against the cloud is one whose contents may still change under the
 * reader, and that is worth a word.
 */
type CloudFreshnessCopy = {
  readonly label: string;
  readonly className: string;
  /** Rendered after the label when a reconciliation was ever recorded. */
  readonly reconciledAtEpochMs: number | null;
  /** Shown in place of a timestamp when none was ever recorded. */
  readonly noTimestampLabel: string | null;
};

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
        label: "Local copy",
        className: "bg-foreground/8 text-muted-foreground",
        reconciledAtEpochMs,
        noTimestampLabel: null,
      };
    case "syncing":
      return {
        label: "Checking for updates",
        className: "bg-foreground/8 text-muted-foreground",
        reconciledAtEpochMs,
        noTimestampLabel: null,
      };
    case "stale":
      return {
        // Names the consequence rather than the mechanism, and does not
        // pretend to know HOW far behind: the host knows when it last
        // reconciled, not what changed since.
        label: "Local copy \u2014 may be out of date",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        reconciledAtEpochMs,
        // A closed mirror with no recorded reconciliation is the
        // `freshnessUnknown` arm, and saying so is the point: "never" is a
        // fact a person can act on, an empty space is not.
        noTimestampLabel: "never synced",
      };
  }
}

/**
 * The freshness half of the badge, in its own leaf component.
 *
 * A leaf because {@link useCompactRelativeTime} subscribes to the shared 60s
 * clock, and that module's own guidance is that the subscriber should be the
 * smallest thing that repaints - otherwise every tick re-renders the whole
 * badge and whatever it sits inside.
 */
function EpicCloudFreshnessLabel(props: {
  readonly copy: CloudFreshnessCopy;
  readonly separated: boolean;
}) {
  return (
    <span data-testid="epic-cloud-freshness">
      {props.separated ? "\u00b7 " : null}
      {props.copy.label}
      <EpicCloudFreshnessSuffix copy={props.copy} />
    </span>
  );
}

/**
 * The "· synced 3d" / "· never synced" tail, or nothing.
 *
 * Its own component rather than a nested conditional in the label above:
 * `reconciledAtEpochMs` decides which of two DIFFERENT renderings applies (one
 * of which subscribes to a clock), and the three-way choice reads as three
 * named arms here instead of as a ternary inside a ternary.
 */
function EpicCloudFreshnessSuffix(props: {
  readonly copy: CloudFreshnessCopy;
}) {
  if (props.copy.reconciledAtEpochMs !== null) {
    return (
      <EpicCloudFreshnessTimestamp
        reconciledAtEpochMs={props.copy.reconciledAtEpochMs}
      />
    );
  }
  if (props.copy.noTimestampLabel === null) return null;
  return (
    <span data-testid="epic-cloud-freshness-at">
      {` \u00b7 ${props.copy.noTimestampLabel}`}
    </span>
  );
}

/**
 * The persisted last-reconciliation stamp, which is the datum that survives a
 * restart of a CLOSED mirror.
 *
 * The transition label alone cannot cross that boundary - nothing was running
 * to keep one - so this is what makes "may be out of date" actionable instead
 * of merely worrying.
 */
function EpicCloudFreshnessTimestamp(props: {
  readonly reconciledAtEpochMs: number;
}) {
  const relative = useCompactRelativeTime(props.reconciledAtEpochMs);
  return (
    <span data-testid="epic-cloud-freshness-at">{` \u00b7 synced ${relative}`}</span>
  );
}

/**
 * The pause reasons whose remedy is getting the bytes out.
 *
 * `access-revoked` is the original: the cloud will not take another byte, so
 * the local copy is all there is. `orphaned-local-edits-after-cloud-delete` is
 * the same shape from the other direction and is the ACTIONABLE half of
 * `s5-orphaned-epic-recovery` - the cloud object is gone, this host refused to
 * destroy the never-uploaded edits, and the epic is reachable again precisely
 * so the person can take them somewhere. Reaching a preserved epic and finding
 * nothing to do with it would be the dark archive with a nicer label.
 *
 * The other three paused reasons are deliberately absent: an entitlement lapse
 * has an Upgrade path, and the two delete-bookkeeping reasons are transient
 * states of an epic that is not going anywhere.
 */
function exportIsTheRemedy(
  pauseReason: EpicDurabilityPauseReasonV15 | null,
): boolean {
  return (
    pauseReason === "access-revoked" ||
    pauseReason === "orphaned-local-edits-after-cloud-delete"
  );
}

/** The concrete durability value to render, or `null` for indeterminate. */
function viewStatus(
  view: EpicDurabilityView,
): "local" | "promoting" | "paused" | "offline" | null {
  if (view.kind === "stated") return view.status;
  if (
    view.kind === "legacy" &&
    view.status !== null &&
    view.status !== "unknown" &&
    // A pre-`@1.4` peer cannot emit the two `@1.4`-only members; the guard
    // exists for the type, not for a reachable frame.
    view.status !== "cloud"
  ) {
    return view.status;
  }
  return null;
}

function viewProtection(view: EpicDurabilityView): EpicLocalProtection | null {
  if (view.kind === "legacy") return null;
  return view.protection;
}

/**
 * What the protection axis contributes beside a stated status.
 *
 * `tone` exists because the axis carries two different KINDS of statement and
 * one treatment cannot serve both. `unavailable` is a stated fact about work
 * that will be lost and earns the destructive treatment; `unknown` is the
 * absence of a statement, and painting an absence in the same alarm colour as
 * a confirmed loss is its own dishonesty - the amber `badgeCopy` already uses
 * for every other unknown is the matching one.
 */
interface EpicDurabilityRisk {
  readonly label: string;
  readonly tone: "risk" | "doubt";
}

/**
 * The protection axis rendered BESIDE a stated status, not instead of it.
 *
 * `localProtection` and `durability` are separate axes in the wire contract,
 * and `unavailable` is the one value on either that describes a RISK: edits in
 * an unprotected session do not survive process exit. The `indeterminate` arm
 * of {@link badgeCopy} already says so, because there is no status competing
 * for the label there - but a frame carrying `offline` or `paused` ALONGSIDE
 * `unavailable` took the `stated` arm, which reads only the status and drew
 * "Cloud mirror - offline" with the risk invisible.
 *
 * Composed the way freshness already is rather than given priority over the
 * status: dropping the status would take the paused-only Upgrade / Export
 * remedies down with it, and "which of these two true things matters more" is
 * not a question the badge has to answer.
 */
function durabilityRiskCopy(
  view: EpicDurabilityView,
): EpicDurabilityRisk | null {
  if (view.kind !== "stated" && view.kind !== "cloudDurable") return null;
  if (view.protection === "unavailable") {
    return { label: "No local backup", tone: "risk" };
  }
  // The `stated` sibling of `badgeCopy`'s cloudDurable unknown arm, and the
  // reason that arm was not enough on its own: a stated status answers WHERE
  // the epic lives, `localProtection` answers whether this session's edits are
  // held anywhere, and `unknown` on the second beside `local` on the first is
  // the exact reading `@1.5` exists to forbid - "Stored locally" telling the
  // reader their work is on this disk when no WAL is known to hold it.
  // `cloudDurable` is excluded because `badgeCopy` names it there already, and
  // one badge saying it twice is worse than saying it once.
  if (view.kind === "stated" && view.protection === "unknown") {
    return { label: "Local backup status unknown", tone: "doubt" };
  }
  return null;
}

/**
 * What the badge says, TOTAL over the view - `s5-status-truthfulness`.
 *
 * The `indeterminate` arms are the new ones and they are the reason this
 * function exists in this shape. A `switch` over the raw status enum returned
 * `undefined` for anything it did not name, and the caller dereferenced
 * `.label` straight off it - so `@1.4`'s `unknown` member would not have
 * degraded, it would have thrown. More importantly, the states that reached
 * here as `null` drew NOTHING, which is how an unprotected session came to
 * look exactly like a protected one.
 */
function badgeCopy(
  view: EpicDurabilityView,
  pauseReason: EpicDurabilityPauseReasonV15 | null,
  promotionState: EpicPromotionState | null,
): { readonly label: string; readonly className: string } | null {
  if (view.kind === "cloudDurable") {
    // `null`, not "Storage status unknown", once the epic is positively
    // cloud-durable: the durability half genuinely has nothing to say, and
    // falling through to the unknown copy would answer a question nobody
    // asked and contradict the `"cloud"` the host sent.
    //
    // Except when the PROTECTION leg is the unknown one. The label names that
    // axis specifically rather than reusing "Storage status unknown", which
    // would read as doubt about the cloud statement the host just made.
    // `unavailable` is not here because it is already the risk copy's job.
    return view.protection === "unknown"
      ? {
          label: "Local backup status unknown",
          className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        }
      : null;
  }
  if (view.kind === "indeterminate") {
    // `unavailable` is a stated FACT about risk, not an absence, so it gets
    // the stronger treatment and names the consequence rather than the
    // mechanism - "no local backup" is what a person can act on; "the WAL is
    // unarmed" is not.
    return view.protection === "unavailable"
      ? {
          label: "No local backup",
          className: "bg-destructive/10 text-destructive",
        }
      : {
          label: "Storage status unknown",
          className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        };
  }
  const status = viewStatus(view);
  if (status === null) {
    return {
      label: "Storage status unknown",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (status === "promoting" && promotionState === "pending") {
    return {
      label: "Promotion pending",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  switch (status) {
    case "local":
      return {
        label: "Stored locally",
        className: "bg-foreground/8 text-muted-foreground",
      };
    case "promoting":
      return {
        label: "Promoting to cloud",
        className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
      };
    case "offline":
      return {
        label: "Cloud mirror \u2014 offline",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "paused":
      return pausedCopy(pauseReason);
  }
}

/**
 * The paused arm, widened for `@1.4`'s three delete-path reasons -
 * `s5-status-truthfulness` instance 2.
 *
 * All three used to arrive as a bare `paused` and render "Sync paused", which
 * is true and useless. `orphaned-local-edits-after-cloud-delete` is the
 * actionable one: the epic holds local edits the deleted cloud copy never
 * received, so it is the only member here that is a warning rather than a
 * status.
 */
function pausedCopy(pauseReason: EpicDurabilityPauseReasonV15 | null): {
  readonly label: string;
  readonly className: string;
} {
  switch (pauseReason) {
    case "access-revoked":
      return {
        label: "Sync blocked \u2014 access revoked",
        className: "bg-destructive/10 text-destructive",
      };
    case "orphaned-local-edits-after-cloud-delete":
      return {
        label: "Deleted in cloud \u2014 local edits kept here",
        className: "bg-destructive/10 text-destructive",
      };
    case "delete-pending-acknowledgement":
      return {
        label: "Delete pending",
        className: "bg-foreground/8 text-muted-foreground",
      };
    case "delete-tombstone-unscoped-cleared":
      return {
        label: "Delete recorded \u2014 tidying up",
        className: "bg-foreground/8 text-muted-foreground",
      };
    case "entitlement-lapsed":
    case null:
      return {
        label: "Sync paused",
        className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
  }
}
