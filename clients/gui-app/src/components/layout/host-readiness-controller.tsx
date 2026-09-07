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
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { AppHeader } from "@/components/layout/header/app-header";
import { HostBootCard } from "@/components/centered-card";
import { HostBootSurface } from "@/components/host/host-boot-surface";
import { LocalBootstrapAttempts } from "@/components/host/local-bootstrap-attempts";
import {
  BootstrapLogDisclosure,
  LocalHostBodyShell,
} from "@/components/local-host-loading";
import { hostFailureReportIssueAction } from "@/components/layout/host-failure-report";
import { compatibilityPresentation } from "@/components/layout/host-compatibility-presentation";
import {
  HostReadinessControllerContext,
  gateBlocksApp,
  gateCardReadiness,
  isHostDialable,
  type GateDrawnReadiness,
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
  HostProvisioningController,
  type HostProvisioningLifecycle,
} from "@/components/host/host-provisioning-controller";
import { GATE_BYPASS_PATH_PREFIX } from "@/lib/host/gate-bypass-path";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useRemoteSessionsPollReadiness } from "@/hooks/host/use-remote-sessions-poll-readiness";
import { useHostBinding } from "@/lib/host";
import { resolveAppWideHostClient } from "@/lib/host/binding-host-client";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import {
  useHostCompatibility,
  type HostCompatibility,
} from "@/lib/host/compatibility-state";
import { useRunnerHost } from "@/providers/use-runner-host";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { appLogger, describeLogError } from "@/lib/logger";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";

export function HostReadinessControllerProvider(props: {
  readonly onConfigureShell: () => void;
  readonly onOpenSettings: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const authStatus = useAuthStore((state) => state.status);
  // Read every render off live in-memory state, never from storage: while the target is unresolved this is the
  // only thing that separates a cold local start from a remote host whose directory row has not arrived.
  const effectiveHostId = useEffectiveHostId();
  // The authority's own verdicts, for the default-host readiness arm below.
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  // The explicit hook is what keeps that true if the tree ever moves.
  const client = useMemo(
    () => resolveAppWideHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
  const readiness = useReactiveHostReadiness(client);
  const directoryEntries = useHostDirectoryEntries(
    binding === null ? null : binding.directory,
  );
  const activeEntry = directoryEntries.find(
    (entry) => entry.hostId === readiness.hostId,
  );
  // Subscribed, not read at render time: every dialability answer below is ready-session-aware, and a readiness
  // flip changes no directory value.
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
  const selectedEntry = client === null ? null : client.getActiveHost();
  const targetEntry = selectedEntry ?? activeEntry;
  const targetKind = resolveHostTargetKind(targetEntry);
  const compatibility = useHostCompatibility();
  const selectionIntent: LocalBootSelection | null =
    binding === null
      ? null
      : {
          selectedHostId: effectiveHostId,
          localHostId: binding.directory.getLocalHostId(),
        };
  const localBootIntent = resolveLocalBootIntent({
    hasLocalHost: runnerHost.hasLocalHost,
    targetEntry,
    selectionIntent,
  });
  // `hasLocalHost` is folded into the intent - a shell with no local host is never booting one.
  const canProvision = authStatus === "signed-in" && localBootIntent;
  const directory = binding === null ? null : binding.directory;
  // Stable identities: the presentation is memoized on its inputs, and a fresh closure each render would re-run
  // every readiness consumer in the surface tree.
  const refreshDirectory = useCallback(() => {
    // Log it and keep the click silent.
    directory?.refresh().catch((error: unknown) => {
      appLogger.warn("[host-readiness] directory refresh rejected", {
        error: describeLogError(error),
      });
    });
  }, [directory]);
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
          leases={leases}
          authorityAttached={authorityAttached}
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
          onOpenSettings={props.onOpenSettings}
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
  /** The authority's leases and its attach flag, threaded to the default-host arm of `resolveSurfaceReadiness`. */
  readonly leases: readonly HostLeaseSnapshot[];
  readonly authorityAttached: boolean;
  readonly hasLocalHost: boolean;
  readonly hasMobileNoHost: boolean;
  readonly lifecycle: HostProvisioningLifecycle;
  readonly compatibility: HostCompatibility;
  readonly targetKind: HostTargetKind;
  readonly localBootIntent: boolean;
  readonly onConfigureShell: () => void;
  readonly onRefreshDirectory: () => void;
  readonly onOpenSettings: () => void;
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
        openSettings: props.onOpenSettings,
      }),
    [
      props.compatibility,
      props.lifecycle,
      props.localBootIntent,
      props.targetKind,
      props.onConfigureShell,
      props.onRefreshDirectory,
      props.onOpenSettings,
    ],
  );
  // ONE resolver, hoisted out of the controller memo so the latch below and the
  // context value cannot resolve readiness by two different routes.
  const resolveFor = useCallback(
    (scope: HostReadinessScope, tabHostId: string | null): SurfaceReadiness => {
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
        leases: props.leases,
        authorityAttached: props.authorityAttached,
      });
      return scope === "default-host"
        ? projectDefaultHostReadiness({
            readiness,
            presentation: defaultHostPresentation,
          })
        : readiness;
    },
    // Depend on the individual fields this closes over, like the presentation memo above.
    [
      defaultHostPresentation,
      props.activeHostId,
      props.authStatus,
      props.directoryEntries,
      props.hasReadySessionFor,
      props.hasLocalHost,
      props.hasMobileNoHost,
      props.leases,
      props.authorityAttached,
      props.requestContextUserId,
    ],
  );

  // Monotonic: set once, never cleared, so the widened re-render scope is one extra pass per window rather than
  // a recurring global invalidation.
  const [hasBeenDefaultHostReady, setHasBeenDefaultHostReady] =
    useState<boolean>(false);
  if (
    resolveFor("default-host", null).kind === "ready" &&
    !hasBeenDefaultHostReady
  ) {
    setHasBeenDefaultHostReady(true);
  }

  const controller = useMemo<HostReadinessController>(
    () => ({
      readinessFor: resolveFor,
      defaultHostPresentation,
      hasBeenDefaultHostReady,
    }),
    [resolveFor, defaultHostPresentation, hasBeenDefaultHostReady],
  );

  return (
    <HostReadinessControllerContext.Provider value={controller}>
      {props.children}
    </HostReadinessControllerContext.Provider>
  );
}

