import { type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HostBootCard } from "@/components/centered-card";
import { BELOW_APP_HEADER_TOP_CLASS } from "@/components/layout/header/app-header-height";
import { PlanRestrictedUpgradeAction } from "@/components/settings/host-scope/plan-restricted-upgrade-action";
import { ClientUpdateRequiredAction } from "@/components/host/client-update-required-action";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { getClientAppVersion } from "@/lib/app-version";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { usePressStartActivation } from "@/lib/host/press-start-activation";
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
 * TWO PRESENTATIONS, one narrator. While the readiness gate still BLOCKS the
 * window (cold start - there is no app behind this surface), the narration
 * renders as {@link WindowHostStartupCard}: a full-screen centered card in the
 * gate's own frame, with NO overlay, NO pointer trap and NO focus trap. A
 * launch is not an interruption, and the modal form here is what made the
 * update toast - and every other toast - visible but dead for the whole of
 * first-run (measured: `pointer-events: none` computed on toast, action and
 * close behind the Radix modal). Once the gate has latched and a real app is
 * mounted, the ∅ verdict renders as {@link WindowHostModal}, the blocking
 * dialog - there the app behind the surface genuinely cannot answer, which is
 * the one situation a modal tells the truth about.
 *
 * Presentation only, and deliberately so - every decision (visible at all,
 * which presentation, which variant, which recovery is even offered) is made
 * above and handed down as props, so the precedence rules are pinned against
 * the pure derivation rather than through rendered DOM.
 *
 * DISMISSAL IS NOT AN INPUT, in either presentation. Visibility is derived
 * from the authority, so a recovery closes this by re-derivation. The dialog
 * additionally suppresses escape/outside-click because a dead app behind it
 * has nothing to offer; the card needs no such suppression - it has no
 * overlay, and the gate behind it is already inert.
 */
export interface WindowHostModalProps {
  readonly cause: WindowNarrationCause;
  readonly variant: WindowNarrationVariant;
  readonly progress: HostProgressView | null;
  /**
   * The boot body - the shared boot headline with this machine's lane
   * progress and the Show details / bootstrap.log disclosure while a start is
   * in progress, or the failed attempt's diagnostics once it has settled - or
   * `null` when this state has no body of that kind to draw.
   *
   * Passed in rather than rendered here because the decision is the host's:
   * every healthy start gets the body, WHATEVER the target's kind (see
   * `buildBootBody`), while the settled diagnostics are drawn only when the
   * failure is this machine's. Offering to inspect this machine's failed
   * install while the fleet's only hosts are remote describes the wrong
   * computer, and that arm keeps the title and description as its whole
   * story.
   */
  readonly bootBody: ReactNode | null;
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
  /**
   * Whether `Open settings` is the ONLY action this state offers, in which
   * case the boot body already carries it inline on the footer row beside
   * `Show details` and the startup card draws no action row of its own.
   *
   * Decided above like every other action question - see the module doc. The
   * dialog ignores it: it keeps a conventional right-aligned footer under its
   * own title and description.
   */
  readonly settingsOnly: boolean;
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
            bootBody={props.bootBody}
          />
          <NarrationActions {...props} copy={copy} align="end" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * THE STARTUP PRESENTATION: the same narration, drawn as the released
 * versions drew a host boot - a centered card in the gate's frame, not a
 * dialog.
 *
 * It is drawn THROUGH `HostBootCard`, the same component as the two boot
 * surfaces before it, and that is the whole point of it: a launch hands off
 * from the runtime fallback to the gate's attach cover to this card, and the
 * user sees ONE card the whole way only if all three are literally the same
 * geometry. This one used to be `max-w-md` while the others were `sm`, and it
 * centred against the full viewport while they centred under the header - so
 * the card widened by 64px and jumped 20px the moment the narrator took over.
 * The layer now starts BELOW the header (`BELOW_APP_HEADER_TOP_CLASS`) so its
 * `p-6` box is the gate frame's box - and it is a FLEX row like that box, not
 * a grid, for the same reason and one more: `HostBootCard`'s
 * `viewportCapped` is a percentage `max-height`, and a percentage resolves
 * against a flex container's definite height where an auto grid track grows
 * with its content and would let the cap resolve against the very height it
 * is meant to bound. Same centring, and a card that can actually be capped by
 * the layer it sits in.
 *
 * Structural differences from the dialog, all deliberate:
 *
 *  - NO overlay and NO pointer trap. The layer is `pointer-events-none` with
 *    only the card re-enabling itself, so toasts (the update toast above all
 *    - a pending update is MOST actionable when the host is being set up)
 *    and the gate frame's own header stay clickable.
 *  - The cold-start face has NO title and NO description while the start is
 *    healthy. "Setting up Traycer" over "Setting up Traycer Host…" over
 *    "Setting up…" was one event announced three times by three layers; the
 *    boot body's own headline is the one line, exactly as the released card
 *    had it. And that body is ALWAYS there on a healthy start - a card whose
 *    body was withheld for a remote target rendered as nothing but the
 *    `Open settings` link, which is the "modal with only the Open settings
 *    button" report.
 *  - Recovery actions are withheld until they mean something: on a healthy
 *    start the body's footer carries ONLY the quiet `Open settings` beside
 *    `Show details`, with Retry and Report issue gated above exactly as the
 *    released card gated them.
 *
 * ⚠ `Open settings` IS NOT OMITTED, however quiet the start looks, and the
 * temptation to drop it for a cleaner card is a LOCKOUT. This surface renders
 * inside the gate's frame, whose `AppHeader variant="host-loading"` sits above
 * the router and therefore has `navDisabled` - there is no other route to
 * Settings on screen. A host that hangs without ever reporting a failure (so
 * Retry never arms) would leave a user with no way to reach the Shell page
 * that fixes it. One quiet text link is not the "something is wrong, pick
 * one" signal a row of equal-weight buttons is.
 */
export function WindowHostStartupCard(props: WindowHostModalProps): ReactNode {
  const copy = modalCopy(props.variant, props.cause);
  // The released card face: body only, one heading, for a start that is
  // progressing or slow. A SETTLED failure gets the titled face below even on
  // the cold-start cause - a crash report under no heading reads as debris.
  const bareColdStart = props.cause === "cold-start" && !props.showReportIssue;
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 z-50 flex items-center justify-center p-6",
        BELOW_APP_HEADER_TOP_CLASS,
      )}
      data-testid="window-host-startup-card-layer"
    >
      <HostBootCard
        testId="window-host-startup-card"
        dataset={{
          "data-variant": props.variant.kind,
          "data-cause": props.cause,
        }}
        viewportCapped
      >
        {bareColdStart ? null : (
          <div className="flex flex-col gap-2">
            <h2
              data-testid="window-host-startup-card-title"
              className="font-heading text-lg leading-none font-medium"
            >
              {props.cause === "cold-start"
                ? "Traycer Host didn't start"
                : copy.title}
            </h2>
            {props.cause === "cold-start" ? null : (
              <p
                className="text-ui-sm text-muted-foreground"
                data-testid="window-host-startup-card-description"
              >
                {copy.description}
              </p>
            )}
          </div>
        )}
        <WindowHostModalBody
          variant={props.variant}
          progress={props.progress}
          bootBody={props.bootBody}
        />
        {props.settingsOnly ? null : (
          <NarrationActions {...props} copy={copy} align="center" />
        )}
      </HostBootCard>
    </div>
  );
}

