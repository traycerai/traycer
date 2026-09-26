import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UpdateProgressBar } from "@/components/host/update-progress-bar";
import {
  describeUpdateOperation,
  operationProgressBytes,
  operationProgressPercent,
  showsProgressBar,
} from "@/components/home/host-update-operation-copy";
import {
  offersForceRestart,
  type FleetUpdateView,
  type FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";
import { cn } from "@/lib/utils";
import type { HostUpdateCompletion } from "@/hooks/host/use-host-update-completion";

/**
 * The selected host's update operation, on its Overview.
 *
 * Deliberately the SAME two functions the landing banner renders from —
 * `describeUpdateOperation` for the sentence and `offersForceRestart` for the
 * affordance — so the two surfaces cannot describe one attempt differently or
 * disagree about whether force is offered. Successful updates are acknowledged
 * here with a dismissible notice that auto-collapses; landing shows no success.
 *
 * WHAT IT DOES NOT DO, which is the load-bearing half:
 *
 * It disables nothing outside itself. No prop reaches it that could, and it
 * renders no overlay. A busy, parked, failed or stale attempt changes what this
 * card SAYS and whether it offers **Force restart…**; Restart, Diagnostics,
 * Activate and the overflow menu are untouched and stay operable throughout.
 * The overflow Restart remains the secondary path to the same place, so a
 * person is never required to engage with this card to recover their host.
 *
 * That is a product rule with teeth: the states most likely to make someone
 * want to restart — parked on live work, or failed — are exactly the states a
 * page-wide lock would trap them in.
 *
 * Only successful updates can be dismissed here. Failed attempts remain
 * discoverable in this Overview even after dismissal on the landing page. The
 * acknowledgement itself is the PANEL's (`completion`), so this card's own
 * mount and unmount never restart its timer.
 *
 * Retry and Diagnostics are likewise absent ON PURPOSE. Both already exist on
 * this page: the version rows below are how a person installs again, and the
 * Doctor card is Diagnostics. The landing banner needs its own copies because
 * it is nowhere near either. Adding a second pair here would be the layered
 * narration this codebase keeps deleting.
 *
 * The two record-derived parks (`legacy-update-facts.ts`) are the exception
 * that proves the rule, and each gets exactly one control. **Restart** on
 * activation debt is not a second Restart: it opens the SAME confirmation the
 * overflow Restart opens, and it exists because the card's own sentence
 * ("Update installed — restart host to finish") names that action and a
 * sentence that names an action three clicks away is a dead end. **Force
 * update…** on a staged wait has no counterpart anywhere else on the page -
 * the version rows install without force, and force is precisely what a
 * parked stage needs.
 *
 * ## The same two controls now serve a THIRD source, and this file cannot tell
 *
 * When the view carries an ATTEMPT and the host advertises the bound update
 * methods, the panel routes these two handlers to `host.update.activate` and
 * `host.update.continue` against that attempt instead (D17). Deliberately no
 * new prop and no new branch here: the decision is "what is this park waiting
 * for, and can this host be asked directly", which is a question about the
 * host's capabilities and the attempt's continuation — neither of which this
 * component has any business knowing. It renders a control when it is handed
 * one, which is exactly as much as it did before.
 */
export function HostOverviewOperationCard(props: {
  readonly view: FleetUpdateView;
  readonly hostName: string;
  /**
   * Opens the EXISTING force-restart confirmation. Never restarts directly —
   * the ellipsis on the button is a promise, and the confirmation is what
   * re-reads live work before anything happens.
   */
  readonly onForceRestart: (() => void) | null;
  /**
   * The way out of an activation park, whichever kind of park it is.
   *
   * For an ATTEMPT park on a host with `host.update.activate` this opens the
   * activation dialog, whose Force dispatches the bound method — locally and
   * remotely alike, which is new: the legacy route's busy verdict could only
   * ever be answered on a Desktop-local host and toasted "declined" on a
   * remote one.
   *
   * Otherwise the RECORDS say the install is ahead of the running host
   * (activation debt, `legacy-update-facts.ts`) and this is the page's
   * cooperative restart: the same confirm → transition id → busy verdict →
   * force/defer flow the header's Restart runs. `null` when there is neither,
   * and `null` when the scope cannot reach the host: the fact is a cached read
   * that outlives reachability, and the sentence (rendered qualified) is
   * evidence worth keeping while a dispatch through a dead route is not.
   *
   * Keyed on the FACT rather than on `view.kind`, deliberately. The kind is
   * `waiting-to-activate` when nothing outranks the fact, but a retained
   * `failed` marker from an earlier run outranks it and keeps its failure
   * text — real evidence, not to be papered over — and the person still needs
   * the way forward. So Restart renders beside either sentence.
   */
  readonly onRestart: (() => void) | null;
  /**
   * The way out of a staged/working wait, whichever kind it is.
   *
   * For an ATTEMPT park on a host with `host.update.continue` this opens the
   * force dialog for that attempt — which works with NO stage on disk, the
   * case the install route cannot express at all (there is no staged version
   * to name). Otherwise the RECORDS say a newer host is staged and the running
   * host is busy, and this dispatches
   * `host.update.install {version: staged, force}` through the page's existing
   * install mutation.
   *
   * `null` when there is neither, when the host reported no positive session
   * count to name — `offersForceRestart` gates the button on exactly that
   * count, for both sources — and when the scope cannot reach the host, as for
   * `onRestart`.
   */
  readonly onForceUpdate: (() => void) | null;
  /**
   * Whether the region's CLI-floor lane is active — passed straight through to
   * `describeUpdateOperation`, which is the only thing that reads it.
   *
   * A prop rather than something derived here for the reason the header of this
   * file gives: the card decides nothing. "Is this host's CLI below the
   * projected release's floor" is a question about the update region's summary
   * walk, and the region already answers it to choose between Update now and
   * the remedy row.
   */
  readonly cliFloorBlocked: boolean;
  /**
   * The success acknowledgement (`useHostUpdateCompletion`), held by the
   * panel so this card's own mount and unmount never restart its timer.
   */
  readonly completion: HostUpdateCompletion;
}): ReactNode {
  const { view, completion } = props;
  if (completion.dismissed) return null;

  const copy = describeUpdateOperation({
    view,
    hostName: props.hostName,
    cliFloorBlocked: props.cliFloorBlocked,
  });
  const percent = operationProgressPercent(view);
  const bytes = operationProgressBytes(view);
  const showProgress = showsProgressBar(view);
  return (
    <div
      // `aria-live` here rather than on a wrapper: phase changes should be
      // announced, and a failure asserted. Matches the landing banner exactly,
      // so a person hears the same thing about the same attempt wherever they
      // happen to be looking.
      aria-live={copy.assertive ? "assertive" : "polite"}
      aria-label={copy.accessibleLabel}
      data-testid="host-overview-operation-card"
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2 text-ui-sm",
        operationCardTone(view),
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 flex-1"
          data-testid="host-overview-operation-phase"
        >
          {copy.primary}
          {/*
            `needsQualifiedMarker`, not `view.qualified` — a sentence that
            already reads "Last seen: …" must not also carry "(last known)".
          */}
          {copy.needsQualifiedMarker ? (
            <span
              className="ml-1 opacity-70"
              data-testid="host-overview-operation-qualified"
            >
              (last known)
            </span>
          ) : null}
        </span>
        {/* Measured bytes whenever the host reported them — including with no
            percentage, where the bar alone says nothing at all. */}
        {bytes === null ? null : (
          <span
            className="shrink-0 font-mono text-code-xs tabular-nums opacity-80"
            data-testid="host-overview-operation-bytes"
          >
            {bytes}
          </span>
        )}
        {percent === null ? null : (
          <span className="shrink-0 font-mono text-code-xs tabular-nums">
            {percent}%
          </span>
        )}
        {props.onRestart === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="default"
            className="shrink-0"
            onClick={props.onRestart}
            data-testid="host-overview-operation-restart"
          >
            Restart
          </Button>
        )}
        {/* `offersForceRestart` gates both forces on a positive, host-reported
            count; `ForceControl` picks which one. */}
        {offersForceRestart(view) ? (
          <ForceControl
            onForceUpdate={props.onForceUpdate}
            onForceRestart={props.onForceRestart}
          />
        ) : null}
        {completion.dismiss === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss"
            className="shrink-0"
            onClick={completion.dismiss}
            data-testid="host-overview-operation-dismiss"
          >
            <X className="size-3" aria-hidden />
          </Button>
        )}
      </div>
      {showProgress ? (
        <UpdateProgressBar
          percent={percent}
          label={copy.accessibleLabel}
          className={undefined}
        />
      ) : null}
    </div>
  );
}

