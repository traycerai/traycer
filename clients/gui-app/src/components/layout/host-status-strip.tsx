import { use, type ReactNode } from "react";
import { PlugZap, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { hostFailureReportIssueAction } from "@/components/layout/host-failure-report";
import {
  presentsLocalHostLifecycle,
  useHostReadinessController,
  useSurfaceReadiness,
  type DefaultHostReadinessPresentation,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  deriveHostStatusStripState,
  useActiveHostLabel,
  useHostSwitchTarget,
} from "@/components/layout/host-status-strip-state";
import { HostCompatibilityContext } from "@/lib/host/compatibility-state";
import { cn } from "@/lib/utils";

/**
 * The ONE strip that states what the app-wide host connection is doing:
 * switching to another host, degraded, or broken.
 *
 * It absorbs `HostConnectionDegradedBanner` (the traycer#860 held-verdict
 * strip) rather than sitting beside it - two owners of one row is how a
 * degraded connection and a switch end up stacked or fighting over the same
 * line. It also absorbs the recovery actions that used to require a
 * full-screen card: post-latch the gate no longer replaces the app for a
 * broken default host (`DefaultHostReadyGate`), so Retry and the pre-filled
 * report have to live somewhere inside a mounted app, and this is it.
 *
 * Why a strip is enough for the error states: tabs are bound to their host
 * for life, so a broken DEFAULT host does not invalidate a single open tab.
 * Default-host-scoped surfaces (composer, landing terminal) already project
 * their own in-surface fallbacks through `HostScopeReady` /
 * `SurfaceReadinessBoundary`; what they could not do is SAY why they went
 * quiet. That is this component's job.
 *
 * Reads the compat context directly rather than through
 * `useHostCompatibility` so a surface mounted outside the provider (test
 * harnesses, the gui-app dev preview) renders nothing instead of throwing.
 * The context decides whether this strip exists at all; every fact it states
 * comes from the readiness presentation, which is the same probe projected
 * once by the one controller.
 */
export function HostStatusStrip(): ReactNode {
  const compatibility = use(HostCompatibilityContext);
  const readiness = useSurfaceReadiness("default-host", null);
  const presentation = useHostReadinessController().defaultHostPresentation;
  const switchTarget = useHostSwitchTarget();
  const activeLabel = useActiveHostLabel();
  const state = deriveHostStatusStripState({
    switching: switchTarget !== null,
    readinessKind: readiness.kind,
    compatibility: presentation.compatibility,
  });
  if (compatibility === null) return null;
  if (state === "hidden") return null;
  if (state === "error") {
    return (
      <HostStatusStripFrame state="error">
        <HostStatusStripErrorContent
          readiness={readiness}
          presentation={presentation}
        />
      </HostStatusStripFrame>
    );
  }
  const label = switchTarget?.label ?? activeLabel;
  const waitingRetry = waitingRetryAction(readiness.kind, presentation);
  return (
    <HostStatusStripFrame state={state}>
      <PlugZap className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {state === "degraded"
          ? "Traycer Host is not responding. Your work is still open - reconnecting."
          : describeSwitchingMessage(switchTarget !== null, label)}
      </span>
      <AgentSpinningDots
        className="size-3"
        testId="host-status-strip-spinner"
        variant={undefined}
      />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-current"
        data-testid="host-status-strip-retry"
        disabled={waitingRetry.pending}
        onClick={waitingRetry.onClick}
      >
        Retry now
      </Button>
    </HostStatusStripFrame>
  );
}

/**
 * Which recovery "Retry now" issues while the strip is waiting.
 *
 * The amber states are not one situation. A local host that is still starting,
 * stalled, or dead needs its PROCESS brought back - `requestRespawn`, exactly
 * what the full-screen cards this strip replaced put behind their Retry
 * (`loadingFallback` and `unavailableFallback` both wire it). Re-running the
 * compatibility probe against a process that is not there answers the same
 * nothing, however many times it is clicked.
 *
 * Everything else amber - an explicit switch, `restoring-request-context`, and
 * the still-dialing compat probe - is a CONNECTION question, and respawning the
 * local host for one of those would be both useless and wrong. Those keep the
 * probe retry.
 *
 * The target check is not redundant with the kind check. `unavailable-host` is
 * ALSO what a selected remote host reports once it loses its dialable endpoint
 * with no failover target, and that is the case where a respawn silently acts
 * on the wrong machine.
 */
function waitingRetryAction(
  kind: SurfaceReadiness["kind"],
  presentation: DefaultHostReadinessPresentation,
): { readonly onClick: () => void; readonly pending: boolean } {
  const localLifecycleWait =
    kind === "loading-host" ||
    kind === "provisioning-host" ||
    kind === "unavailable-host";
  // The readiness kind alone is NOT enough to authorize a respawn.
  // `unavailable-host` is also what a selected REMOTE host reports once it
  // loses its dialable endpoint with no failover target, and respawning then
  // restarts the host on THIS computer while leaving the host the user is
  // actually pointed at untouched. `presentsLocalHostLifecycle` is the
  // codebase's own answer to "do these lifecycle actions belong to this
  // target", including the unresolved-boot case that bare `targetKind` misses.
  if (localLifecycleWait && presentsLocalHostLifecycle(presentation)) {
    return {
      onClick: presentation.requestRespawn,
      pending: presentation.respawnPending,
    };
  }
  // `retrying` is the compat probe's own in-flight flag, the same one the
  // error strip's Retry already consumes. Hardcoding `false` here left the
  // amber "Retry now" enabled while the retry it just issued was still
  // running, so a second click re-fired a probe that was already in flight.
  return {
    onClick: presentation.compatibility.retry,
    pending: presentation.compatibility.retrying,
  };
}

/**
 * `switching` and `degraded` keep the amber/`PlugZap` treatment the degraded
 * banner shipped with - both mean "still connected enough to keep working".
 * `error` is the one state where the app is pointed at a host it cannot use,
 * so it earns the destructive palette.
 */
function HostStatusStripFrame(props: {
  readonly state: "switching" | "degraded" | "error";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <output
      aria-label={STRIP_ARIA_LABEL[props.state]}
      data-testid="host-status-strip"
      data-state={props.state}
      className={cn(
        "flex w-full items-center gap-2 border-b px-3 py-1.5 text-ui-xs",
        props.state === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-100",
      )}
    >
      {props.children}
    </output>
  );
}

const STRIP_ARIA_LABEL: Readonly<Record<string, string>> = {
  switching: "Switching Traycer Host",
  degraded: "Traycer Host connection degraded",
  error: "Traycer Host is unavailable",
};

/**
 * The switch signal names the host the user picked; a readiness-driven wait
 * (a local host respawning, a request context being restored) has no such
 * gesture behind it, so it says what it is instead of claiming a switch
 * nobody asked for.
 */
function describeSwitchingMessage(
  fromSwitchGesture: boolean,
  label: string | null,
): string {
  const host = label ?? "Traycer Host";
  return fromSwitchGesture ? `Switching to ${host}…` : `Connecting to ${host}…`;
}

function HostStatusStripErrorContent(props: {
  readonly readiness: SurfaceReadiness;
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  const error = describeHostStatusStripError(
    props.readiness.kind,
    props.presentation,
  );
  return (
    <>
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {error.message}
        {error.detail === null ? null : (
          <span
            className="ml-1 opacity-80"
            data-testid="host-status-strip-detail"
          >
            {error.detail}
          </span>
        )}
      </span>
      {error.action === null ? null : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-current"
          disabled={error.action.pending}
          data-testid="host-status-strip-retry"
          onClick={error.action.onClick}
        >
          <span className="inline-flex items-center gap-1.5">
            <span>{error.action.label}</span>
            {error.action.pending ? (
              <AgentSpinningDots
                className="size-3"
                testId="host-status-strip-retry-spinner"
                variant={undefined}
              />
            ) : null}
          </span>
        </Button>
      )}
      {error.report === null
        ? null
        : hostFailureReportIssueAction({
            title: error.report.title,
            message: error.report.message,
            code: error.report.code,
            source: error.report.source,
            presentation: props.presentation,
            includeRetainedProgress: error.report.includeRetainedProgress,
          })}
    </>
  );
}

interface HostStatusStripAction {
  readonly label: string;
  readonly pending: boolean;
  readonly onClick: () => void;
}

interface HostStatusStripReport {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly source: string;
  readonly includeRetainedProgress: boolean;
}

interface HostStatusStripError {
  readonly message: string;
  readonly detail: string | null;
  readonly action: HostStatusStripAction | null;
  readonly report: HostStatusStripReport | null;
}

/**
 * The same failure families the full-screen fallbacks describe, in one line.
 * Copy, report code and `source` are kept IDENTICAL to those cards
 * (`fallbackContent`) - a user filing from the strip and a user filing from a
 * cold-start card are reporting the same thing, and triage keys off those
 * fields (traycer#858 / #860 / #862).
 *
 * Readiness kinds are consulted first because a LOCAL target projects its
 * lifecycle into them. A remote (or unresolved) target never does - readiness
 * stays `ready` while its probe fails - so the compat verdict is the fallback
 * source, which is precisely the direction that used to fail silently.
 */
function describeHostStatusStripError(
  kind: SurfaceReadiness["kind"],
  presentation: DefaultHostReadinessPresentation,
): HostStatusStripError {
  if (kind === "provisioning-error") {
    return {
      message:
        presentation.provisioningError?.message ??
        "Could not start Traycer Host.",
      detail: null,
      action: {
        label: "Retry",
        pending: presentation.provisioning,
        onClick: presentation.retryProvisioning,
      },
      report: {
        title: "Could not start Traycer Host",
        message: "Traycer Host could not start.",
        code: "HOST_PROVISIONING_FAILED",
        source: "Host startup",
        // The one report the retained stage explains: this state is reached
        // only while the converge error that produced it is still live.
        includeRetainedProgress: true,
      },
    };
  }
  if (kind === "removed-host") {
    return {
      message:
        "You removed Traycer's background components, so the host won't start.",
      detail: null,
      action: {
        label: "Reinstall",
        pending: false,
        onClick: presentation.reinstall,
      },
      report: null,
    };
  }
  if (kind === "incompatible-host" || isIncompatible(presentation)) {
    return {
      message: "Host update required",
      detail: presentation.compatibility.errorMessage,
      action: presentation.canManageHost
        ? {
            label: "Update host",
            pending: false,
            onClick: presentation.forceProvisioning,
          }
        : {
            label: "Retry",
            pending: false,
            onClick: presentation.compatibility.retry,
          },
      report: {
        title: "Host update required",
        message: "Traycer Host requires an update.",
        code: "HOST_INCOMPATIBLE",
        source: "Host compatibility",
        includeRetainedProgress: false,
      },
    };
  }
  // Everything else that reaches the error state is a settled compat failure:
  // `compatibility-error` for a local target, or a `failed` verdict under a
  // readiness that stayed `ready` (remote / unresolved).
  const unreachable = presentation.compatibility.unreachable;
  return {
    message: unreachable
      ? "Traycer Host is not responding."
      : "Could not verify host compatibility.",
    detail: presentation.compatibility.errorMessage,
    action: {
      label: "Retry",
      pending: presentation.compatibility.retrying,
      onClick: presentation.compatibility.retry,
    },
    report: {
      title: unreachable
        ? "Traycer Host is not responding"
        : "Could not verify Traycer Host compatibility",
      message: unreachable
        ? "The app could not reach Traycer Host."
        : "Traycer Host rejected the compatibility handshake.",
      code: unreachable ? "HOST_UNREACHABLE" : "HOST_COMPAT_PROBE_REJECTED",
      // Not a startup failure: this is a host that was already serving and
      // stopped answering (traycer#860).
      source: "Host connection",
      includeRetainedProgress: false,
    },
  };
}

function isIncompatible(
  presentation: DefaultHostReadinessPresentation,
): boolean {
  return presentation.compatibility.status === "incompatible";
}
