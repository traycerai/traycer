import { useStore } from "zustand";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Terminal } from "@xterm/xterm";
import type {
  EpicTerminalRef,
  SupportedEpicTerminalRef,
} from "@/stores/epics/canvas/types";
import {
  isImportExemptEpicTerminalRef,
  isLegacyEpicTerminalRef,
  isUnsupportedEpicTerminalRef,
  legacyEpicTerminalEvidence,
} from "@/stores/epics/canvas/types";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useProviderTerminalLogin } from "@/hooks/providers/use-provider-terminal-login";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { beginTerminalLoad } from "@/lib/perf/terminal-load-perf";
import {
  MEASURE_GRID_TIMEOUT_MS,
  TerminalXtermHost,
  useTerminalTileBootstrap,
  type TerminalCreatePayload,
} from "@/hooks/agent/use-terminal-tile-bootstrap";
import {
  useHostReachability,
  resolvedHostLabel,
} from "@/hooks/agent/use-host-reachability";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { TileHostLoadState } from "./tile-host-load-state";
import {
  useTerminalSessionRecovery,
  type TerminalSessionRecovery,
} from "@/hooks/terminal/use-terminal-session-recovery";
import {
  isTerminalCrashExit,
  useTerminalCrashNotification,
} from "@/hooks/terminal/use-terminal-crash-notification";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  TerminalDataWriter,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import { TerminalLoadingSkeleton } from "./terminal-loading-skeleton";
import { TerminalGridMeasureProbe } from "./terminal-grid-measure-probe";
import { TerminalDeadTileBanner } from "./dead-tile-banner";
import { TerminalConnectionOverlay } from "./terminal-connection-overlay";
import { resolveTerminalOverlayState } from "./terminal-connection-overlay-state";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  emitTerminalClosedNotification,
  emitTerminalCrashedNotification,
} from "@/stores/notifications/app-local-notifications-store";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import { TerminalQuoteOverlay } from "./terminal-quote/terminal-quote-overlay";
import { useTerminalFindSessionRow } from "@/hooks/terminal/use-terminal-display-title";
import { terminalSessionTitle } from "@/lib/terminals/terminal-title";
import { useEpicTerminalAuthority } from "@/hooks/terminal/use-epic-terminal-authority";
import type { EpicTerminalAuthorityController } from "@/hooks/terminal/use-epic-terminal-authority";
import { useLandingTerminalDurableLifecycle } from "@/components/home/terminal-panel/landing-terminal-durable-bootstrap";
import { useTerminalSessionHandle } from "@/lib/registries/terminal-session-registry";
import {
  adoptWarmSessionInstance,
  peekXtermHostGrid,
  peekXtermHostGridForSession,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import type { PlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { retryEpicTerminalDurableCreate } from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { hasTerminalPendingCreate } from "@/lib/terminals/pending-create-identity";
import { useEpicTerminalDurableCreate } from "@/hooks/terminal/use-epic-terminal-durable-create";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export interface TerminalTileProps {
  readonly node: EpicTerminalRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

function terminalExitIsNeverSuppressed(): boolean {
  return false;
}

export function TerminalTile(props: TerminalTileProps) {
  const hostId = useTabHostId();
  const epicId = useEpicCanvasStore(
    (state) => state.tabsById[props.viewTabId]?.epicId ?? null,
  );
  const reachability = useHostReachability(hostId);
  // Invariant 6: the pre-bootstrap wait is bounded and it says which host it
  // is waiting on. This tile used to render a wordless skeleton for both
  // `checking` and `host-starting` (audit S5) - indistinguishable from a
  // terminal that was about to appear, and it never ended.
  const hostLoad = useBoundedHostLoad({
    hostId,
    hostLabel: resolvedHostLabel(reachability),
    pending:
      reachability.status === "checking" ||
      reachability.status === "host-starting",
  });
  const crashReportedRef = useRef(false);
  const reportCrashExit = useCallback(() => {
    if (epicId === null) return;
    if (crashReportedRef.current) return;
    crashReportedRef.current = true;
    emitTerminalCrashedNotification({
      instanceId: props.node.instanceId,
      hostId,
      terminalName: props.node.name,
      target: {
        kind: "terminal",
        epicId,
        terminalId: props.node.id,
        tabId: props.viewTabId,
        paneId: props.tileId,
        tileInstanceId: props.node.instanceId,
      },
      cause: "exit",
    });
  }, [
    epicId,
    hostId,
    props.node.id,
    props.node.instanceId,
    props.node.name,
    props.tileId,
    props.viewTabId,
  ]);
  const reportRecoveryExhausted = useCallback(() => {
    // Whichever path observes this terminal death first owns its notification.
    if (crashReportedRef.current) return;
    if (epicId === null) return;
    crashReportedRef.current = true;
    emitTerminalCrashedNotification({
      instanceId: props.node.instanceId,
      hostId,
      terminalName: props.node.name,
      target: {
        kind: "terminal",
        epicId,
        terminalId: props.node.id,
        tabId: props.viewTabId,
        paneId: props.tileId,
        tileInstanceId: props.node.instanceId,
      },
      cause: "recovery-exhausted",
    });
  }, [
    epicId,
    hostId,
    props.node.id,
    props.node.instanceId,
    props.node.name,
    props.tileId,
    props.viewTabId,
  ]);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    props.node.instanceId,
  );
  // Owns the recovery budget + nonce above the bootstrap subtree so they survive
  // the `recoverNonce`-keyed remount the recovery performs.
  const recovery = useTerminalSessionRecovery({
    hostId,
    instanceId: props.node.instanceId,
    onRecoveryExhausted: reportRecoveryExhausted,
  });
  useEffect(() => {
    crashReportedRef.current = false;
  }, [props.node.instanceId]);
  // Open the load timeline at the outermost mount so the reachability gate
  // (which can show a skeleton first) counts toward first-paint time.
  const sessionId = props.node.id;
  useEffect(() => {
    beginTerminalLoad(sessionId, "terminal");
  }, [sessionId]);
  // Directory loss/revocation is the only pre-bootstrap dead-tile gate here.
  // Recoverable transport/session loss is handled by TerminalTileLive's
  // lifecycle overlays so a reattachable remote session never becomes a
  // permanent dead tile because its presence lease changed.
  useEffect(() => {
    if (reachability.status !== "unreachable") return;
    // The reason gates the notification, not just the copy. "Terminal closed"
    // is a claim that a session ENDED, and for `plan-restricted` that is very
    // likely false: the host is running and the PTY with it, this client simply
    // has no remote route to it on this plan. Firing it here put a permanent,
    // persisted "closed" entry in the feed for a terminal an upgrade would hand
    // straight back.
    if (reachability.unavailability === "plan-restricted") return;
    // So does the BASIS, for the same reason one level up. Since F4 this
    // verdict also arrives from a starting host that overran its budget, and
    // that is the UI's patience expiring, not proof the PTY died - the tile
    // stops waiting (it must), but writing "permanently closed" into the feed
    // off a timer would persist a claim about a machine that is very likely
    // still running. Presentation falls; the death event needs directory
    // evidence.
    if (reachability.basis !== "directory") return;
    if (epicId === null) return;
    emitTerminalClosedNotification({
      instanceId: props.node.instanceId,
      hostId,
      hostLabel: reachability.hostLabel,
      target: {
        kind: "terminal",
        epicId,
        terminalId: props.node.id,
        tabId: props.viewTabId,
        paneId: props.tileId,
        tileInstanceId: props.node.instanceId,
      },
    });
  }, [
    reachability.status,
    reachability.hostLabel,
    reachability.unavailability,
    reachability.basis,
    epicId,
    hostId,
    props.node.id,
    props.node.instanceId,
    props.tileId,
    props.viewTabId,
  ]);
  if (reachability.status === "unreachable") {
    return (
      <TerminalDeadTileBanner
        hostLabel={reachability.hostLabel}
        ownerKind="terminal"
        unavailability={reachability.unavailability}
        onClose={closeCanvasTile}
        testId={`terminal-tile-${props.tileId}`}
      />
    );
  }
  // "host-starting" = the directory is empty because the local host hasn't
  // published yet (boot/ensure/wake). Rendering the dead banner there showed
  // "permanently closed" for terminals that were seconds from reconnecting -
  // so this stays a non-destructive wait, but a wait WITH WORDS and an end.
  // Past its budget the reachability hook itself falls to `unreachable` (F4),
  // which the arm above answers; `timed-out` here covers the directory that
  // never resolved at all.
  if (hostLoad.kind !== "ready") {
    return (
      <TileHostLoadState
        load={hostLoad}
        subject="terminal"
        onRetry={null}
        testId={`terminal-tile-${props.tileId}`}
      />
    );
  }
  // Keyed on `recoverNonce`: a recovery remounts the bootstrap subtree, re-running
  // `terminal.list -> create` against the (now invalidated) host list.
  return (
    <ReachableTerminalTile
      {...props}
      key={recovery.recoverNonce}
      recovery={recovery}
      onCrashExit={reportCrashExit}
    />
  );
}

function ReachableTerminalTile(
  props: TerminalTileProps & {
    readonly recovery: TerminalSessionRecovery;
    readonly onCrashExit: () => void;
  },
) {
  const epicId = useOpenEpicId();
  const controller = useEpicTerminalAuthority({ epicId, node: props.node });
  if (isUnsupportedEpicTerminalRef(props.node)) {
    return <TerminalStartingTile tileId={props.tileId} />;
  }
  const supportedNode: SupportedEpicTerminalRef = props.node;
  if (isImportExemptEpicTerminalRef(supportedNode)) {
    return <LegacyTerminalTileLive {...props} node={supportedNode} />;
  }
  if (controller.capability === "unknown") {
    return <TerminalStartingTile tileId={props.tileId} />;
  }
  if (controller.capability === "legacy") {
    return <LegacyTerminalTileLive {...props} node={supportedNode} />;
  }
  if (controller.migrationError !== null) {
    return (
      <TerminalStartError
        tileId={props.tileId}
        message={controller.migrationError.message}
        onRetry={controller.retryMigration}
      />
    );
  }
  if (
    isLegacyEpicTerminalRef(supportedNode) &&
    (controller.migrationPending || controller.projection === undefined)
  ) {
    return <TerminalStartingTile tileId={props.tileId} />;
  }
  return (
    <HostTerminalTileLive
      {...props}
      node={supportedNode}
      controller={controller}
      projection={controller.projection}
    />
  );
}

function LegacyTerminalTileLive(
  props: Omit<TerminalTileProps, "node"> & {
    readonly node: SupportedEpicTerminalRef;
    readonly recovery: TerminalSessionRecovery;
    readonly onCrashExit: () => void;
  },
) {
  const hostId = useTabHostId();
  const epicId = useOpenEpicId();
  const sessionId = props.node.id;
  const instanceId = props.node.instanceId;
  const legacyEvidence = legacyEpicTerminalEvidence(props.node);
  const cwd = legacyEvidence.cwd;
  const preparePayload = useMemo(
    () => () =>
      Promise.resolve<TerminalCreatePayload>({
        tuiHarnessId: null,
        cwd,
        shellCommand: null,
        shellArgs: null,
        worktreeBusyPaths: [],
      }),
    [cwd],
  );
  // A sign-in terminal is the HOST's session, not this tile's. Re-creating
  // the id here would spawn a bare shell with none of the provider's spawn env
  // - a prompt that looks like the sign-in terminal but cannot sign anyone in,
  // and no error saying so. The tile attaches when the session is live and
  // offers a restart when it is not; it never creates.
  const signInProviderId =
    props.node.origin === "provider-login"
      ? (props.node.originProviderId ?? null)
      : null;
  const isSignInTerminal = props.node.origin === "provider-login";
  const managerOwned = props.node.lifecycleOwner === "manager";
  const bootstrap = useTerminalTileBootstrap({
    hostId,
    scope: { kind: "epic", epicId },
    sessionId,
    instanceId,
    sessionKind: "terminal",
    preparePayload,
    // `adoptOnly`, not `enabled: false`: the create must never fire, but the
    // measure-grid wait still has to arm or a probe that never reports (a
    // stalled xterm chunk, a zero-sized container) strands the tile on
    // "Starting terminal session…" with no bounded fallback.
    // Manager-owned list rows stay on the live session even without
    // setup/provider origin enrichment; missing enrichment fails closed
    // rather than recreating a bare shell.
    adoptOnly: isSignInTerminal || managerOwned,
  });
  const closeExitedTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    instanceId,
  );

  // The host keeps listing a PTY it saw exit for its ~60s grace window, and the
  // bootstrap refuses to respawn under that id. A tile opened onto such a
  // session therefore has nothing to attach to and no create in flight: left
  // alone it sits on "Starting terminal session…" until the grace lapses, and
  // then - the session now absent rather than exited - quietly spawns a fresh
  // shell in its place. Close it instead, as the landing panel drops the tab.
  //
  // Gated on a null handle so this only ever fires for a tile that never
  // attached. A tile that DID attach owns its own exit down in `TerminalLive`,
  // which deliberately keeps a *crashed* terminal on screen.
  //
  // A sign-in terminal is exempt: closing it would silently retract the only
  // surface that can restart the sign-in, leaving the user with a vanished tab
  // and no explanation. It shows the restart affordance below instead. The
  // attached path in `TerminalLive` carries the same exemption, so the rule
  // holds however the login shell ends.
  const exitedBeforeAttach =
    bootstrap.hostSessionExited &&
    bootstrap.handle === null &&
    !isSignInTerminal;
  useEffect(() => {
    if (!exitedBeforeAttach) return;
    closeExitedTile();
  }, [exitedBeforeAttach, closeExitedTile]);

  // The host has settled on "this session is gone" (absent, or exited and
  // never attached). For an ordinary tile the bootstrap would now spawn a
  // replacement; for this one there is nothing to attach to and nothing this
  // tile may create.
  const signInSessionGone =
    isSignInTerminal &&
    bootstrap.handle === null &&
    (bootstrap.hostHasSession === false || bootstrap.hostSessionExited);

  if (bootstrap.createIsError) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas p-4 text-center text-ui-sm text-destructive"
        data-testid={`terminal-tile-${props.tileId}`}
      >
        <span>
          Failed to start terminal:{" "}
          {bootstrap.createError?.message ?? "Unknown error"}
        </span>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={bootstrap.retry}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Failed to start terminal",
              message: "The terminal session could not be started.",
              code: null,
              source: "Terminal",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    );
  }

  if (signInSessionGone) {
    return (
      <SignInTerminalEndedPanel
        tileId={props.tileId}
        providerId={signInProviderId}
        epicId={epicId}
        viewTabId={props.viewTabId}
        sessionId={sessionId}
        closeSelf={closeExitedTile}
      />
    );
  }

  if (bootstrap.handle === null) {
    // The starting state occupies the SAME layout box the live terminal will
    // (outer column + relative flex-1), so the measurement probe underneath
    // measures the real grid before the create/subscribe are dispatched -
    // see `TerminalGridMeasureProbe`. The status text overlays it.
    return (
      <div
        className="flex h-full w-full min-h-0 flex-col bg-canvas"
        data-testid={`terminal-tile-${props.tileId}`}
      >
        <div className="relative min-h-0 flex-1">
          <TerminalGridMeasureProbe
            sessionId={sessionId}
            hostId={hostId}
            instanceId={instanceId}
            tileKind="terminal"
            chrome="padded"
            onMeasured={bootstrap.reportMeasuredGrid}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-ui-sm text-muted-foreground">
            Starting terminal session…
          </div>
        </div>
      </div>
    );
  }

  return (
    <TerminalLive
      handle={bootstrap.handle}
      epicId={epicId}
      fallbackTitle={legacyEvidence.name}
      instanceId={instanceId}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
      recovery={props.recovery}
      onCrashExit={props.onCrashExit}
      authoritativeTerminal={null}
      closeOnExit
      onClose={closeExitedTile}
      signInTile={
        isSignInTerminal
          ? {
              providerId: signInProviderId,
              epicId,
              sessionId,
              closeSelf: closeExitedTile,
            }
          : null
      }
    />
  );
}

