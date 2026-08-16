import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AppHeader } from "@/components/layout/header/app-header";
import { hostFailureReportIssueAction } from "@/components/layout/host-failure-report";
import {
  HostReadinessControllerContext,
  isHostDialable,
  postLatchSurfaceFor,
  presentsLocalHostLifecycle,
  targetPresentsLocalHostLifecycle,
  projectDefaultHostReadiness,
  resolveSurfaceReadiness,
  useHostReadinessController,
  useSurfaceReadiness,
  type DefaultHostReadinessPresentation,
  type HostReadinessController,
  type HostReadinessScope,
  type HostTargetKind,
  type SurfaceReadiness,
} from "@/components/layout/host-readiness-controller-context";
import {
  GATE_BYPASS_PATH_PREFIX,
  HostProvisioningController,
  type HostProvisioningLifecycle,
} from "@/components/local-host-gate";
import { LocalHostLoadingContent } from "@/components/local-host-loading";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { describeHostCompatibilityError, useHostBinding } from "@/lib/host";
import type { HostSelectionIntent } from "@/lib/host/host-directory-service";
import {
  useHostCompatibility,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { useRunnerRequestHostRespawn } from "@/hooks/runner/use-runner-request-host-respawn-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { appLogger, describeLogError } from "@/lib/logger";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";

/** A single signed-in owner for host reachability and lifecycle state. */
export function HostReadinessControllerProvider(props: {
  readonly onConfigureShell: () => void;
  readonly onOpenSettings: () => void;
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
  // Subscribed, not read at render time: every dialability answer below is
  // ready-session-aware, and a readiness flip changes no directory value.
  // The lookup's identity changes exactly when some listed host's readiness
  // does, which is what re-runs the memoized context value and re-renders
  // every readiness consumer.
  const hasReadySessionFor = useRemoteSessionsPollReadiness(
    useMemo(
      () => directoryEntries.map((entry) => entry.hostId),
      [directoryEntries],
    ),
  );
  const defaultHostDialable = isHostDialable(
    activeEntry,
    activeEntry !== undefined && hasReadySessionFor(activeEntry.hostId),
  );
  const selectedEntry =
    binding === null ? null : binding.hostClient.getActiveHost();
  const targetEntry = selectedEntry ?? activeEntry;
  const targetKind = resolveHostTargetKind(targetEntry);
  const compatibility = useHostCompatibility();
  // Read every render off the directory's LIVE state, never memoized and
  // never from storage: while the target is UNRESOLVED this is the only thing
  // that separates a cold local start from a remote pick whose directory row
  // has not arrived, and the answer changes the instant the user picks a host
  // (the selection gesture rebinds, which re-renders this controller).
  const selectionIntent =
    binding === null ? null : binding.directory.readSelectionIntent();
  const localBootIntent = resolveLocalBootIntent({
    hasLocalHost: runnerHost.hasLocalHost,
    targetEntry,
    selectionIntent,
  });
  // Keyed on INTENT, not on "not remote". Keying it on the latter armed the
  // real local lifecycle for an unresolved remote selection:
  // `HostProvisioningController` forwards enablement whenever the local
  // snapshot is unavailable, which fires `convergeReady`, enables the
  // removal-state read, and burns the one-shot attempt latch on an episode
  // belonging to a machine the user is not pointed at. `hasLocalHost` is
  // folded into the intent - a shell with no local host is never booting one.
  const canProvision = authStatus === "signed-in" && localBootIntent;
  const directory = binding === null ? null : binding.directory;
  // Stable identities: the presentation is memoized on its inputs, and a
  // fresh closure each render would re-run every readiness consumer in the
  // surface tree.
  const refreshDirectory = useCallback(() => {
    // A FAILED registry read is not an error here - `fetchRemoteOutcome`
    // collapses a throwing fetcher into the `failed` outcome that retains the
    // last-known entries, deliberately, so this button has nothing to report
    // in the case users actually hit. What can still reject is a subscriber
    // throwing out of the change emit, and letting that surface as an
    // unhandled rejection loses the stack. Log it and keep the click silent.
    directory?.refresh().catch((error: unknown) => {
      appLogger.warn("[host-readiness] directory refresh rejected", {
        error: describeLogError(error),
      });
    });
  }, [directory]);
  const openHostPicker = useCallback(() => {
    runnerHost.hostPicker.requestOpen();
  }, [runnerHost]);
  // The live directory-wide fact behind the host-unavailable card's report
  // family. Computed here, from the same entries readiness is resolved from,
  // so the card states what the directory actually says rather than inferring
  // it from the readiness kind that brought it here.
  const anyHostDialable = directoryEntries.some((entry) =>
    isHostDialable(entry, hasReadySessionFor(entry.hostId)),
  );

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
          hasReadySessionFor={hasReadySessionFor}
          hasLocalHost={runnerHost.hasLocalHost}
          hasMobileNoHost={
            binding !== null && binding.directory.getCardinality() === "zero"
          }
          lifecycle={lifecycle}
          compatibility={compatibility}
          targetKind={targetKind}
          localBootIntent={localBootIntent}
          onConfigureShell={props.onConfigureShell}
          onRefreshDirectory={refreshDirectory}
          onOpenHostPicker={openHostPicker}
          onOpenSettings={props.onOpenSettings}
          anyHostDialable={anyHostDialable}
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
  readonly hasReadySessionFor: (hostId: string) => boolean;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly targetKind: HostTargetKind;
  readonly localBootIntent: boolean;
  readonly onConfigureShell: () => void;
  readonly onRefreshDirectory: () => void;
  readonly onOpenHostPicker: () => void;
  readonly onOpenSettings: () => void;
  readonly anyHostDialable: boolean;
  readonly onRequestRespawn: () => void;
  readonly respawnPending: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const defaultHostPresentation = useMemo(
    () =>
      presentationFromLifecycle({
        lifecycle: props.lifecycle,
        compatibility: props.compatibility,
        targetKind: props.targetKind,
        localBootIntent: props.localBootIntent,
        configureShell: props.onConfigureShell,
        refreshDirectory: props.onRefreshDirectory,
        openHostPicker: props.onOpenHostPicker,
        openSettings: props.onOpenSettings,
        anyHostDialable: props.anyHostDialable,
        requestRespawn: props.onRequestRespawn,
        respawnPending: props.respawnPending,
      }),
    [
      props.compatibility,
      props.lifecycle,
      props.localBootIntent,
      props.targetKind,
      props.onConfigureShell,
      props.onRefreshDirectory,
      props.onOpenHostPicker,
      props.onOpenSettings,
      props.anyHostDialable,
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
          hasReadySessionFor: props.hasReadySessionFor,
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
    props.hasReadySessionFor,
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

/**
 * Classifies the entry the default-host surface is pointed at. `undefined` -
 * no selection bound and no directory row for the active id - is `unknown`,
 * never local: see `HostTargetKind`. `mock` shells are local machines for
 * every purpose here, matching the pre-tri-state `kind !== "remote"` reading
 * for every entry that actually resolves.
 */
function resolveHostTargetKind(
  entry: HostDirectoryEntry | undefined,
): HostTargetKind {
  if (entry === undefined) return "unknown";
  return entry.kind === "remote" ? "remote" : "local";
}

/**
 * Whether the app is booting THIS machine's own host - see
 * `DefaultHostReadinessPresentation.localBootIntent`.
 *
 * A resolved entry answers for itself. An UNRESOLVED target is decided by the
 * directory's IN-MEMORY selection intent - the live record of what the user
 * asked for, which exists before anything binds:
 *  - nothing selected -> a genuine cold local start (first install has no
 *    directory row until provisioning creates one);
 *  - the selected id IS this machine's local host -> local start, even while
 *    the host is down and its row is the non-dialable booting twin;
 *  - any other selected id -> a remote pick. Nothing local may arm, even
 *    though the row has not resolved yet. This is the case that used to run a
 *    real `convergeReady` against the wrong machine.
 *
 * The intent must come from memory, not from the persisted keys that seed it:
 * both writes are best-effort and swallow failures, so on a machine with
 * blocked storage a live remote pick reads back as "nothing selected" - which
 * is the FIRST-INSTALL answer - and a local restart whose id write failed
 * reads back as a remote pick. Both directions fail toward doing the wrong
 * thing to the local machine, which is the one thing this function exists to
 * prevent.
 *
 * `selectionIntent === null` means there is no directory at all (no runtime
 * binding yet). Nothing can have been selected in that state, so the only
 * boot it can be is the local one.
 */
function resolveLocalBootIntent(args: {
  readonly hasLocalHost: boolean;
  readonly targetEntry: HostDirectoryEntry | undefined;
  readonly selectionIntent: HostSelectionIntent | null;
}): boolean {
  if (!args.hasLocalHost) return false;
  if (args.targetEntry !== undefined) return args.targetEntry.kind !== "remote";
  if (args.selectionIntent === null) return true;
  const { selectedHostId, localHostId } = args.selectionIntent;
  if (selectedHostId === null) return true;
  return localHostId !== null && selectedHostId === localHostId;
}

function presentationFromLifecycle(args: {
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly targetKind: HostTargetKind;
  readonly localBootIntent: boolean;
  readonly configureShell: () => void;
  readonly refreshDirectory: () => void;
  readonly openHostPicker: () => void;
  readonly openSettings: () => void;
  readonly anyHostDialable: boolean;
  readonly requestRespawn: () => void;
  readonly respawnPending: boolean;
}): DefaultHostReadinessPresentation {
  return {
    targetKind: args.targetKind,
    localBootIntent: args.localBootIntent,
    localHostState: args.lifecycle.localHostState,
    stage: args.lifecycle.slowStartStage,
    progress: args.lifecycle.provisioning.progress,
    lastProgress: args.lifecycle.provisioning.lastProgress,
    provisioningError: args.lifecycle.provisioning.error,
    provisioning: args.lifecycle.provisioning.isProvisioning,
    removed: args.lifecycle.provisioning.removed,
    hostBusy: args.lifecycle.provisioning.hostBusy,
    canManageHost:
      targetPresentsLocalHostLifecycle(args.targetKind, args.localBootIntent) &&
      args.lifecycle.provisioning.canManageHost,
    retryProvisioning: args.lifecycle.provisioning.retry,
    forceProvisioning: args.lifecycle.provisioning.force,
    reinstall: args.lifecycle.provisioning.reinstall,
    configureShell: args.configureShell,
    refreshDirectory: args.refreshDirectory,
    openHostPicker: args.openHostPicker,
    openSettings: args.openSettings,
    anyHostDialable: args.anyHostDialable,
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
      hostStatus: null,
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
      hostStatus: null,
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
      hostStatus: null,
    };
  }
  return {
    status: "compatible",
    errorMessage: null,
    retrying: false,
    retry: compatibility.retry,
    degraded: compatibility.degraded,
    unreachable: false,
    hostStatus: compatibility.hostStatus,
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
    presentsLocalHostLifecycle(presentation) &&
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
      fallback={fallbackContent(props.readiness, presentation, props.scope)}
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
          // This card is reached only with NO live converge error (a live one
          // routes to `provisioning-error` first), so any retained stage here
          // belongs to an earlier, already-finished episode.
          includeRetainedProgress: false,
        }),
        actions: [],
      }}
      testId={props.testId}
      messageTestId={null}
    />
  );
}