/**
 * The card's tone, by what the update is doing: info while it runs, warning
 * while it waits on someone, destructive when it failed, success when it
 * landed. A view the page can no longer vouch for (`unknown`, or `qualified`)
 * stays neutral, because a tone is a claim about the present. A failure is the
 * exception: the host still holds that record, so it stays true after contact
 * is lost, and it kept its red before this table existed.
 *
 * `bg-foreground/5`, never `bg-muted`, for the neutral arm: this card sits on
 * the raised Overview surface, where every preset theme's dark variant
 * collapses `--muted` into the card colour and the fill would simply vanish.
 */
const NEUTRAL_TONE = "border-border/60 bg-foreground/5";
const INFO_TONE = "border-info/30 bg-info/10 text-info-foreground";
const WARNING_TONE = "border-warning/30 bg-warning/10 text-warning-foreground";

const OPERATION_CARD_TONE: Record<FleetUpdateViewKind, string> = {
  updating: INFO_TONE,
  downloading: INFO_TONE,
  preparing: INFO_TONE,
  applying: INFO_TONE,
  restarting: INFO_TONE,
  reconnecting: INFO_TONE,
  verifying: INFO_TONE,
  "waiting-for-work": WARNING_TONE,
  "waiting-to-activate": WARNING_TONE,
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  complete: "border-success/30 bg-success/10 text-success-foreground",
  "finalizing-record": NEUTRAL_TONE,
  "verification-refused": NEUTRAL_TONE,
  unavailable: NEUTRAL_TONE,
  idle: NEUTRAL_TONE,
  unknown: NEUTRAL_TONE,
};

