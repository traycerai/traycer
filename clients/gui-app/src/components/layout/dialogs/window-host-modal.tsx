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

/** What must not come back: this surface never narrates a switch, a degraded probe, or a single host's outage
 * while another works. */
export interface WindowHostModalProps {
  readonly cause: WindowNarrationCause;
  readonly variant: WindowNarrationVariant;
  readonly progress: HostProgressView | null;
  /** Passed in rather than rendered here because the decision is the host's. */
  readonly bootBody: ReactNode | null;
  readonly onRetry: (() => void) | null;
  readonly retryPending: boolean;
  /** `null` when this app cannot manage the host, or when the handshake says this app is the outdated leg. */
  readonly onUpdateHost: (() => void) | null;
  readonly onOpenSettings: () => void;
  /** `Report issue` is the affordance that turns a false impression of breakage into real support load, so it
   * renders only once there is a failure for a report to describe. */
  readonly showReportIssue: boolean;
  /** Never whether it renders: it is unconditional in every variant and must stay so - it is the escape hatch for
   * a host that cannot start, and a user who reaches this modal with no host has no other route to Settings. */
  readonly settingsEmphasis: "button" | "link";
  /** Whether `Open settings` is the only action this state offers, in which case the boot body already carries it
   * inline on the footer row beside `Show details` and the startup card draws no action row of its own. */
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
          // The app behind this modal has no host, so "let me close it" is an offer to click on surfaces that cannot
          // answer.
          onEscapeKeyDown={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          onInteractOutside={(event) => {
            event.preventDefault();
          }}
          // `top-safe-center-y` / `left-safe-center-x`, not the halfway marks: a fixed surface escapes `#root`'s
          // safe-area reservation.
          className="fixed top-safe-center-y left-safe-center-x z-[60] flex max-h-[85svh] w-[min(92vw,32rem,var(--safe-area-width))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl bg-background p-6 text-foreground ring-1 ring-foreground/10 shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
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

/** A host that hangs without ever reporting a failure (so Retry never arms) would leave a user with no way to
 * reach the Shell page that fixes it. */
export function WindowHostStartupCard(props: WindowHostModalProps): ReactNode {
  const copy = modalCopy(props.variant, props.cause);
  // The released card face: body only, one heading, for a start that is progressing or slow.
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

/** The one action row, shared by both presentations so they cannot drift apart about which recovery a state
 * offers. */
function NarrationActions(
  props: WindowHostModalProps & {
    readonly copy: WindowHostModalCopy;
    /** The row must follow the surface it sits in - a right-aligned row inside a centred card is the mismatch the
     * user reported as "this alignment is bad". */
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
      {/* The app updater IS the remedy here, and it is unconditional: this variant only exists because the host
         stated, in structured terms, that this app is the outdated leg. */}
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
      {/* Settings is reachable from here on purpose, and the route bypasses the readiness gate - the shell page edits
         host config without a running host, so this is the escape hatch for a host that cannot start. */}
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

/** "Traycer can't reach any host" beside a silent screen reads as a dead end even while an install is streaming
 * underneath; this is the line that says the difference. */
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

/** The versions are printed rather than folded into the sentence: "host 1.1.4, this app needs 1.2.0 or newer"
 * is a fact someone can act on or report, where a reason code glued onto a sentence is noise. */
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

/** The host's own structured requirement, printed as facts rather than folded into the sentence above it. */
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

/** The report codes are distinct on purpose: collapsing "this app can't reach any host". */
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
      // Two bodies, split on whether the host could identify what this app is running.
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
      // Direction-aware, from the same helper the compat card used, so the two cannot drift while both exist.
      title: hostUpdateSkew(variant.detail, getClientAppVersion()).title,
      // Two descriptions, because on the fallback arm the first one's advice is something the reader cannot act on
      // from here.
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
