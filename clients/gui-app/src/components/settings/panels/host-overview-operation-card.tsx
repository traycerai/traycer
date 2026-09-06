import type { ReactNode } from "react";
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
} from "@/lib/host/fleet-update/fleet-update-view";
import { cn } from "@/lib/utils";

/**
 * The selected host's update operation, on its Overview.
 *
 * Deliberately the SAME two functions the landing banner renders from —
 * `describeUpdateOperation` for the sentence and `offersForceRestart` for the
 * affordance — so the two surfaces cannot describe one attempt differently or
 * disagree about whether force is offered. This component owns layout and
 * nothing else; every decision it looks like it is making was already made in
 * the projection.
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
 * IT ALSO DOES NOT READ THE LANDING BANNER'S DISMISSAL STATE, and that omission
 * is load-bearing rather than incidental. Dismissing a failed update on the home
 * screen is client-local presentation state; "the failure remains discoverable
 * in the selected-host Overview until host-side expiry or a newer attempt
 * supersedes it" (experience doc). This card IS that Overview. Wiring
 * `landingDismissedAttemptIds` in here — an easy-looking consistency fix —
 * would delete the evidence the dismissal was explicitly allowed to hide only
 * from the other surface.
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
}): ReactNode {
  const { view } = props;
  const copy = describeUpdateOperation({ view, hostName: props.hostName });
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
        // `bg-foreground/5`, never `bg-muted`: this card sits on the raised
        // Overview surface, where every preset theme's dark variant collapses
        // `--muted` into the card colour and the fill would simply vanish.
        view.kind === "failed"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border/60 bg-foreground/5",
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
 * The one force control the card offers when `offersForceRestart` holds.
 * Which force it is depends on WHO parked: a record-derived staged wait has
 * no attempt to force-restart into, so its way forward is the updater itself
 * re-run with `--force`; an attempt-record park keeps the force-restart route.
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
        variant="default"
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
      variant="default"
      className="shrink-0"
      onClick={props.onForceRestart}
      data-testid="host-overview-operation-force-restart"
    >
      Force restart…
    </Button>
  );
}
