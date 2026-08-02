import {
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  HostReadinessControllerContext,
  isHostDialable,
  projectDefaultHostReadiness,
  resolveSurfaceReadiness,
  useHostReadinessController,
  useSurfaceReadiness,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type HostReadinessScope,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  GATE_BYPASS_PATH_PREFIX,
  HostProvisioningController,
  type HostProvisioningLifecycle,
} from "@/components/local-host-gate";
import { LocalHostLoadingContent } from "@/components/local-host-loading";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { describeHostCompatibilityError, useHostBinding } from "@/lib/host";
import {
  useHostCompatibility,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";

/** A single signed-in owner for host reachability and lifecycle state. */
export function HostReadinessControllerProvider(props: {
  readonly onConfigureShell: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const authStatus = useAuthStore((state) => state.status);
  // The single readiness owner also owns the slow-host respawn mutation, so all
  // default-host slots share one request/pending lock (see the presentation's
  // requestRespawn/respawnPending).
  const respawn = useRunnerRequestHostRespawn();
  const client = binding?.hostClient ?? null;
  const readiness = useReactiveHostReadiness(client);
  const directoryEntries = useHostDirectoryEntries(
    binding === null ? null : binding.directory,
  );
  const activeEntry = directoryEntries.find(
    (entry) => entry.hostId === readiness.hostId,
  );
  const defaultHostDialable = isHostDialable(activeEntry);
  const selectedEntry =
    binding === null ? null : binding.hostClient.getActiveHost();
  const targetEntry = selectedEntry ?? activeEntry;
  const localTarget = targetEntry?.kind !== "remote";
  const compatibility = useHostCompatibility();
  const canProvision =
    authStatus === "signed-in" && runnerHost.hasLocalHost && localTarget;

  return (
    <HostProvisioningController
      enabled={canProvision}
      isReady={defaultHostDialable}
    >
      {(lifecycle) => (
        <HostReadinessControllerContents
          authStatus={authStatus}
          activeHostId={readiness.hostId}
          requestContextUserId={readiness.requestContextUserId}
          directoryEntries={directoryEntries}
          hasLocalHost={runnerHost.hasLocalHost}
          hasMobileNoHost={
            binding !== null && binding.directory.getCardinality() === "zero"
          }
          lifecycle={lifecycle}
          compatibility={compatibility}
          localTarget={localTarget}
          onConfigureShell={props.onConfigureShell}
          onRequestRespawn={respawn.mutate}
          respawnPending={respawn.isPending}
        >
          {props.children}
        </HostReadinessControllerContents>
      )}
    </HostProvisioningController>
  );
}

function HostReadinessControllerContents(props: {
  readonly authStatus: AuthStatus;
  readonly activeHostId: string | null;
  readonly requestContextUserId: string | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly localTarget: boolean;
  readonly onConfigureShell: () => void;
  readonly onRequestRespawn: () => void;
  readonly respawnPending: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const defaultHostPresentation = useMemo(
    () =>
      presentationFromLifecycle({
        lifecycle: props.lifecycle,
        compatibility: props.compatibility,
        localTarget: props.localTarget,
        configureShell: props.onConfigureShell,
        requestRespawn: props.onRequestRespawn,
        respawnPending: props.respawnPending,
      }),
    [
      props.compatibility,
      props.lifecycle,
      props.localTarget,
      props.onConfigureShell,
      props.onRequestRespawn,
      props.respawnPending,
    ],
  );
  const controller = useMemo<HostReadinessController>(() => {
    return {
      readinessFor: (scope, tabHostId) => {
        const readiness = resolveSurfaceReadiness({
          scope,
          tabHostId,
          authStatus: props.authStatus,
          activeHostId: props.activeHostId,
          requestContextUserId: props.requestContextUserId,
          directoryEntries: props.directoryEntries,
          hasLocalHost: props.hasLocalHost,
          hasMobileNoHost: props.hasMobileNoHost,
        });
        return scope === "default-host"
          ? projectDefaultHostReadiness({
              readiness,
              presentation: defaultHostPresentation,
            })
          : readiness;
      },
      defaultHostPresentation,
    };
    // Depend on the individual fields `readinessFor` closes over, like the
    // presentation memo above. `props` is a fresh object every render, so
    // listing it defeated this memo entirely: the context value changed
    // identity on each render and re-ran every `useSurfaceReadiness` /
    // `useHostReadinessController` consumer across the surface tree.
  }, [
    defaultHostPresentation,
    props.activeHostId,
    props.authStatus,
    props.directoryEntries,
    props.hasLocalHost,
    props.hasMobileNoHost,
    props.requestContextUserId,
  ]);

  return (
    <HostReadinessControllerContext.Provider value={controller}>
      {props.children}
    </HostReadinessControllerContext.Provider>
  );
}

function presentationFromLifecycle(args: {
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly localTarget: boolean;
  readonly configureShell: () => void;
  readonly requestRespawn: () => void;
  readonly respawnPending: boolean;
}): DefaultHostReadinessPresentation {
  return {
    localTarget: args.localTarget,
    localHostState: args.lifecycle.localHostState,
    stage: args.lifecycle.slowStartStage,
    progress: args.lifecycle.provisioning.progress,
    provisioningError: args.lifecycle.provisioning.error,
    provisioning: args.lifecycle.provisioning.isProvisioning,
    removed: args.lifecycle.provisioning.removed,
    hostBusy: args.lifecycle.provisioning.hostBusy,
    canManageHost:
      args.localTarget && args.lifecycle.provisioning.canManageHost,
    retryProvisioning: args.lifecycle.provisioning.retry,
    forceProvisioning: args.lifecycle.provisioning.force,
    reinstall: args.lifecycle.provisioning.reinstall,
    configureShell: args.configureShell,
    requestRespawn: args.requestRespawn,
    respawnPending: args.respawnPending,
    compatibility: compatibilityPresentation(args.compatibility),
  };
}

function compatibilityPresentation(
  compatibility: HostCompatibility,
): DefaultHostReadinessPresentation["compatibility"] {
  if (compatibility.status === "failed") {
    return {
      status: "failed",
      errorMessage: compatibility.error.message,
      retrying: compatibility.retrying,
      retry: compatibility.retry,
      degraded: false,
      unreachable: compatibility.unreachable,
    };
  }
  if (compatibility.status === "incompatible") {
    return {
      status: "incompatible",
      errorMessage: describeHostCompatibilityError(compatibility.error),
      retrying: false,
      retry: compatibility.retry,
      degraded: false,
      unreachable: false,
    };
  }
  if (compatibility.status === "checking") {
    return {
      status: "checking",
      errorMessage: null,
      retrying: false,
      retry: compatibility.retry,
      degraded: false,
      unreachable: false,
    };
  }
  return {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: compatibility.retry,
    degraded: compatibility.degraded,
    unreachable: false,
  };
}

export function SurfaceReadinessBoundary(props: {
  readonly scope: HostReadinessScope;
  readonly tabHostId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness(props.scope, props.tabHostId);
  if (readiness.kind === "ready") return props.children;
  return (
    <SurfaceReadinessFallback
      readiness={readiness}
      scope={props.scope}
      variant="slot"
    />
  );
}

export function HostScopeReady(props: {
  readonly scope: Exclude<HostReadinessScope, "none">;
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness(props.scope, null);
  return readiness.kind === "ready" ? props.children : null;
}

/**
 * The ONE mapping from a readiness kind to its surface. Both the in-surface
 * slot and the full-screen splash render through here; they differ only in
 * `variant`. The gate used to call `fallbackContent` directly, which skipped
 * the slow-local-host branch below - so a full-screen block on a host that
 * failed to start showed "This tab's host is unavailable." with no Retry at
 * all. A second renderer means a second chance to miss a branch, and the one
 * it missed was the recovery affordance.
 */
function SurfaceReadinessFallback(props: {
  readonly readiness: Exclude<SurfaceReadiness, { readonly kind: "ready" }>;
  readonly scope: HostReadinessScope;
  readonly variant: "slot" | "splash";
}): ReactNode {
  const controller = useHostReadinessController();
  const presentation = controller.defaultHostPresentation;
  const testId =
    props.variant === "splash"
      ? `host-ready-gate-${props.readiness.kind}`
      : `surface-readiness-${props.readiness.kind}`;
  if (
    props.readiness.kind === "unavailable-host" &&
    props.scope === "default-host" &&
    presentation.localTarget &&
    presentation.localHostState === "unavailable" &&
    presentation.stage === "slow"
  ) {
    return (
      <SlowHostFallback
        presentation={presentation}
        variant={props.variant}
        testId={testId}
      />
    );
  }
  return (
    <FallbackFrame
      variant={props.variant}
      fallback={fallbackContent(props.readiness, presentation)}
      testId={testId}
      messageTestId={
        props.readiness.kind === "mobile-no-host" ? "mobile-no-host" : null
      }
    />
  );
}

function SlowHostFallback(props: {
  readonly presentation: DefaultHostReadinessPresentation;
  readonly variant: "slot" | "splash";
  readonly testId: string;
}): ReactNode {
  // Respawn is owned once by the readiness controller, so two default-host slots
  // share one pending lock and a click issues exactly one request.
  return (
    <FallbackFrame
      variant={props.variant}
      fallback={{
        message: null,
        detail: null,
        body: (
          <LocalHostLoadingContent
            stage="slow"
            progress={props.presentation.progress}
            onConfigureShell={props.presentation.configureShell}
            onRetry={props.presentation.requestRespawn}
            retryPending={props.presentation.respawnPending}
          />
        ),
        // The pre-consolidation `LocalHostUnavailable` card carried this; a
        // startup failure is exactly where a user needs to report.
        footer: hostFailureReportIssueAction({
          title: "Traycer Host is unavailable",
          message: "Traycer Host did not become available.",
          code: "HOST_UNAVAILABLE",
          source: "Host startup",
          presentation: props.presentation,
        }),
        actions: [],
      }}
      testId={props.testId}
      messageTestId={null}
    />
  );
}

/**
 * Full-screen default-host gate: while the default host is not ready, NOTHING
 * host-dependent is reachable - not the tab strip, not another tab, not a
 * keyboard route change. Split view made every surface project its own
 * in-place fallback, which left the shell live and let a user drive
 * host-dependent affordances during setup.
 *
 * Two properties are deliberate and must not be "simplified" away:
 *
 *  - It renders through `SurfaceReadinessFallback`, the same mapping the
 *    in-surface slot uses, so every recovery action (retry / force update /
 *    reinstall / report) survives the block. Collapsing this to a generic
 *    spinner - or re-deriving the surface here - would strand a user whose
 *    host cannot start, the exact lockout traycer#738 exists to prevent.
 *  - `/settings` still bypasses it. The splash's own "Configure shell" button
 *    navigates there, so gating settings on a ready host would make the
 *    escape hatch unreachable from the screen that offers it.
 *
 * Readiness and presentation both come from the one controller above; this
 * adds no second subscription.
 */
export function DefaultHostReadyGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness("default-host", null);
  const authStatus = useAuthStore((state) => state.status);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // Only a signed-in user can HAVE a ready default host, so blocking anyone
  // else would hide the sign-in surface behind a host that cannot exist yet.
  // `resolveSurfaceReadiness` only special-cases auth for the request-context
  // arm; the host arms answer `loading-host`/`mobile-no-host` regardless of
  // who is signed in, which is correct for a surface and wrong for a gate.
  if (authStatus !== "signed-in") return props.children;
  if (pathname.startsWith(GATE_BYPASS_PATH_PREFIX)) return props.children;
  if (readiness.kind === "ready") return props.children;
  return (
    <div
      className="flex min-h-svh w-full flex-col bg-background text-foreground"
      data-testid="host-ready-gate"
      data-readiness={readiness.kind}
    >
      <AppHeader variant="host-loading" />
      <SurfaceReadinessFallback
        readiness={readiness}
        scope="default-host"
        variant="splash"
      />
    </div>
  );
}

function FallbackFrame(props: {
  readonly fallback: ReadinessFallback;
  readonly testId: string;
  readonly messageTestId: string | null;
  /**
   * `splash` reproduces the full-screen host-boot card exactly as the
   * standalone `LocalHostLoading` drew it (max-w-md, shadow-sm, gap-4/py-6)
   * before the gate took over rendering it - that view predates the split work
   * and must not drift. `slot` is the bounded in-surface fallback, which
   * deliberately draws no card because it already sits inside a tab's frame.
   */
  readonly variant: "slot" | "splash";
}): ReactNode {
  const hasActionsRow =
    props.fallback.actions.length > 0 || props.fallback.footer !== null;
  const content = (
    <>
      {props.fallback.message === null ? null : (
        <p data-testid={props.messageTestId} className="text-muted-foreground">
          {props.fallback.message}
        </p>
      )}
      {props.fallback.detail === null ? null : (
        <p className="text-ui-xs text-muted-foreground">
          {props.fallback.detail}
        </p>
      )}
      {props.fallback.body}
      {hasActionsRow ? (
        <div className="flex flex-wrap justify-center gap-2">
          {props.fallback.actions.map((action) => (
            <Button
              key={action.testId}
              type="button"
              size="sm"
              variant={action.variant}
              disabled={action.disabled}
              onClick={action.onClick}
              data-testid={action.testId}
            >
              <span className="inline-flex items-center gap-1.5">
                <span>{action.label}</span>
                {action.pending ? (
                  <AgentSpinningDots
                    className={undefined}
                    testId={`${action.testId}-spinner`}
                    variant={undefined}
                  />
                ) : null}
              </span>
            </Button>
          ))}
          {props.fallback.footer}
        </div>
      ) : null}
    </>
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background p-6 text-foreground"
      data-testid={props.testId}
    >
      {props.variant === "splash" ? (
        <Card className="w-full max-w-md shadow-sm">
          <CardContent className="flex flex-col items-center gap-4 py-6 text-center text-ui-sm">
            {content}
          </CardContent>
        </Card>
      ) : (
        <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center text-ui-sm">
          {content}
        </div>
      )}
    </div>
  );
}

interface ReadinessFallbackAction {
  readonly label: string;
  readonly testId: string;
  readonly variant: "default" | "destructive" | "outline";
  readonly disabled: boolean;
  /**
   * Shows the inline spinner beside an UNCHANGED label, the way every gate
   * card did before consolidation and the way this app states pending work
   * everywhere else. Dropping it left a Retry that only greyed out, which
   * reads as "broken" rather than "working".
   */
  readonly pending: boolean;
  readonly onClick: () => void;
}

interface ReadinessFallback {
  readonly message: string | null;
  readonly detail: string | null;
  /** Rich slot content rendered between the message/detail text and the actions row. */
  readonly body: ReactNode | null;
  /** Rich content rendered alongside the action buttons, in the same row. */
  readonly footer: ReactNode | null;
  readonly actions: ReadonlyArray<ReadinessFallbackAction>;
}

function fallbackContent(
  readiness: Exclude<SurfaceReadiness, { readonly kind: "ready" }>,
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  switch (readiness.kind) {
    case "restoring-request-context":
      return {
        message: "Restoring authenticated session…",
        detail: null,
        body: null,
        footer: null,
        actions: [],
      };
    case "mobile-no-host":
      return {
        message:
          "No host connected. Connect a host from this device to get started.",
        detail: null,
        body: null,
        footer: null,
        actions: [],
      };
    case "unavailable-host":
      return unavailableFallback();
    case "loading-host":
    case "provisioning-host":
    case "compatibility-checking":
      return loadingFallback(readiness.kind, presentation);
    case "provisioning-error":
      return provisioningErrorFallback(presentation);
    case "removed-host":
      return {
        message: "Traycer was removed",
        // The original card named the actual next step. "Reinstall to start
        // the host again" answered a question the user was not asking: they
        // removed it on purpose and need to know how to finish.
        detail:
          "You removed Traycer's background components from this device, so the host won't start. Your agents and history are preserved. To finish, quit Traycer and drag it from Applications to the Trash.",
        body: null,
        footer: null,
        actions: [
          {
            label: "Quit Traycer",
            testId: "local-host-removed-quit",
            variant: "destructive",
            disabled: false,
            pending: false,
            onClick: () => {
              requestAppQuit();
            },
          },
          {
            label: "Reinstall",
            testId: "local-host-removed-reinstall",
            variant: "outline",
            disabled: false,
            pending: false,
            onClick: presentation.reinstall,
          },
        ],
      };
    case "compatibility-error":
      return compatibilityErrorFallback(presentation);
    case "incompatible-host":
      return incompatibleFallback(presentation);
  }
}

/**
 * Standard "Report issue" affordance shown alongside the recovery actions on
 * the host-failure fallbacks (provisioning-error, compatibility-error,
 * incompatible-host, slow/unavailable host).
 *
 * Every one of those used to file the SAME "Could not start Traycer Host"
 * report. On 2026-07-31 that single template produced three field reports with
 * identical titles and three completely unrelated causes - an offline host that
 * could not verify the session (traycer#858), a first install whose 60s
 * readiness budget expired mid-provisioning (traycer#862), and a host that had
 * been running and serving agent turns for hours (traycer#860). Each one cost a
 * full desktop+host log pull just to learn WHICH failure it was.
 *
 * So the pre-filled report now names its own failure family (`title`/`code`)
 * and carries a one-line health snapshot. The snapshot is categorical state
 * only - never paths, error text or anything the user has to redact.
 *
 * `source` is part of that discrimination, not decoration: it is the phase the
 * failure belongs to. Only two of these four fallbacks are startup failures.
 * A compatibility probe that stops answering is a host that already ran and
 * later went quiet - the traycer#860 shape - and filing that under "Host
 * startup" sends triage down the provisioning path, which is the exact wrong
 * place to look.
 */
function hostFailureReportIssueAction(args: {
  readonly title: string;
  readonly message: string;
  readonly code: string;
  readonly source: string;
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  return (
    <ReportIssueAction
      context={createReportIssueContext({
        title: args.title,
        message: `${args.message} ${describeHostHealth(args.presentation)}`,
        code: args.code,
        source: args.source,
      })}
      presentation="text"
      className={undefined}
    />
  );
}

/**
 * One line of triage state for the pre-filled report: what the desktop shell
 * believed about the host at the moment the user filed. Everything here is a
 * fixed vocabulary the renderer already holds - no new plumbing, and nothing
 * that can carry a filesystem path or a user's own data.
 */
function describeHostHealth(
  presentation: DefaultHostReadinessPresentation,
): string {
  const parts: string[] = [
    `host ${presentation.localTarget ? presentation.localHostState : "remote"}`,
    `compat ${describeCompatHealth(presentation)}`,
  ];
  if (presentation.provisioning) parts.push("provisioning");
  if (presentation.removed) parts.push("removed");
  if (presentation.hostBusy) parts.push("busy");
  if (presentation.stage === "slow") parts.push("slow start");
  const progress = presentation.progress;
  if (progress !== null) {
    const percent =
      progress.percent === null ? "" : ` ${Math.round(progress.percent)}%`;
    parts.push(`last progress ${progress.stage ?? "unknown"}${percent}`);
  }
  return `Host health: ${parts.join(", ")}.`;
}

function describeCompatHealth(
  presentation: DefaultHostReadinessPresentation,
): string {
  const compatibility = presentation.compatibility;
  if (compatibility.status === "failed") {
    return compatibility.unreachable ? "unreachable" : "rejected";
  }
  if (compatibility.status === "compatible" && compatibility.degraded) {
    return "compatible (degraded)";
  }
  return compatibility.status;
}

function loadingFallback(
  kind: "loading-host" | "provisioning-host" | "compatibility-checking",
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  // Every local-bootstrap wait - including the compatibility probe - shows the
  // SAME loading body. The old gate passed one `checking={props.loading}` node
  // for exactly this reason; giving the probe its own text-only screen made
  // startup drop from a spinner card to a bare line plus a button, which reads
  // as an error state mid-launch. "Configure shell…" is not lost: the loading
  // body carries it inside the details disclosure.
  if (!presentation.localTarget) {
    // A remote host still resolving: the rich progress/log card below is
    // local-bootstrap specific and would be misleading here.
    return {
      message:
        kind === "compatibility-checking"
          ? "Checking Traycer Host compatibility…"
          : (presentation.progress?.message ?? "Starting local Traycer Host…"),
      detail: null,
      body: null,
      footer: null,
      actions: [],
    };
  }
  return {
    message: null,
    detail: null,
    body: (
      <LocalHostLoadingContent
        stage="loading"
        progress={presentation.progress}
        onConfigureShell={presentation.configureShell}
        onRetry={presentation.requestRespawn}
        retryPending={presentation.respawnPending}
      />
    ),
    footer: null,
    actions: [],
  };
}

function provisioningErrorFallback(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  return {
    message:
      presentation.provisioningError?.message ??
      "Could not start Traycer Host.",
    detail: null,
    body: null,
    footer: hostFailureReportIssueAction({
      title: "Could not start Traycer Host",
      message: "Traycer Host could not start.",
      code: "HOST_PROVISIONING_FAILED",
      source: "Host startup",
      presentation,
    }),
    actions: [
      {
        label: "Retry",
        testId: "local-host-provisioning-retry",
        variant: "outline",
        disabled: presentation.provisioning,
        pending: presentation.provisioning,
        onClick: presentation.retryProvisioning,
      },
    ],
  };
}

/**
 * The compat probe failed. WHY it failed decides what this card may claim.
 *
 * A probe that never reached the host says nothing about protocol
 * compatibility - the host may be mid-restart, stalled under load, or up but
 * unable to verify the session because it cannot reach the sign-in service.
 * Calling all of that "could not verify host compatibility" is what put
 * `fetch failed` behind a version-mismatch sentence on an offline machine
 * (traycer#858) and what framed a busy, working host as a compat problem
 * (traycer#860). Only a host that ANSWERED and rejected the handshake gets the
 * compatibility wording.
 */
function compatibilityErrorFallback(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  const unreachable = presentation.compatibility.unreachable;
  return {
    message: unreachable
      ? "Traycer Host is not responding."
      : "Could not verify host compatibility.",
    // The reason rides in its own line rather than concatenated onto the
    // sentence: it is a raw transport/host string, and gluing it on produced
    // "Could not verify host compatibility. fetch failed."
    detail: presentation.compatibility.errorMessage,
    body: null,
    footer: hostFailureReportIssueAction({
      title: unreachable
        ? "Traycer Host is not responding"
        : "Could not verify Traycer Host compatibility",
      message: unreachable
        ? "The app could not reach Traycer Host."
        : "Traycer Host rejected the compatibility handshake.",
      code: unreachable ? "HOST_UNREACHABLE" : "HOST_COMPAT_PROBE_REJECTED",
      // Not a startup failure: this fallback is reached when a host that was
      // already serving stops answering the probe (traycer#860).
      source: "Host connection",
      presentation,
    }),
    actions: [
      {
        label: "Retry",
        testId: "local-host-compatibility-retry",
        variant: "outline",
        disabled: presentation.compatibility.retrying,
        pending: presentation.compatibility.retrying,
        onClick: presentation.compatibility.retry,
      },
    ],
  };
}

function incompatibleFallback(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  const footer = hostFailureReportIssueAction({
    title: "Host update required",
    message: "Traycer Host requires an update.",
    code: "HOST_INCOMPATIBLE",
    // Neither startup nor connection: this host came up and answered the
    // handshake, and the two sides simply disagree on the version.
    source: "Host compatibility",
    presentation,
  });
  const shared = {
    message: "Host update required",
    // The explanation, the labelled reason box and the restart error were all
    // flattened into one joined string. "Host update required" alone does not
    // say what to do, and an unlabelled concatenated reason reads as noise.
    detail: presentation.hostBusy
      ? "The running host has work in progress and is not compatible with this app update. Refresh to check again, or force update the host. Running work may be interrupted."
      : "This Traycer app update is not compatible with the running host. Update the local host before continuing.",
    body: <IncompatibleDetail presentation={presentation} />,
    footer,
  };
  if (!presentation.canManageHost) {
    return { ...shared, actions: [] };
  }
  if (presentation.hostBusy) {
    return {
      ...shared,
      actions: [
        {
          label: "Refresh",
          testId: "local-host-incompatible-busy-refresh",
          variant: "outline",
          disabled: false,
          pending: false,
          onClick: presentation.retryProvisioning,
        },
        {
          label: "Force update host",
          testId: "local-host-incompatible-busy-force-update",
          variant: "destructive",
          disabled: false,
          pending: false,
          onClick: presentation.forceProvisioning,
        },
      ],
    };
  }
  return {
    ...shared,
    actions: [
      {
        label: "Update host",
        testId: "local-host-incompatible-update",
        variant: "default",
        disabled: false,
        pending: false,
        onClick: presentation.forceProvisioning,
      },
    ],
  };
}

/**
 * The labelled compatibility reason, plus any restart error kept visually
 * distinct (destructive) rather than concatenated into the same sentence -
 * they answer different questions: why the host is rejected, and why the last
 * attempt to fix it failed.
 */
function IncompatibleDetail(props: {
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  const reason = props.presentation.compatibility.errorMessage;
  const restartError = props.presentation.provisioningError?.message ?? null;
  if (reason === null && restartError === null) return null;
  return (
    <>
      {reason === null ? null : (
        <p
          className="max-w-full break-words rounded-md bg-muted/50 px-3 py-2 text-left text-ui-xs text-muted-foreground"
          data-testid="local-host-incompatible-reason"
        >
          Reason: {reason}
        </p>
      )}
      {restartError === null ? null : (
        <p
          className="max-w-full break-words text-ui-xs text-destructive"
          data-testid="local-host-incompatible-restart-error"
        >
          {restartError}
        </p>
      )}
    </>
  );
}

/**
 * A tab bound to a host that is not dialable. The default-host arm never lands
 * here in its recoverable states - `SurfaceReadinessFallback` routes a slow
 * local host to the Retry card first - so this copy can stay tab-specific.
 */
function unavailableFallback(): ReadinessFallback {
  return {
    message: "This tab's host is unavailable.",
    detail: null,
    body: null,
    footer: null,
    actions: [],
  };
}

function useHostDirectoryEntries(
  directory: {
    readonly onChange: (
      listener: (
        entries: readonly HostDirectoryEntry[],
        localEntry: HostDirectoryEntry | null,
      ) => void,
    ) => { readonly dispose: () => void };
    readonly list: () => Promise<readonly HostDirectoryEntry[]>;
  } | null,
): ReadonlyArray<HostDirectoryEntry> {
  const entriesRef = useRef<ReadonlyArray<HostDirectoryEntry>>([]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (directory === null) return () => undefined;
      let subscribed = true;
      const subscription = directory.onChange((entries) => {
        entriesRef.current = entries;
        onStoreChange();
      });
      void directory.list().then((entries) => {
        if (!subscribed) return;
        entriesRef.current = entries;
        onStoreChange();
      });
      return () => {
        subscribed = false;
        subscription.dispose();
      };
    },
    [directory],
  );
  const getSnapshot = useCallback(() => entriesRef.current, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
