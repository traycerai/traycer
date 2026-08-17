import { type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { PlanRestrictedUpgradeAction } from "@/components/settings/host-scope/plan-restricted-upgrade-action";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { getClientAppVersion } from "@/lib/app-version";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { HostProgressView } from "@/lib/host/host-progress-copy";
import {
  hostUpdateSkew,
  type WindowNarrationCause,
  type WindowNarrationVariant,
} from "@/lib/host/window-narration";

/**
 * THE window narrator (D10, C4, M5): one global surface for the two facts that
 * belong to the window scope - nothing can serve it, or nothing has served it
 * yet.
 *
 * It replaces a layered set of full-screen cards that each owned a slice of
 * the same story. What must not come back: this surface never narrates a
 * switch, a degraded probe, or a single host's outage while another works.
 * Those belong to the surface chip, the tile banner and the toast
 * respectively, and a window-wide modal saying them is the noise this epic
 * deletes.
 *
 * Presentation only, and deliberately so - every decision (visible at all,
 * which variant, which recovery is even offered) is made above and handed down
 * as props, so the precedence rules are pinned against the pure derivation
 * rather than through rendered DOM.
 *
 * DISMISSAL IS NOT AN INPUT. Visibility is derived from the authority, so a
 * recovery closes this by re-derivation. There is no close button, escape or
 * outside-click path, because every one of them would leave a working app
 * behind a stale modal or - worse - a dead app with the only explanation
 * dismissed.
 */
export interface WindowHostModalProps {
  readonly cause: WindowNarrationCause;
  readonly variant: WindowNarrationVariant;
  readonly progress: HostProgressView | null;
  /**
   * The rich local-bootstrap body (live progress, Show details / bootstrap.log,
   * "Configure shell…"), or `null` when this wait is not about this machine.
   *
   * Passed in rather than rendered here because it is only ever CORRECT for a
   * local boot: offering to inspect this machine's bootstrap log while the
   * fleet's only hosts are remote describes the wrong computer, which is the
   * misattribution the readiness controller's loading arm already documents.
   */
  readonly localBootstrapBody: ReactNode | null;
  readonly onRetry: (() => void) | null;
  readonly retryPending: boolean;
  /**
   * Re-runs the host install onto this build. `null` when this app cannot
   * manage the host, or when the handshake says THIS APP is the outdated leg -
   * forcing a host update can never fix an outdated client, so offering it
   * there is an action that could only fail.
   */
  readonly onUpdateHost: (() => void) | null;
  readonly onOpenSettings: () => void;
  /**
   * Whether anything has failed yet. `Report issue` is the affordance that
   * turns a false impression of breakage into real support load, so it renders
   * only once there is a failure for a report to describe.
   *
   * Decided above, like every other action on this surface - see the component
   * doc. A component that re-derived "has something failed" from `cause` would
   * be a second decider, and it would miss the slow arm entirely.
   */
  readonly showReportIssue: boolean;
  /**
   * How much weight `Open settings` carries. Never whether it renders: it is
   * unconditional in every variant and must stay so - it is the escape hatch
   * for a host that cannot start, and a user who reaches this modal with no
   * host has no other route to Settings.
   *
   * A row of equal-weight buttons is itself the "something is wrong, pick one"
   * signal, so on a start that has not failed this is the quiet form.
   */
  readonly settingsEmphasis: "button" | "link";
}

export function WindowHostModal(props: WindowHostModalProps): ReactNode {
  const copy = modalCopy(props.variant, props.cause);
  return (
    <DialogPrimitive.Root open modal>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          data-testid="window-host-modal-overlay"
          className="fixed inset-0 isolate z-[60] bg-black/40 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-testid="window-host-modal"
          data-variant={props.variant.kind}
          data-cause={props.cause}
          aria-describedby={undefined}
          // Every dismissal path is suppressed: see the component doc. The app
          // behind this modal has no host, so "let me close it" is an offer to
          // click on surfaces that cannot answer.
          onEscapeKeyDown={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[85svh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl bg-background p-6 text-foreground ring-1 ring-foreground/10 shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
        >
          <DialogPrimitive.Title
            data-slot="dialog-title"
            data-testid="window-host-modal-title"
            className="font-heading text-lg leading-none font-medium"
          >
            {copy.title}
          </DialogPrimitive.Title>
          <p
            className="text-ui-sm text-muted-foreground"
            data-testid="window-host-modal-description"
          >
            {copy.description}
          </p>
          <WindowHostModalBody
            variant={props.variant}
            progress={props.progress}
            localBootstrapBody={props.localBootstrapBody}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {props.variant.kind === "plan-restricted" ? (
              <PlanRestrictedUpgradeAction />
            ) : null}
            {props.onUpdateHost === null ? null : (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={props.onUpdateHost}
                data-testid="window-host-modal-update-host"
              >
                Update host
              </Button>
            )}
            {props.onRetry === null ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.retryPending}
                onClick={props.onRetry}
                data-testid="window-host-modal-retry"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span>Retry</span>
                  {props.retryPending ? (
                    <AgentSpinningDots
                      className={undefined}
                      testId="window-host-modal-retry-spinner"
                      variant={undefined}
                    />
                  ) : null}
                </span>
              </Button>
            )}
            {/* Settings is reachable from here on purpose, and the route
                bypasses the readiness gate - the shell page edits host
                config without a running host, so this is the escape hatch
                for a host that cannot start. Gating it behind the failure
                it exists to fix is the lockout this whole surface prevents. */}
            <Button
              type="button"
              size="sm"
              variant={props.settingsEmphasis === "button" ? "outline" : "link"}
              onClick={props.onOpenSettings}
              data-testid="window-host-modal-open-settings"
              data-emphasis={props.settingsEmphasis}
            >
              Open settings
            </Button>
            {props.showReportIssue ? (
              <ReportIssueAction
                context={createReportIssueContext({
                  title: copy.reportTitle,
                  message: copy.reportMessage,
                  code: copy.reportCode,
                  source: "Host connection",
                })}
                presentation="text"
                className={undefined}
              />
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function WindowHostModalBody(props: {
  readonly variant: WindowNarrationVariant;
  readonly progress: HostProgressView | null;
  readonly localBootstrapBody: ReactNode | null;
}): ReactNode {
  if (props.variant.kind === "update-host") {
    return <IncompatibleDetail variant={props.variant} />;
  }
  if (props.localBootstrapBody !== null) return props.localBootstrapBody;
  if (props.progress === null) return null;
  return <LaneProgressLine progress={props.progress} />;
}

/**
 * The lane's own words, for the case where the rich local body is not the
 * right thing to draw but the controller is demonstrably doing something.
 *
 * "Traycer can't reach any host" beside a silent screen reads as a dead end
 * even while an install is streaming underneath; this is the line that says
 * the difference.
 */
function LaneProgressLine(props: {
  readonly progress: HostProgressView;
}): ReactNode {
  const { progress } = props;
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border/60 bg-foreground/8 px-3 py-2"
      data-testid="window-host-modal-progress"
    >
      <div className="flex items-center gap-2">
        <AgentSpinningDots
          className="size-3 shrink-0"
          testId={undefined}
          variant={undefined}
        />
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
          {progress.heading}
        </span>
        {progress.percent === null ? null : (
          <span className="shrink-0 font-mono text-code-xs tabular-nums text-muted-foreground">
            {progress.percent}%
          </span>
        )}
      </div>
      {progress.transferLabel === null ? null : (
        <span className="text-ui-xs text-muted-foreground">
          {progress.transferLabel}
        </span>
      )}
      {progress.detail === null ? null : (
        <span className="truncate text-ui-xs text-muted-foreground">
          {progress.detail}
        </span>
      )}
    </div>
  );
}

/**
 * The incompatibility, in the structured terms the lease carried it in.
 *
 * The versions are printed rather than folded into the sentence: "host 1.1.4,
 * this app needs 1.2.0 or newer" is a fact someone can act on or report,
 * where a reason code glued onto a sentence is noise.
 */
function IncompatibleDetail(props: {
  readonly variant: Extract<
    WindowNarrationVariant,
    { readonly kind: "update-host" }
  >;
}): ReactNode {
  const { detail } = props.variant;
  return (
    <div
      className="flex flex-col gap-1 rounded-md bg-foreground/8 px-3 py-2 text-left text-ui-xs text-muted-foreground"
      data-testid="window-host-modal-incompatible-detail"
    >
      {detail.hostVersion === null ? null : (
        <span>Host version: {detail.hostVersion}</span>
      )}
      {detail.minSupportedVersion === null ? null : (
        <span>Minimum supported: {detail.minSupportedVersion}</span>
      )}
      <span className="break-words">Reason: {detail.code}</span>
    </div>
  );
}

interface WindowHostModalCopy {
  readonly title: string;
  readonly description: string;
  readonly reportTitle: string;
  readonly reportMessage: string;
  readonly reportCode: string;
}

/**
 * One wording per state, and the report family chosen with it.
 *
 * The report codes are distinct on purpose: collapsing "this app can't reach
 * any host", "this account's plan excludes them" and "the versions disagree"
 * into one title is what sends triage after a network outage that is not
 * happening.
 *
 * CODE LINEAGE, for anyone grepping an old report: `HOST_NONE_USABLE` and
 * `HOST_COLD_START_FAILED` are the successors to the retired
 * `HOST_NONE_DIALABLE` / `HOST_SELECTED_UNREACHABLE` pair. The distinction is
 * KEPT but re-cut — the old pair branched on `anyHostDialable`, a directory
 * fact this redesign retires, and the new pair branches on CAUSE, which is the
 * lease vocabulary every status surface now derives from. Two codes before,
 * two codes after: "nothing can serve this window" versus "nothing has served
 * it yet". `HOST_PLAN_RESTRICTED` and `HOST_INCOMPATIBLE` are unchanged in
 * meaning and simply reached from here now.
 */
function modalCopy(
  variant: WindowNarrationVariant,
  cause: WindowNarrationCause,
): WindowHostModalCopy {
  if (variant.kind === "plan-restricted") {
    return {
      title: "Your plan doesn't include remote hosts",
      description:
        "The hosts on this account are remote, and this plan can't attach to them. Upgrade to connect, or set up Traycer on this machine.",
      reportTitle: "No host available on this plan",
      reportMessage: "Every host on this account is plan-restricted.",
      reportCode: "HOST_PLAN_RESTRICTED",
    };
  }
  if (variant.kind === "update-host") {
    return {
      // Direction-aware, from the same helper the compat card used, so the two
      // cannot drift while both exist: above the support floor an
      // incompatibility is a bug rather than routine drift, and the copy names
      // the leg the handshake says is behind rather than a generic fatal.
      title: hostUpdateSkew(variant.detail, getClientAppVersion()).title,
      // Two descriptions, because on the fallback arm the first one's advice
      // is something the reader cannot act on from here. "Update the host to
      // continue" beside no button is an unexplained gap; naming the machine
      // and saying where it can be updated is an honest absence.
      description: variant.isTargetHost
        ? "Traycer Host is running a version this app can't talk to. Update the host to continue - your agents and history are untouched."
        : "Another host on this account is running a version this app can't talk to, and it can't be updated from here. Update Traycer on that machine, or switch to a host this one can reach.",
      reportTitle: "Host update required",
      reportMessage: "Traycer Host requires an update.",
      reportCode: "HOST_INCOMPATIBLE",
    };
  }
  if (cause === "cold-start") {
    return {
      title: "Setting up Traycer",
      description:
        "Traycer is getting this machine's host ready. This runs once, and the app opens as soon as it's done.",
      reportTitle: "Traycer Host did not start",
      reportMessage: "Traycer Host did not become available at launch.",
      reportCode: "HOST_COLD_START_FAILED",
    };
  }
  return {
    title: "No host is available",
    description:
      "Traycer can't reach any of this account's hosts right now. It will connect again on its own as soon as one comes back.",
    reportTitle: "No Traycer Host is reachable",
    reportMessage: "No host on this account could be reached.",
    reportCode: "HOST_NONE_USABLE",
  };
}