/** `undefined` - no selection bound and no directory row for the active id - is `unknown`, never local: see
 * `HostTargetKind`. */
function resolveHostTargetKind(
  entry: HostDirectoryEntry | undefined,
): HostTargetKind {
  if (entry === undefined) return "unknown";
  return entry.kind === "remote" ? "remote" : "local";
}

/** The intent must come from memory, not from persisted keys. */
interface LocalBootSelection {
  /** The host this app is pointed at, or `null` when the authority has no effective host at all (∅ - first run,
   * or nothing usable). */
  readonly selectedHostId: string | null;
  readonly localHostId: string | null;
}

function resolveLocalBootIntent(args: {
  readonly hasLocalHost: boolean;
  readonly targetEntry: HostDirectoryEntry | undefined;
  readonly selectionIntent: LocalBootSelection | null;
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
  readonly openSettings: () => void;
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
    openSettings: args.openSettings,
    compatibility: compatibilityPresentation(args.compatibility),
  };
}

export function HostScopeReady(props: {
  readonly scope: Exclude<HostReadinessScope, "none">;
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness(props.scope, null);
  return readiness.kind === "ready" ? props.children : null;
}

/** Which kinds those are is a type now, not a runtime check: `GateDrawnReadiness` is `SurfaceReadiness` minus
 * `ready` minus everything `windowNarratorOwns` claims. */
export function SurfaceReadinessFallback(props: {
  readonly readiness: GateDrawnReadiness;
}): ReactNode {
  const controller = useHostReadinessController();
  const presentation = controller.defaultHostPresentation;
  // The auth-restore wait is a wait, not a terminal, and it can sit between the attach cover and the narrator's
  // card on any launch.
  if (props.readiness.kind === "restoring-request-context") {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <HostBootSurface
          testId="host-ready-gate-restoring-request-context"
          onConfigureShell={presentation.configureShell}
          onOpenSettings={presentation.openSettings}
        />
      </div>
    );
  }
  // Every kind that had progress to show (`loading-host`, `provisioning-host`, the slow-host card) belongs to
  // the window narrator now; the kinds left are terminals with nothing streaming behind them.
  return (
    <FallbackFrame
      fallback={fallbackContent(props.readiness, presentation)}
      testId={`host-ready-gate-${props.readiness.kind}`}
      messageTestId={
        props.readiness.kind === "mobile-no-host" ? "mobile-no-host" : null
      }
    />
  );
}

/** Three properties are deliberate and must not be "simplified" away. */
export function DefaultHostReadyGate(props: {
  readonly children: ReactNode;
}): ReactNode {
  const readiness = useSurfaceReadiness("default-host", null);
  const authStatus = useAuthStore((state) => state.status);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // See `HostReadinessController.hasBeenDefaultHostReady`, which carries the reason it stays render-adjusted
  // rather than becoming an effect.
  const { hasBeenDefaultHostReady, defaultHostPresentation } =
    useHostReadinessController();
  // They are genuinely different questions: for a narrator-owned kind this gate still blocks - the app must not
  // mount against a host that cannot serve it - while drawing no card of its own.
  const predicateInput = {
    readiness,
    hasBeenReady: hasBeenDefaultHostReady,
    signedIn: authStatus === "signed-in",
    bypassed: pathname.startsWith(GATE_BYPASS_PATH_PREFIX),
  };
  if (!gateBlocksApp(predicateInput)) return props.children;
  // The frame stays (header + background) so the block still looks like the app rather than a blank document,
  // and so a user whose modal is suppressed on `/settings` is not left staring at nothing.
  const cardReadiness = gateCardReadiness(predicateInput);
  return (
    <div
      className="flex min-h-safe-svh w-full flex-col bg-background text-foreground"
      data-testid="host-ready-gate"
      data-readiness={readiness.kind}
      data-narrated-by-window-modal={cardReadiness === null ? "true" : "false"}
    >
      <AppHeader variant="host-loading" />
      {cardReadiness === null ? (
        <AttachPendingCard presentation={defaultHostPresentation} />
      ) : (
        <SurfaceReadinessFallback readiness={cardReadiness} />
      )}
    </div>
  );
}