function operationCardTone(view: FleetUpdateView): string {
  // A failure keeps its red however the page holds it: read live, qualified,
  // or retained as the last phase of a view that aged into `unknown`. The
  // picker's retained word for it ("update failed") is the same claim.
  const described = view.kind === "unknown" ? view.lastKnownKind : view.kind;
  if (described === "failed") return OPERATION_CARD_TONE.failed;
  if (view.qualified) return NEUTRAL_TONE;
  return OPERATION_CARD_TONE[view.kind];
}

/**
 * The one force control the card offers when `offersForceRestart` holds.
 * Which force it is depends on WHO parked: a record-derived staged wait has
 * no attempt to force-restart into, so its way forward is the updater itself
 * re-run with `--force`; an attempt-record park keeps the force-restart route.
 *
 * Destructive-styled, both of them: each ends the running work it names, and
 * the Overview styles every control that does (Apply now, and the busy
 * dialogs' Force) the same way. Restart beside them stays ordinary.
 */
function ForceControl(props: {
  readonly onForceUpdate: (() => void) | null;
  readonly onForceRestart: (() => void) | null;
}): ReactNode {
  if (props.onForceUpdate !== null) {
    return (
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="shrink-0"
        onClick={props.onForceUpdate}
        data-testid="host-overview-operation-force-update"
      >
        Force update…
      </Button>
    );
  }
  if (props.onForceRestart === null) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="destructive"
      className="shrink-0"
      onClick={props.onForceRestart}
      data-testid="host-overview-operation-force-restart"
    >
      Force restart…
    </Button>
  );
}