/**
 * COLD-START default-host gate: until the app has been ready once this
 * window, nothing host-dependent is reachable - not the tab strip, not
 * another tab, not a keyboard route change. Split view made every surface
 * project its own in-place fallback, which left the shell live and let a user
 * drive host-dependent affordances during setup.
 *
 * After the first `ready` render the gate LATCHES and never replaces the app
 * again (one exception below). Blocking a second time is what made every host
 * switch - and every transient probe failure on a host that was running the
 * whole time - throw away the entire DOM: editors, terminals, scroll
 * positions, popovers. The recovery actions did not disappear with the
 * block; they moved into `HostStatusStrip`, which names the transition and
 * carries Retry / report-issue inside a live app.
 *
 * Latch semantics: per-window runtime state, so a window reload always
 * re-gates. That is intended - a cold start still gets the full setup surface
 * and the traycer#738 lockout protection it exists for. A cold start whose
 * default host is REMOTE latches trivially (readiness passes through as
 * `ready`), which is unchanged from today: the remote direction never had
 * that protection, and its failures have always surfaced inline.
 *
 * Three properties are deliberate and must not be "simplified" away:
 *
 *  - It renders through `SurfaceReadinessFallback`, the same mapping the
 *    in-surface slot uses, so every recovery action (retry / force update /
 *    reinstall / report) survives the cold-start block. Collapsing this to a
 *    generic spinner - or re-deriving the surface here - would strand a user
 *    whose host cannot start, the exact lockout traycer#738 exists to prevent.
 *  - `/settings` still bypasses it. The splash's own "Configure shell" button
 *    navigates there, so gating settings on a ready host would make the
 *    escape hatch unreachable from the screen that offers it.
 *  - `mobile-no-host` keeps the full-screen surface even post-latch
 *    (`postLatchSurfaceFor`): a mobile shell with no host at all has no app
 *    worth keeping mounted, and it is not reachable from a desktop switch.
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
  // The latch is state adjusted DURING render (React's documented
  // "adjusting state when props change" pattern) rather than a ref read in
  // render or a `setState` in an effect: this component's whole output is a
  // function of the latch, so it has to be render-visible, and React re-runs
  // this render immediately - before committing anything - instead of
  // painting an un-latched frame first.
  const [hasBeenReady, setHasBeenReady] = useState(false);
  if (readiness.kind === "ready" && !hasBeenReady) {
    setHasBeenReady(true);
  }
  // Only a signed-in user can HAVE a ready default host, so blocking anyone
  // else would hide the sign-in surface behind a host that cannot exist yet.
  // `resolveSurfaceReadiness` only special-cases auth for the request-context
  // arm; the host arms answer `loading-host`/`mobile-no-host` regardless of
  // who is signed in, which is correct for a surface and wrong for a gate.
  if (authStatus !== "signed-in") return props.children;
  if (pathname.startsWith(GATE_BYPASS_PATH_PREFIX)) return props.children;
  if (readiness.kind === "ready") return props.children;
  if (hasBeenReady && postLatchSurfaceFor(readiness.kind) !== "splash") {
    return props.children;
  }
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
  scope: HostReadinessScope,
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
      return unavailableFallback(scope, presentation);
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
  if (!presentsLocalHostLifecycle(presentation)) {
    // A remote - or not-yet-resolved - host still settling: the rich
    // progress/log card below is local-bootstrap specific and would be
    // misleading here (it offers to respawn a machine this app may not own).
    // Never "Starting local Traycer Host…" on this arm. That copy is a claim
    // about THIS machine's host, and this arm is reached precisely when the
    // wait belongs to some other machine - a remote target, or a selection
    // the app has not resolved yet. Saying it there described the wrong
    // computer to the user and sent every resulting bug report at the local
    // bootstrap path.
    return {
      message:
        kind === "compatibility-checking"
          ? "Checking Traycer Host compatibility…"
          : "Connecting to Traycer Host…",
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
      // The one report the retained stage explains: this card renders only
      // while the converge error that produced it is still live.
      includeRetainedProgress: true,
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
      // Same reason the source differs: an install stage on a #860-shaped
      // report points triage at provisioning, which is the wrong place.
      includeRetainedProgress: false,
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
    // A host that came up and answered cannot be explained by how some
    // earlier install attempt died.
    includeRetainedProgress: false,
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
          className="max-w-full break-words rounded-md bg-foreground/5 px-3 py-2 text-left text-ui-xs text-muted-foreground"
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
 * A host that is not dialable, in whichever scope asked.
 *
 * The copy is scope-aware because the two scopes are not the same failure and
 * were never the same sentence. "This tab's host is unavailable." called the
 * whole app a tab whenever the DEFAULT host reached this state - and it is
 * the default host that reaches it, since no production surface uses the
 * `tab-host` scope today (`top-level-tab-host.tsx` hardcodes a null tab host;
 * real per-tile deaths render `dead-tile-banner`). The tab wording is kept for
 * the day a real `tab-host` scope exists.
 *
 * With D7's auto-failover in place the default-host arm usually means nothing
 * in the directory is dialable - but not always: the two-read wait before a
 * failover and a booting local host with a dialable remote reach it too, which
 * is why the report family branches on the live `anyHostDialable` fact instead
 * of assuming zero-dialable. Either way this is the state that needs actions.
 * It shipped with none:
 * `actions: []`, `footer: null`, rendered full-screen with the tab strip and
 * the header's settings entry gone. All four here are reachable without a
 * host: re-read the registry, open the picker (mounted outside the gate,
 * `traycer-app.tsx`), open settings (`/settings` bypasses the gate), and
 * report - the one affordance every other failure card already carried.
 */