/**
 * The one action row, shared by both presentations so they cannot drift
 * apart about which recovery a state offers. Every "should this render"
 * decision stays above (see the module doc) - this only draws what it is
 * handed.
 */
function NarrationActions(
  props: WindowHostModalProps & {
    readonly copy: WindowHostModalCopy;
    /**
     * `center` for the startup card, whose whole column is centred; `end` for
     * the dialog, which keeps the conventional right-aligned footer under its
     * left-aligned title and description. The row must follow the surface it
     * sits in - a right-aligned row inside a centred card is the mismatch the
     * user reported as "this alignment is bad".
     */
    readonly align: "center" | "end";
  },
): ReactNode {
  const settingsActivation = usePressStartActivation(props.onOpenSettings);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        props.align === "center" ? "justify-center" : "justify-end",
      )}
    >
      {props.variant.kind === "plan-restricted" ? (
        <PlanRestrictedUpgradeAction />
      ) : null}
      {/* The app updater IS the remedy here, and it is unconditional: this
          variant only exists because the host stated, in structured terms,
          that this app is the outdated leg. There is deliberately no
          `Update host` beside it - see `ClientUpdateRequiredAction`. */}
      {props.variant.kind === "update-client" ? (
        <ClientUpdateRequiredAction requirement={props.variant.requirement} />
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
          it exists to fix is the lockout this whole surface prevents.

          It activates on PRESS (`usePressStartActivation`), unlike its
          neighbours in this row, and the asymmetry is deliberate: this card
          can be replaced by the next boot surface between a press and its
          release, which produces no click at all. Retry / Update host are
          MUTATIONS and keep click semantics, so a press the user drags away
          from does not fire them. */}
      <Button
        type="button"
        size="sm"
        variant={props.settingsEmphasis === "button" ? "outline" : "link"}
        {...settingsActivation}
        data-testid="window-host-modal-open-settings"
        data-emphasis={props.settingsEmphasis}
      >
        Open settings
      </Button>
      {props.showReportIssue ? (
        <ReportIssueAction
          context={createReportIssueContext({
            title: props.copy.reportTitle,
            message: props.copy.reportMessage,
            code: props.copy.reportCode,
            source: "Host connection",
          })}
          presentation="text"
          className={undefined}
        />
      ) : null}
    </div>
  );
}

