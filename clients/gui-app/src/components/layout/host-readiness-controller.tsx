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

/** A single signed-in owner for host reachability and lifecycle state. */
export function HostReadinessControllerProvider(props: {
  readonly onConfigureShell: () => void;
  readonly onOpenSettings: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const authStatus = useAuthStore((state) => state.status);
  // Read every render off LIVE in-memory state, never from storage: while the
  // target is UNRESOLVED this is the only thing that separates a cold local
  // start from a remote host whose directory row has not arrived. The intent
  // is the AUTHORITY's derived effective host (redesign P1.2) - the directory
  // no longer holds one - and it changes the instant Activate re-derives,
  // which re-renders this controller.
  const effectiveHostId = useEffectiveHostId();
  // The authority's own verdicts, for the default-host readiness arm below.
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  // The app-wide client, resolved from that id. It used to be the spine, whose
  // answer came from the active slot; P4.2 deleted the slot, so the id-pinned
  // requester is what reports "the effective host, once its row exists".
  //
  // APP-WIDE BY CONSTRUCTION: this controller is a top-level provider, so every
  // host-scoped surface renders INSIDE it and none can re-provide above it. The
  // explicit hook is what keeps that true if the tree ever moves - this is the
  // app's readiness authority, and a controller reporting a settings panel's
  // host would gate the whole window on a machine the user is only inspecting.
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
  /**
   * The authority's leases and its attach flag, threaded to the DEFAULT-HOST
   * arm of `resolveSurfaceReadiness`. Read there and nowhere else - the
   * tab-host arm stays a route question by design (§1b).
   */
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
    // Depend on the individual fields this closes over, like the presentation
    // memo above. `props` is a fresh object every render, so listing it defeated
    // the memo entirely: the context value changed identity on each render and
    // re-ran every `useSurfaceReadiness` / `useHostReadinessController` consumer
    // across the surface tree.
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

  // THE GATE'S LATCH, lifted from `DefaultHostReadyGate` because the window
  // modal now needs it too - see `HostReadinessController.hasBeenDefaultHostReady`
  // for why, and for why it stays render-adjusted rather than moving to an
  // effect. It is state adjusted DURING render (React's documented "adjusting
  // state when props change" pattern) rather than a ref read in render or a
  // `setState` in an effect: the gate's whole output is a function of it, so it
  // has to be render-visible, and React re-runs this render immediately - before
  // committing anything - instead of painting an un-latched frame first.
  //
  // Monotonic: set once, never cleared, so the widened re-render scope is one
  // extra pass per window rather than a recurring global invalidation.
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
 * The intent must come from memory, not from persisted keys: the local-id
 * write is best-effort and swallows failures, so on a machine with blocked
 * storage a local restart whose id write failed reads back as a remote pick.
 * That direction fails toward doing the wrong thing to the local machine,
 * which is the one thing this function exists to prevent.
 *
 * `selectionIntent === null` means there is no runtime binding yet. Nothing
 * can be effective in that state, so the only boot it can be is the local
 * one.
 */
interface LocalBootSelection {
  /**
   * The host this app is pointed at, or `null` when the authority has no
   * effective host at all (∅ - first run, or nothing usable). NOT resolved
   * against the directory: that is the point.
   */
  readonly selectedHostId: string | null;
  /** This machine's own local host id, as the directory knows it. */
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

/**
 * The full-screen surface for a readiness kind the WINDOW NARRATOR does not
 * own - i.e. the only kinds this gate still draws for itself.
 *
 * Which kinds those are is a TYPE now, not a runtime check: `GateDrawnReadiness`
 * is `SurfaceReadiness` minus `ready` minus everything `windowNarratorOwns`
 * claims. That is what makes the deletions below provable rather than argued -
 * add a kind to the narrator without removing its case here and this file stops
 * compiling, instead of quietly reviving a second narrator.
 *
 * Exported for ONE reader outside this file: the boot-family screenshot gallery
 * (`__tests__/browser/host-boot-family-gallery.tsx`), which renders every face
 * of the launch side by side to prove they are one card. Production mounts it
 * only through `DefaultHostReadyGate`.
 */
export function SurfaceReadinessFallback(props: {
  readonly readiness: GateDrawnReadiness;
}): ReactNode {
  const controller = useHostReadinessController();
  const presentation = controller.defaultHostPresentation;
  // The auth-restore wait is a WAIT, not a terminal, and it can sit between
  // the attach cover and the narrator's card on any launch. It therefore wears
  // the shared boot surface - same card, same idle sentence, same Show details
  // / Open settings footer - rather than a bare "Restoring authenticated
  // session…" line with no spinner and no controls, which read as a fourth,
  // unrelated card taking a turn in the middle of one launch. The sentence is
  // the family's idle heading on purpose: while nothing lane-specific is
  // known every phase says the same thing, and "Traycer is starting" is what
  // restoring the session is a step of.
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
  // No install-progress read here any more. Every kind that HAD progress to
  // show (`loading-host`, `provisioning-host`, the slow-host card) belongs to
  // the window narrator now; the kinds left are terminals with nothing
  // streaming behind them.
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
 * positions, popovers. The recovery actions did not disappear with the block:
 * they are the window modal's now (D10/D11), which derives from the
 * authority's leases and narrates once, for the window, wherever the app is.
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
  // The latch is no longer this component's state - it moved to the readiness
  // controller so the window modal can read it too. See
  // `HostReadinessController.hasBeenDefaultHostReady`, which carries the reason
  // it stays render-adjusted rather than becoming an effect.
  const { hasBeenDefaultHostReady, defaultHostPresentation } =
    useHostReadinessController();
  // Both questions come from ONE place, shared with the window modal. They are
  // genuinely different questions: for a narrator-owned kind this gate still
  // BLOCKS - the app must not mount against a host that cannot serve it - while
  // drawing no card of its own, leaving the words to the modal. Deriving either
  // one here as well as there is what let two surfaces narrate one failure.
  const predicateInput = {
    readiness,
    hasBeenReady: hasBeenDefaultHostReady,
    signedIn: authStatus === "signed-in",
    bypassed: pathname.startsWith(GATE_BYPASS_PATH_PREFIX),
  };
  if (!gateBlocksApp(predicateInput)) return props.children;
  // The frame stays (header + background) so the block still looks like the
  // app rather than a blank document, and so a user whose modal is suppressed
  // on `/settings` is not left staring at nothing.
  //
  // `null` here means the window narrator owns this kind: `ready` and the
  // not-blocking cases are already gone via `gateBlocksApp` above. The card gets
  // the NARROWED value, so it cannot be handed a kind the narrator speaks for
  // even by accident.
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

/**
 * The narrator-owned slot's cover for the ATTACH gap. The window narrator is
 * structurally silent until the selection kernel attaches
 * (`deriveWindowNarration` returns silent on `attached: false`), and this
 * frame used to render nothing there - a blank page with only the header for
 * the whole attach latency, under a data attribute claiming a narrator that
 * was provably not rendering yet. One speaker at every moment: this card
 * shows only while the narrator cannot speak, and yields the instant it can.
 *
 * The line is deliberately NOT from the F19 lane table - no lane is known to
 * be running yet; this is the window finding its authority, and claiming
 * "Starting local Traycer Host…" here would name a machine nothing has
 * resolved.
 */
function AttachPendingCard(props: {
  readonly presentation: DefaultHostReadinessPresentation;
}): ReactNode {
  const attached = useSelectionAuthorityAttached();
  if (attached) return null;
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      {/* The shared boot SURFACE, not a card of its own: this sits between the
          runtime fallback and the narrator's startup card in one launch, and a
          third shape - or a card missing the controls its neighbours have -
          is what made the sequence read as unrelated modals. */}
      <HostBootSurface
        testId="host-gate-attach-pending"
        onConfigureShell={props.presentation.configureShell}
        onOpenSettings={props.presentation.openSettings}
      />
    </div>
  );
}

/**
 * The gate's own full-screen card, drawn through the SHARED boot card.
 *
 * It used to carry its own `max-w-md` card, which was the released splash's
 * shape before the gate took over. That predated the boot-card family; once
 * the family existed, this was the one member with a different width, so a
 * launch that ended on a terminal (a failed install, a removed host) widened
 * its card by 64px at the very moment it had bad news. Same card, same
 * centring, same spinner rules; this frame adds only the message, the
 * optional detail line, a body slot and the action row.
 *
 * It took a `variant` until P3.2: `slot` was the bounded in-surface form, drawn
 * without a card because it sat inside a tab's frame. P2.2 deleted the per-pane
 * readiness boundaries that were its only producer, so the branch had no caller
 * left; tabs gate on their own host's lease now and render their own tile
 * states.
 */
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
          // The same heading treatment as the narrator's titled faces
          // (`WindowHostStartupCard`): a settled failure gets a title, and the
          // two cards that can say "this machine's host didn't start" say it
          // in the same type on the same card.
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
  /** The heading of a SETTLED state, or null for a card that is only a line. */
  readonly title: string | null;
  readonly message: string | null;
  /** Rich slot content rendered between the message and the actions row. */
  readonly body: ReactNode | null;
  /** Rich content rendered alongside the action buttons, in the same row. */
  readonly footer: ReactNode | null;
  readonly actions: ReadonlyArray<ReadinessFallbackAction>;
}

/**
 * The gate-drawn kinds that are TERMINALS - a card with a message and actions
 * rather than a wait. `restoring-request-context` is a wait and draws the boot
 * surface instead (see `SurfaceReadinessFallback`), so it is carved out here
 * at the type level: the switch below is total over what is left, and a new
 * gate-drawn kind has to say which of the two it is.
 */
type GateTerminalReadiness = Exclude<
  GateDrawnReadiness,
  { readonly kind: "restoring-request-context" }
>;

/**
 * Three kinds, and the type says so.
 *
 * `loading-host`, `provisioning-host` and `unavailable-host` are absent because
 * `GateDrawnReadiness` excludes them - the window narrator speaks for all three.
 * Their renderers went with them: `loadingFallback` (its last live kind was the
 * compat probe, deleted by D13 with the rest of the compat readiness
 * vocabulary), and `unavailableFallback` + `SlowHostFallback`, which had been
 * unreachable since the narrator landed and which nothing detected because
 * reachability was a predicate rather than a type.
 */
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
        // The original card named the actual next step. "Reinstall to start
        // the host again" answered a question the user was not asking: they
        // removed it on purpose and need to know how to finish.
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
          // The family's escape hatch, on this card too. Removing this
          // machine's background components does not remove the account's
          // OTHER hosts, and Settings ▸ Host is where one of those gets
          // activated - a user who removed local Traycer on purpose may well
          // be doing so to work from a remote machine. Same rule as every
          // other card in the launch: never a terminal with no way to Settings.
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
    // THE DIAGNOSTICS, and this card had none. It is drawn when this machine's
    // install just failed, and it WINS over the window narrator on that state
    // (`gateCardReadiness`) - which meant the narrator's settled arm, the one
    // place the attempt panel and the bootstrap.log path lived, was unreachable
    // for exactly the launch that most needed them. A user staring at "Could
    // not start Traycer Host." with Retry and nothing else has no path to take
    // the failure anywhere. Same body as the narrator's settled arm, by
    // composition rather than by copy: the attempt panel first (it explains
    // the state), then the log disclosure with NO trailing peer, because this
    // card has a real action row that already carries `Open settings`.
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
      // THE ESCAPE HATCH, and it was missing here.
      //
      // This card is drawn when the local host could not start, offering Retry -
      // an action that may keep failing for a reason only Settings ▸ Shell can
      // fix, since that page edits the launch config through the CLI with no
      // running host involved. A card that can only retry the thing that just
      // failed is a dead end for exactly the user who is stuck.
      //
      // Unconditional, deliberately, and the same rule the window modal states
      // for its own copy of this button: gating the escape hatch behind the
      // failure it exists to fix is the lockout that surface exists to prevent.
      // It is NOT disabled while provisioning either - a retry in flight is
      // precisely when someone wants to go and change the shell it is using.
      //
      // Independent of whether anything ever suppresses the modal over this
      // card: the gap is real on its own, and this card has to be survivable
      // whether it is the only narrator or not.
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