function HostTerminalTileLive(
  props: Omit<TerminalTileProps, "node"> & {
    readonly node: SupportedEpicTerminalRef;
    readonly recovery: TerminalSessionRecovery;
    readonly onCrashExit: () => void;
    readonly controller: EpicTerminalAuthorityController;
    readonly projection: PlainTerminalProjection | undefined;
  },
) {
  const hostId = useTabHostId();
  const epicId = useOpenEpicId();
  const pendingCreate = useEpicCanvasStore((state) =>
    hasTerminalPendingCreate(
      state.pendingCreateTerminalIdentities,
      hostId,
      props.node.id,
    ),
  );
  const durableCreate = useEpicTerminalDurableCreate(hostId, props.node.id);
  const adoptProjection = useEpicCanvasStore(
    (state) => state.adoptHostTerminalProjection,
  );
  const unmarkPendingCreate = useEpicCanvasStore(
    (state) => state.unmarkTerminalPendingCreate,
  );
  const evidence = legacyEpicTerminalEvidence(props.node);
  const [measuredGrid, setMeasuredGrid] = useState<{
    readonly cols: number;
    readonly rows: number;
  } | null>(null);
  const [measureTimedOut, setMeasureTimedOut] = useState(false);
  const reportMeasuredGrid = (cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0) return;
    setMeasuredGrid({ cols, rows });
  };

  useEffect(() => {
    if (measuredGrid !== null || measureTimedOut) return;
    const timer = window.setTimeout(
      () => setMeasureTimedOut(true),
      MEASURE_GRID_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [measureTimedOut, measuredGrid]);
  const gridReady = measuredGrid !== null || measureTimedOut;
  const openingGrid = measuredGrid ??
    peekXtermHostGrid(props.node.instanceId) ??
    peekXtermHostGridForSession({
      hostId,
      sessionId: props.node.id,
    }) ?? {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
  const projection = props.projection;
  const create = props.controller.create;
  const ensureRunning = props.controller.ensureRunning;
  const dispatch = async (action: "create" | "ensure-running") => {
    const response =
      action === "create"
        ? await create.mutateAsync({
            terminalId: props.node.id,
            scope: { kind: "epic", epicId },
            cwd: evidence.cwd,
            cols: openingGrid.cols,
            rows: openingGrid.rows,
          })
        : await ensureRunning.mutateAsync({
            hostId,
            terminalId: props.node.id,
            cols: openingGrid.cols,
            rows: openingGrid.rows,
          });
    return response.terminal;
  };
  const adopt = (terminal: PlainTerminalProjection): void => {
    adoptProjection(hostId, terminal);
    unmarkPendingCreate(hostId, props.node.id);
  };
  const lifecycle = useLandingTerminalDurableLifecycle({
    projectionStatus:
      projection === undefined ? "missing" : projection.runtime.status,
    pendingCreate: pendingCreate && durableCreate === null,
    active: props.isActive,
    canMutate: props.controller.canMutate,
    gridReady,
    dispatch,
    adopt,
  });

  useEffect(() => {
    adoptWarmSessionInstance(
      { hostId, sessionId: props.node.id },
      props.node.instanceId,
    );
  }, [hostId, props.node.id, props.node.instanceId]);

  const runtimeRunning = projection?.runtime.status === "running";
  const handle = useTerminalSessionHandle({
    hostId,
    scope: { kind: "epic", epicId },
    sessionId: props.node.id,
    instanceId: props.node.instanceId,
    cols: openingGrid.cols,
    rows: openingGrid.rows,
    reattachMode: runtimeRunning ? "live" : "fresh",
    kind: "terminal",
    enabled: gridReady && (runtimeRunning || lifecycle.requestSettled),
  });
  // Centered session-ended Close is presentation-only, matching tab X and
  // the directory-offline dead banner. Explicit lifetime deletion stays on
  // the sidebar/named overlay actions, never this surface.
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    props.node.instanceId,
  );

  if (durableCreate?.status === "failed" && durableCreate.error !== null) {
    return (
      <TerminalStartError
        tileId={props.tileId}
        message={durableCreate.error.message}
        onRetry={() => {
          retryEpicTerminalDurableCreate(hostId, props.node.id);
        }}
      />
    );
  }
  if (lifecycle.requestError !== null) {
    return (
      <TerminalStartError
        tileId={props.tileId}
        message={lifecycle.requestError.message}
        onRetry={lifecycle.retry}
      />
    );
  }
  if (handle === null) {
    return (
      <TerminalStartingTile
        tileId={props.tileId}
        probe={
          <TerminalGridMeasureProbe
            sessionId={props.node.id}
            hostId={hostId}
            instanceId={props.node.instanceId}
            tileKind="terminal"
            chrome="padded"
            onMeasured={reportMeasuredGrid}
          />
        }
      />
    );
  }
  return (
    <TerminalLive
      handle={handle}
      epicId={epicId}
      fallbackTitle={props.node.name}
      instanceId={props.node.instanceId}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
      recovery={props.recovery}
      onCrashExit={props.onCrashExit}
      authoritativeTerminal={props.controller.viewModel}
      closeOnExit={false}
      onClose={closeCanvasTile}
      signInTile={null}
    />
  );
}

function TerminalStartingTile(props: {
  readonly tileId: string;
  readonly probe?: ReactNode;
}) {
  return (
    <div
      className="flex h-full w-full min-h-0 flex-col bg-canvas"
      data-testid={`terminal-tile-${props.tileId}`}
    >
      <div className="relative min-h-0 flex-1">
        {props.probe ?? null}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-ui-sm text-muted-foreground">
          Starting terminal session…
        </div>
      </div>
    </div>
  );
}

function TerminalStartError(props: {
  readonly tileId: string;
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas p-4 text-center text-ui-sm text-destructive"
      data-testid={`terminal-tile-${props.tileId}`}
    >
      <span>Failed to start terminal: {props.message}</span>
      <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
        Retry
      </Button>
    </div>
  );
}

interface TerminalLiveProps {
  readonly handle: TerminalSessionStoreHandle;
  readonly epicId: string;
  /** Tile-ref name, used until the host's live title resolves. */
  readonly fallbackTitle: string;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  readonly recovery: TerminalSessionRecovery;
  readonly onCrashExit: () => void;
  readonly authoritativeTerminal: PlainTerminalViewModel | null;
  readonly closeOnExit: boolean;
  readonly onClose: () => void;
  /**
   * Non-null only for a `provider-login` tile. Carries the ended-panel props
   * rather than a bare boolean, because this component owns the ONLY prompt
   * read of the login shell's death.
   *
   * `signInSessionGone` in the parent cannot cover the attached case: it is
   * derived from `terminal.list`, which has a 60s `staleTime` and never polls,
   * so between the shell exiting and the next invalidation the parent still
   * believes the session is live. The store status below is stream-driven and
   * immediate. Without this the tile would sit on a dead, torn-down xterm with
   * no explanation and no way to restart - exactly what the exit-effect
   * exemption was written to prevent.
   */
  readonly signInTile: {
    readonly providerId: ProviderId | null;
    readonly epicId: string;
    readonly sessionId: string;
    readonly closeSelf: () => void;
  } | null;
}

function TerminalLive(props: TerminalLiveProps) {
  const { handle } = props;
  // The live xterm engine, published by the host once it has one. The quote
  // control reads xterm's own selection and buffer coordinates, which the
  // session store does not carry.
  const [term, setTerm] = useState<Terminal | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const hostId = useTabHostId();
  const hostClient = useTabHostClient();
  const sessionRow = useTerminalFindSessionRow({
    client: props.authoritativeTerminal === null ? hostClient : null,
    epicId: props.epicId,
    sessionId: handle.sessionId,
  });
  let liveTitle: string | null = null;
  if (props.authoritativeTerminal !== null) {
    liveTitle = props.authoritativeTerminal.displayTitle;
  } else if (sessionRow !== null) {
    liveTitle = terminalSessionTitle({
      title: sessionRow.title,
      activeProcessName: sessionRow.activeProcessName,
      currentCwd: sessionRow.currentCwd,
    });
  }
  const status = useStore(handle.store, (s) => s.status);
  const exitCode = useStore(handle.store, (s) => s.exitCode);
  const exitReason = useStore(handle.store, (s) => s.exitReason);
  const connectionStatus = useStore(handle.store, (s) => s.connectionStatus);
  const effectiveCols = useStore(handle.store, (s) => s.effectiveCols);
  const effectiveRows = useStore(handle.store, (s) => s.effectiveRows);
  useTerminalCrashNotification({
    handle,
    isExitSuppressed: terminalExitIsNeverSuppressed,
    onCrashExit: props.onCrashExit,
  });

  const { onSessionLost, onSessionHealthy } = props.recovery;
  // Drive automatic recovery off a handle that can no longer address its PTY.
  // `reaped` is definitive for this handle, not for the durable terminal: the
  // host may already have recreated that logical id. The owner force-releases
  // and remounts the bootstrap to reattach or respawn it. "running" refills the
  // auto-recovery budget.
  useEffect(() => {
    if (status === "lost" || status === "reaped") onSessionLost();
  }, [status, onSessionLost]);
  useEffect(() => {
    if (status === "running") onSessionHealthy();
  }, [status, onSessionHealthy]);

  // A crash remains visible in its tile so its unread failure indicator has a
  // tab to attach to. Clean and lifecycle exits retain the existing close
  // behavior. Reuse the notification predicate so emit/close cannot drift.
  //
  // A sign-in terminal is exempt from ALL of it. The tile is the only surface
  // that can restart the sign-in, and a login shell exits on both outcomes -
  // the user typing `exit` after signing in, and the CLI giving up. Closing on
  // the clean exit would retract the restart affordance in exactly the case
  // the user still needs it, and would take the CLI's last words off screen
  // with no explanation. The tile shows the ended panel instead; the user
  // closes the tab themselves.
  const isSignInTerminal = props.signInTile !== null;
  const { closeOnExit, onClose } = props;
  useEffect(() => {
    if (status !== "exited") return;
    if (!closeOnExit) return;
    if (isSignInTerminal) return;
    if (
      isTerminalCrashExit({
        status,
        exitCode,
        exitReason,
        isExitSuppressed: terminalExitIsNeverSuppressed,
      })
    ) {
      return;
    }
    // `closeCanvasTab` resolves the tile by its pane tab *instance* id
    // (`pane.tabInstanceIds`), not the content/session id. Passing
    // `handle.sessionId` silently no-ops, leaving the tab open after exit.
    onClose();
  }, [status, exitCode, exitReason, isSignInTerminal, closeOnExit, onClose]);

  const overlayState = resolveTerminalOverlayState({
    status,
    connectionStatus,
    recoveryExhausted: props.recovery.recoveryExhausted,
  });

  const handleUserInput = useCallback(
    (data: string) => {
      handle.store.getState().writeInput(data);
    },
    [handle],
  );
  const handleContainerResize = useCallback(
    (cols: number, rows: number) => {
      handle.store.getState().requestResize(cols, rows);
    },
    [handle],
  );

  const handleWriterReady = useCallback(
    (writer: TerminalDataWriter | null) => {
      handle.store.getState().setWriter(writer);
    },
    [handle],
  );

  // The attached login shell has ended. Swap the (now torn-down) xterm for the
  // same panel the never-attached path renders, so "Start again" is reachable
  // however the shell died - the user typing `exit` after a successful sign-in,
  // or the CLI giving up. Placed after every hook so the hook order is stable.
  const signInTile = props.signInTile;
  if (signInTile !== null && status === "exited") {
    return (
      <SignInTerminalEndedPanel
        tileId={props.tileId}
        providerId={signInTile.providerId}
        epicId={signInTile.epicId}
        viewTabId={props.viewTabId}
        sessionId={signInTile.sessionId}
        closeSelf={signInTile.closeSelf}
      />
    );
  }

  return (
    <div
      className="flex h-full w-full min-h-0 flex-col bg-canvas"
      data-testid={`terminal-tile-${props.tileId}`}
    >
      {/* `relative` is the anchor for the absolutely-positioned xterm host;
          combined with `flex-1 min-h-0` it gets a definite box from the
          flex column ancestor without forcing children to chase a fragile
          percentage-height chain. */}
      <div ref={paneRef} className="relative min-h-0 flex-1">
        <Suspense fallback={<TerminalLoadingSkeleton />}>
          <TerminalXtermHost
            sessionId={handle.sessionId}
            hostId={hostId}
            tileKind="terminal"
            chrome="padded"
            instanceId={props.instanceId}
            effectiveCols={effectiveCols}
            effectiveRows={effectiveRows}
            onUserInput={handleUserInput}
            onContainerResize={handleContainerResize}
            onWriterReady={handleWriterReady}
            shouldFocusOnActivePane={props.isActive}
            registerImperativeFocus
            findTargetId={
              props.isActive
                ? `terminal:${props.viewTabId}:${props.tileId}:${handle.sessionId}`
                : null
            }
            // Mirrors the registry's linger rule: a running plain terminal's
            // handle now outlives this unmount (its stream stays subscribed for
            // the linger window so tab switches reattach instantly), and the
            // store's writer keeps pointing at this engine - dispose the engine
            // and the reattach would be blank, since the host snapshot was
            // already consumed. The registry follower disposes the engine when
            // the lingering handle is finally evicted; only an exited session
            // tears down eagerly.
            keepAlive={status !== "exited"}
            onTerminalReady={setTerm}
          />
        </Suspense>
        <TerminalQuoteOverlay
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          terminalId={handle.sessionId}
          terminalHostId={hostId}
          terminalTitle={liveTitle ?? props.fallbackTitle}
          terminalCwd={
            props.authoritativeTerminal?.liveCwd ??
            props.authoritativeTerminal?.launchCwd ??
            sessionRow?.cwd ??
            null
          }
          term={term}
          paneRef={paneRef}
        />
        {overlayState !== null ? (
          <TerminalConnectionOverlay
            state={overlayState}
            onReconnect={props.recovery.onManualReconnect}
            testId={`terminal-connection-overlay-${props.tileId}`}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Shown when a sign-in terminal's session is gone. The interactive shell
 * outlives the sign-in, so reaching this state means the user (or a host
 * restart) closed it - there is no session to reattach to and, unlike an
 * ordinary terminal tile, nothing here may create one.
 *
 * The button restarts the sign-in through the same RPC the composer banner
 * uses, which kills nothing (there is nothing left) and hands back a fresh
 * terminal. `providerId` can be absent on a ref written before it was
 * recorded; the copy then points at the composer banner rather than offering a
 * button that cannot know which provider to restart.
 */
function SignInTerminalEndedPanel(props: {
  readonly tileId: string;
  readonly providerId: ProviderId | null;
  readonly epicId: string;
  readonly viewTabId: string;
  /** This dead tile's own session, so the restart can retire it. */
  readonly sessionId: string;
  readonly closeSelf: () => void;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-canvas p-4 text-center text-ui-sm text-muted-foreground"
      data-testid={`terminal-tile-${props.tileId}`}
    >
      <span>Sign-in terminal ended.</span>
      {props.providerId === null ? (
        // A ref written before the provider was recorded. Point at the banner
        // rather than draw a button that cannot know what to restart.
        <span className="text-ui-xs">
          Start a new one from the sign-in prompt above the composer.
        </span>
      ) : (
        <SignInRestartButton
          providerId={props.providerId}
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          sessionId={props.sessionId}
          closeSelf={props.closeSelf}
        />
      )}
    </div>
  );
}

// Split out so the login hook is only instantiated where a provider is
// actually known - no placeholder id standing in for "we do not know".
function SignInRestartButton(props: {
  readonly providerId: ProviderId;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly sessionId: string;
  readonly closeSelf: () => void;
}) {
  const terminalLogin = useProviderTerminalLogin({
    providerId: props.providerId,
    epicId: props.epicId,
    viewTabId: props.viewTabId,
    // After a host restart the coordinator has no pointer, so it reports
    // `replacedSessionId: null` and nothing else would ever close this dead
    // panel - it would accumulate one stale tile per press.
    launchedFromTile: {
      sessionId: props.sessionId,
      close: props.closeSelf,
    },
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={terminalLogin.isPending}
      onClick={terminalLogin.start}
    >
      Start again
      {/* Same pending treatment as the banner's "Sign in from a terminal":
          unchanged label, disabled, inline spinner. Starting a sign-in kills
          and respawns a PTY host-side, so a press with no feedback reads as a
          dead button and invites a second one. */}
      {terminalLogin.isPending ? <MutedAgentSpinner /> : null}
    </Button>
  );
}