function WindowHostModalBody(props: {
  readonly variant: WindowNarrationVariant;
  readonly progress: HostProgressView | null;
  readonly bootBody: ReactNode | null;
}): ReactNode {
  if (props.variant.kind === "update-host") {
    return <IncompatibleDetail variant={props.variant} />;
  }
  if (props.variant.kind === "update-client") {
    return <ClientCompatibilityDetail variant={props.variant} />;
  }
  if (props.bootBody !== null) return props.bootBody;
  if (props.progress === null) return null;
  return <LaneProgressLine progress={props.progress} />;
}

/**
 * The lane's own words, for a TITLED face that has no boot body but whose
 * controller is demonstrably doing something: the plan-restricted arm, or a
 * settled ∅ on a fleet this machine is not part of, while this machine's lane
 * still runs underneath.
 *
 * "Traycer can't reach any host" beside a silent screen reads as a dead end
 * even while an install is streaming underneath; this is the line that says
 * the difference. It is NEVER the healthy startup card's body: that face has
 * the full boot body (`buildBootBody`), and drawing this boxed line there
 * instead was the "weird-looking Setting up Traycer" report - a bordered
 * strip with a truncated heading and a percentage where every other phase of
 * the launch draws the headline, the bar and the details footer.
 *
 * Heading and percentage ONLY - the same two things the boot body's bar says.
 * The lane's byte count and its own message line (`transferLabel`, `detail`)
 * are Settings ▸ Host's: on a launch card a "100 MB of 239 MB" reads as a
 * download the app started because it was opened, and the detail is a log
 * line with a path in it. See `HostProgress` in `local-host-loading.tsx`.
 */
function LaneProgressLine(props: {
  readonly progress: HostProgressView;
}): ReactNode {
  const { progress } = props;
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border/60 bg-foreground/8 px-3 py-2"
      data-testid="window-host-modal-progress"
    >
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
      // align-ok: a labelled version list inside its own fill - the labels
      // line up only if the block keeps one left edge. `w-full` so the block
      // spans the card like the attempt panel does on the settled faces,
      // rather than shrink-wrapping in the centred column.
      className="flex w-full flex-col gap-1 rounded-md bg-foreground/8 px-3 py-2 text-left text-ui-xs text-muted-foreground"
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

/**
 * The host's own structured requirement, printed as facts rather than folded
 * into the sentence above it.
 *
 * The epoch numbers are HERE and not in the headline, deliberately: a user
 * acts on an application update, not on an internal protocol generation. They
 * belong in the block someone screenshots for support, where "needs generation
 * 2, this app declares 1" is exactly what triage needs.
 *
 * `observedClientAppVersion` is the HOST's normalized view of what this app
 * reported, not `getClientAppVersion()`. That is the point of printing it: if
 * the two disagree, the bug is in what this build sends, and reading the local
 * value here would hide precisely that.
 */
function ClientCompatibilityDetail(props: {
  readonly variant: Extract<
    WindowNarrationVariant,
    { readonly kind: "update-client" }
  >;
}): ReactNode {
  const { requirement } = props.variant;
  return (
    <div
      // align-ok: a labelled list whose labels only line up on one left edge,
      // same as `IncompatibleDetail` above.
      className="flex w-full flex-col gap-1 rounded-md bg-foreground/8 px-3 py-2 text-left text-ui-xs text-muted-foreground"
      data-testid="window-host-modal-client-compatibility-detail"
    >
      <span>
        This app: {requirement.observedClientAppVersion ?? "unknown version"}
      </span>
      <span>
        Compatibility generation: host needs{" "}
        {requirement.minimumCompatibilityEpoch}, this app declares{" "}
        {requirement.observedCompatibilityEpoch ?? "none"}
      </span>
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
  if (variant.kind === "update-client") {
    const { requirement } = variant;
    return {
      title: "Update Traycer to continue",
      // Two bodies, split on whether the host could identify what this app is
      // running. Naming the observed version is what makes the instruction
      // checkable ("am I on 1.1.10?"); when the host could not read it, saying
      // so is more honest than a sentence with a blank in it.
      description:
        requirement.observedClientAppVersion === null
          ? "This Traycer installation is too old to identify a compatible generation. Install the latest Traycer app."
          : `This host needs a newer Traycer generation. You are running ${requirement.observedClientAppVersion}; install the latest version.`,
      reportTitle: "Traycer app update required",
      reportMessage:
        "The host refused this app at its client-compatibility epoch gate.",
      reportCode: "CLIENT_INCOMPATIBLE",
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