/** One speaker at every moment: this card shows only while the narrator cannot speak, and yields the instant it
 * can. */
function AttachPendingCard(props: {
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  const attached = useSelectionAuthorityAttached();
  if (attached) return null;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      {/* The shared boot surface, not a card of its own: this sits between the runtime fallback and the narrator's
         startup card in one launch, and a third shape - or a card missing the controls its neighbours have. */}
      <HostBootSurface
        testId="host-gate-attach-pending"
        onConfigureShell={props.presentation.configureShell}
        onOpenSettings={props.presentation.openSettings}
      />
    </div>
  );
}

/** Same card, same centring, same spinner rules; this frame adds only the message, the optional detail line, a
 * body slot and the action row. */
function FallbackFrame(props: {
  readonly fallback: ReadinessFallback;
  readonly testId: string;
  readonly messageTestId: string | null;
}): ReactNode {
  const hasActionsRow =
    props.fallback.actions.length > 0 || props.fallback.footer !== null;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background p-6 text-foreground"
      data-testid={props.testId}
    >
      <HostBootCard testId={null} dataset={{}} viewportCapped={false}>
        {props.fallback.title === null ? null : (
          // The same heading treatment as the narrator's titled faces (`WindowHostStartupCard`).
          <h2 className="font-heading text-lg leading-none font-medium">
            {props.fallback.title}
          </h2>
        )}
        {props.fallback.message === null ? null : (
          <p
            data-testid={props.messageTestId}
            className="text-ui-sm text-muted-foreground"
          >
            {props.fallback.message}
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
      </HostBootCard>
    </div>
  );
}

interface ReadinessFallbackAction {
  readonly label: string;
  readonly testId: string;
  readonly variant: "default" | "destructive" | "outline";
  readonly disabled: boolean;
  /** Dropping it left a Retry that only greyed out, which reads as "broken" rather than "working". */
  readonly pending: boolean;
  readonly onClick: () => void;
}

interface ReadinessFallback {
  /** The heading of a settled state, or null for a card that is only a line. */
  readonly title: string | null;
  readonly message: string | null;
  readonly body: ReactNode | null;
  readonly footer: ReactNode | null;
  readonly actions: ReadonlyArray<ReadinessFallbackAction>;
}

/** The gate-drawn kinds that are terminals - a card with a message and actions rather than a wait. */
type GateTerminalReadiness = Exclude<
  GateDrawnReadiness,
  { readonly kind: "restoring-request-context" }
>;

/** Their renderers went with them: `loadingFallback`, and `unavailableFallback` + `SlowHostFallback`. */
function fallbackContent(
  readiness: GateTerminalReadiness,
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  switch (readiness.kind) {
    case "mobile-no-host":
      return {
        title: null,
        message:
          "No host connected. Connect a host from this device to get started.",
        body: null,
        footer: null,
        actions: [],
      };
    case "provisioning-error":
      return provisioningErrorFallback(presentation);
    case "removed-host":
      return {
        title: "Traycer was removed",
        // The original card named the actual next step.
        message:
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
          // Same rule as every other card in the launch: never a terminal with no way to Settings.
          {
            label: "Open settings",
            testId: "local-host-removed-open-settings",
            variant: "outline",
            disabled: false,
            pending: false,
            onClick: presentation.openSettings,
          },
        ],
      };
  }
}

function provisioningErrorFallback(
  presentation: DefaultHostReadinessPresentation,
): ReadinessFallback {
  return {
    // The same heading the narrator's settled cold-start face uses: both cards
    // say "this machine's host didn't start", and they say it identically.
    title: "Traycer Host didn't start",
    message:
      presentation.provisioningError?.message ??
      "Could not start Traycer Host.",
    // Same body as the narrator's settled arm, by composition rather than by copy.
    body: (
      <LocalHostBodyShell>
        <LocalBootstrapAttempts />
        <BootstrapLogDisclosure
          onConfigureShell={presentation.configureShell}
          trailing={null}
        />
      </LocalHostBodyShell>
    ),
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
      // Unconditional, deliberately, and the same rule the window modal states for its own copy of this button:
      // gating the escape hatch behind the failure it exists to fix is the lockout that surface exists to prevent.
      {
        label: "Open settings",
        testId: "local-host-provisioning-open-settings",
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