function unavailableFallback(
  scope: HostReadinessScope,
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  if (scope !== "default-host") {
    return {
      message: "This tab's host is unavailable.",
      detail: null,
      body: null,
      footer: null,
      actions: [],
    };
  }
  const report = presentation.anyHostDialable
    ? // Something in the directory IS dialable, so this is one host that
      // cannot be reached - the two-read wait before a failover takes the
      // other one, or this machine's own host booting while a remote is
      // listed. Both are real states of this card, and neither is a
      // directory-wide outage.
      {
        title: "Selected Traycer Host is not reachable",
        message: "The selected Traycer Host could not be reached.",
        code: "HOST_SELECTED_UNREACHABLE",
      }
    : {
        title: "No Traycer Host is reachable",
        message: "No host in the directory could be reached.",
        code: "HOST_NONE_DIALABLE",
      };
  return {
    message: "Traycer Host is unavailable",
    // Says only what holds on EVERY path that reaches this arm. "Traycer will
    // switch you automatically" reads well and would be a lie here: the
    // failover moves a REMOTE selection with a dialable alternative, and this
    // card is also what a local host that is down renders (its own lifecycle
    // owns that recovery, and it is never failed away from).
    detail: presentation.anyHostDialable
      ? "Traycer can't reach this host right now. Another host is available - switch to it, or retry."
      : "Traycer can't reach this host right now, and no other host in the directory is reachable either.",
    body: null,
    // Two families, chosen by a FACT the directory answers
    // (`anyHostDialable`), never by the readiness kind that led here - the
    // card is reached from states that mean different things. Neither is the
    // slow-local-host card's `HOST_UNAVAILABLE` / "Host startup": that one
    // means "this machine's host did not come up", and collapsing distinct
    // causes into one title is the 2026-07-31 triage failure
    // `hostFailureReportIssueAction` exists to end.
    footer: hostFailureReportIssueAction({
      title: report.title,
      message: report.message,
      code: report.code,
      source: "Host connection",
      presentation,
      // Any retained install stage belongs to an earlier, finished episode -
      // pointing triage at provisioning would be the wrong place.
      includeRetainedProgress: false,
    }),
    actions: [
      {
        label: "Retry",
        testId: "host-unavailable-retry",
        variant: "outline",
        disabled: false,
        pending: false,
        onClick: presentation.refreshDirectory,
      },
      {
        label: "Switch host",
        testId: "host-unavailable-switch-host",
        variant: "outline",
        disabled: false,
        pending: false,
        onClick: presentation.openHostPicker,
      },
      {
        label: "Open settings",
        testId: "host-unavailable-open-settings",
        variant: "outline",
        disabled: false,
        pending: false,
        onClick: presentation.openSettings,
      },
    ],
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
