import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import {
  PaneVisibilityContext,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import { TerminalLoadingSkeleton } from "@/components/epic-canvas/renderers/terminal-loading-skeleton";
import { TerminalGridMeasureProbe } from "@/components/epic-canvas/renderers/terminal-grid-measure-probe";
import {
  TerminalXtermHost,
  MEASURE_GRID_TIMEOUT_MS,
  useTerminalTileBootstrap,
  type TerminalCreatePayload,
} from "@/hooks/agent/use-terminal-tile-bootstrap";
import type {
  TerminalDataWriter,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { HostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  useHostReachability,
  resolvedHostLabel,
  type HostReachability,
} from "@/hooks/agent/use-host-reachability";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { TileHostLoadState } from "@/components/epic-canvas/renderers/tile-host-load-state";
import {
  isProviderLoginLandingTab,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import { resolveLandingTerminalSyncedTitle } from "./landing-terminal-reconciliation";
import type { LandingTerminalAuthorityEntry } from "./landing-terminal-authority-fleet";
import { useLandingTerminalDurableLifecycle } from "./landing-terminal-durable-bootstrap";
import { LandingSignInTerminalTile } from "./landing-sign-in-terminal-tile";
import { useRemoveExitedLandingTab } from "./use-remove-exited-landing-tab";
import {
  getPlainTerminal,
  selectPlainTerminalViewModel,
  type PlainTerminalViewModel,
} from "@/lib/terminals/plain-terminal-authority";
import {
  adoptWarmSessionInstance,
  peekXtermHostGrid,
  peekXtermHostGridForSession,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import { useTerminalSessionHandle } from "@/lib/registries/terminal-session-registry";

const INDEPENDENT_SCOPE: TerminalScope = { kind: "independent" };
const TERMINAL_DEFAULT_COLS = 80;
const TERMINAL_DEFAULT_ROWS = 24;

export interface LandingTerminalTileProps {
  readonly landingPageId: string;
  readonly tab: LandingTerminalTabRef;
  readonly active: boolean;
  /** True only after active-host probe/reconciliation has settled. */
  readonly createEnabled: boolean;
  readonly authorityEntry: LandingTerminalAuthorityEntry | null;
}

export function LandingTerminalTile(
  props: LandingTerminalTileProps,
): ReactNode {
  // Compose with the hosting surface's visibility rather than replacing it: the panel now stays mounted while
  // its start page is merely retained.
  const surfaceVisible = usePaneVisible();
  // Computed here rather than inline in the JSX: `jsx-no-leaked-render` rewrites an inline `&&` into `?
  const tileVisible = props.active && surfaceVisible;
  return (
    <TabHostProvider hostId={props.tab.hostId}>
      <PaneVisibilityContext.Provider value={tileVisible}>
        <LandingTerminalTileBody {...props} />
      </PaneVisibilityContext.Provider>
    </TabHostProvider>
  );
}

function LandingTerminalTileBody(props: LandingTerminalTileProps): ReactNode {
  // Before the capability switch, whatever the host's authority says: the session is the host's (manager-owned,
  // provider spawn env), so neither bootstrap below may run.
  if (isProviderLoginLandingTab(props.tab)) {
    return <LandingSignInTerminalTile key={props.tab.sessionId} {...props} />;
  }
  const capability = props.authorityEntry?.authority.capability.status;
  if (capability === "legacy") {
    return (
      <LandingTerminalLegacyBootstrap key={props.tab.sessionId} {...props} />
    );
  }
  if (capability === "capable" && props.authorityEntry !== null) {
    return (
      <LandingTerminalDurableBootstrap
        key={props.tab.sessionId}
        {...props}
        authorityEntry={props.authorityEntry}
      />
    );
  }
  return <LandingTerminalWaiting />;
}

export function LandingTerminalLegacyBootstrap(
  props: LandingTerminalTileProps,
): ReactNode {
  const handleExitedTab = useRemoveExitedLandingTab(props.landingPageId);
  const rekeyTab = useLandingTerminalStore((state) => state.rekeyTab);
  // Derivation, not a coarse read.
  const reachability = useHostReachability(props.tab.hostId);
  // Bounded, worded wait - the same one the canvas terminal tiles use, so the
  // landing panel and the canvas cannot describe one host two ways.
  const hostLoad = useBoundedHostLoad({
    hostId: props.tab.hostId,
    hostLabel: resolvedHostLabel(reachability),
    pending:
      reachability.status === "checking" ||
      reachability.status === "host-starting",
  });
  const preparePayload = useCallback(
    (): Promise<TerminalCreatePayload> =>
      Promise.resolve({
        tuiHarnessId: null,
        cwd: props.tab.cwd,
        shellCommand: null,
        shellArgs: null,
        worktreeBusyPaths: [],
      }),
    [props.tab.cwd],
  );
  const bootstrap = useTerminalTileBootstrap({
    hostId: props.tab.hostId,
    scope: INDEPENDENT_SCOPE,
    sessionId: props.tab.sessionId,
    instanceId: props.tab.instanceId,
    sessionKind: "terminal",
    preparePayload,
    enabled: props.createEnabled,
  });

  useEffect(() => {
    if (!bootstrap.hostSessionExited) return;
    handleExitedTab(props.tab.instanceId);
  }, [bootstrap.hostSessionExited, handleExitedTab, props.tab.instanceId]);

  useEffect(() => {
    if (bootstrap.createError?.code !== "TERMINAL_ID_TAKEN") return;
    rekeyTab(props.tab.instanceId, `landing-term-${uuidv4()}`);
  }, [bootstrap.createError?.code, props.tab.instanceId, rekeyTab]);

  if (reachability.status === "unreachable") {
    return (
      <TerminalDeadState
        hostLabel={reachability.hostLabel}
        unavailability={reachability.unavailability}
      />
    );
  }
  if (hostLoad.kind !== "ready") {
    // It is still not a dead state - but it now says which host it is waiting on, and it ends (invariant 6; audit
    // S5's wordless skeleton).
    return (
      <TileHostLoadState
        load={hostLoad}
        subject="terminal"
        onRetry={null}
        testId="landing-terminal-load"
      />
    );
  }
  if (bootstrap.createIsError || bootstrap.createRetryIsPending) {
    return (
      <LandingTerminalErrorState
        message={
          bootstrap.createRetryError?.message ??
          bootstrap.createError?.message ??
          "Could not start terminal."
        }
        isPending={bootstrap.createRetryIsPending}
        onRetry={bootstrap.retry}
      />
    );
  }
  if (bootstrap.handle === null) {
    // Same layout box as the live tile below (relative flex-1 column) so the measurement probe underneath measures
    // the real grid before the create/subscribe are dispatched - see `TerminalGridMeasureProbe`.
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col bg-canvas">
        <div className="relative min-h-0 flex-1">
          <TerminalGridMeasureProbe
            sessionId={props.tab.sessionId}
            hostId={props.tab.hostId}
            instanceId={props.tab.instanceId}
            tileKind="terminal"
            chrome="flush"
            onMeasured={bootstrap.reportMeasuredGrid}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <TerminalLoadingSkeleton />
          </div>
        </div>
      </div>
    );
  }
  return (
    <LandingTerminalTileLive
      handle={bootstrap.handle}
      tab={props.tab}
      onExited={handleExitedTab}
      authoritativeTerminal={null}
    />
  );
}

function LandingTerminalDurableBootstrap(
  props: Omit<LandingTerminalTileProps, "authorityEntry"> & {
    readonly authorityEntry: LandingTerminalAuthorityEntry;
  },
): ReactNode {
  const entry = props.authorityEntry;
  const reachability = useHostReachability(props.tab.hostId);
  const projection = getPlainTerminal(
    entry.authority.collection,
    props.tab.hostId,
    props.tab.sessionId,
  );
  const [measuredGrid, setMeasuredGrid] = useState<{
    readonly cols: number;
    readonly rows: number;
  } | null>(null);
  const [measureTimedOut, setMeasureTimedOut] = useState(false);
  const reportMeasuredGrid = useCallback((cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0) return;
    setMeasuredGrid({ cols, rows });
  }, []);

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
    peekXtermHostGrid(props.tab.instanceId) ??
    peekXtermHostGridForSession({
      hostId: props.tab.hostId,
      sessionId: props.tab.sessionId,
    }) ?? {
      cols: TERMINAL_DEFAULT_COLS,
      rows: TERMINAL_DEFAULT_ROWS,
    };
  const runtimeRunning = projection?.runtime.status === "running";
  // Memoized because `useLandingTerminalDurableLifecycle` lists both in its effect deps.
  const createTerminal = entry.mutations.create.mutateAsync;
  const ensureTerminalRunning = entry.mutations.ensureRunning.mutateAsync;
  const dispatch = useCallback(
    async (action: "create" | "ensure-running") => {
      const response =
        action === "create"
          ? await createTerminal({
              terminalId: props.tab.sessionId,
              scope: INDEPENDENT_SCOPE,
              cwd: props.tab.cwd,
              cols: openingGrid.cols,
              rows: openingGrid.rows,
            })
          : await ensureTerminalRunning({
              hostId: props.tab.hostId,
              terminalId: props.tab.sessionId,
              cols: openingGrid.cols,
              rows: openingGrid.rows,
            });
      return response.terminal;
    },
    [
      createTerminal,
      ensureTerminalRunning,
      openingGrid.cols,
      openingGrid.rows,
      props.tab.cwd,
      props.tab.hostId,
      props.tab.sessionId,
    ],
  );
  const adopt = useCallback(
    (terminal: PlainTerminalProjection): void => {
      useLandingTerminalStore
        .getState()
        .adoptHostTerminal(props.tab.instanceId, terminal);
    },
    [props.tab.instanceId],
  );
  const lifecycle = useLandingTerminalDurableLifecycle({
    projectionStatus:
      projection === undefined ? "missing" : projection.runtime.status,
    pendingCreate: props.tab.pendingCreate === true,
    active: props.active,
    canMutate: entry.authority.canMutate,
    gridReady,
    dispatch,
    adopt,
  });

  useEffect(() => {
    adoptWarmSessionInstance(
      { hostId: props.tab.hostId, sessionId: props.tab.sessionId },
      props.tab.instanceId,
    );
  }, [props.tab.hostId, props.tab.instanceId, props.tab.sessionId]);

  const handle = useTerminalSessionHandle({
    hostId: props.tab.hostId,
    scope: INDEPENDENT_SCOPE,
    sessionId: props.tab.sessionId,
    instanceId: props.tab.instanceId,
    cols: openingGrid.cols,
    rows: openingGrid.rows,
    reattachMode: runtimeRunning ? "live" : "fresh",
    kind: "terminal",
    enabled: gridReady && (runtimeRunning || lifecycle.requestSettled),
  });

  return (
    <LandingTerminalDurableState
      reachability={reachability}
      canMutate={entry.authority.canMutate}
      requestError={lifecycle.requestError}
      requestPending={lifecycle.requestPending}
      retry={lifecycle.retry}
      handle={handle}
      tab={props.tab}
      reportMeasuredGrid={reportMeasuredGrid}
      authoritativeTerminal={
        projection === undefined
          ? null
          : selectPlainTerminalViewModel(projection)
      }
    />
  );
}

function LandingTerminalDurableState(props: {
  readonly reachability: HostReachability;
  readonly canMutate: boolean;
  readonly requestError: Error | null;
  readonly requestPending: boolean;
  readonly retry: () => void;
  readonly handle: TerminalSessionStoreHandle | null;
  readonly tab: LandingTerminalTabRef;
  readonly reportMeasuredGrid: (cols: number, rows: number) => void;
  readonly authoritativeTerminal: PlainTerminalViewModel | null;
}): ReactNode {
  if (props.reachability.status === "unreachable") {
    return (
      <TerminalDeadState
        hostLabel={props.reachability.hostLabel}
        unavailability={props.reachability.unavailability}
      />
    );
  }
  if (
    props.reachability.status === "checking" ||
    props.reachability.status === "host-starting"
  ) {
    return <LandingTerminalWaiting />;
  }
  if (props.requestError !== null) {
    return (
      <LandingTerminalErrorState
        message={props.requestError.message}
        isPending={props.requestPending}
        onRetry={props.retry}
      />
    );
  }
  if (props.handle === null) {
    // It only means "cannot dispatch a mutation yet", so it belongs here, where there is nothing to tear down.
    if (!props.canMutate) return <LandingTerminalWaiting />;
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col bg-canvas">
        <div className="relative min-h-0 flex-1">
          <TerminalGridMeasureProbe
            sessionId={props.tab.sessionId}
            hostId={props.tab.hostId}
            instanceId={props.tab.instanceId}
            tileKind="terminal"
            chrome="flush"
            onMeasured={props.reportMeasuredGrid}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <TerminalLoadingSkeleton />
          </div>
        </div>
      </div>
    );
  }
  return (
    <LandingTerminalTileLive
      handle={props.handle}
      tab={props.tab}
      // Natural PTY exit deletes the durable record, so collection deletion
      // retires this pointer. Only host shutdown/crash retains it as dormant.
      onExited={() => undefined}
      authoritativeTerminal={props.authoritativeTerminal}
    />
  );
}

/** How soon after tile mount an exit still reads as "the shell never started" rather than "the session ended". */
const FAST_EXIT_NOTICE_WINDOW_MS = 5_000;

export function LandingTerminalTileLive(props: {
  readonly handle: TerminalSessionStoreHandle;
  readonly tab: LandingTerminalTabRef;
  readonly onExited: (instanceId: string) => void;
  readonly authoritativeTerminal: PlainTerminalViewModel | null;
}): ReactNode {
  const { handle, tab, onExited } = props;
  const status = useStore(handle.store, (state) => state.status);
  const snapshotLoaded = useStore(
    handle.store,
    (state) => state.snapshotLoaded,
  );
  const effectiveCols = useStore(handle.store, (state) => state.effectiveCols);
  const effectiveRows = useStore(handle.store, (state) => state.effectiveRows);
  const title = useStore(handle.store, (state) => state.title);
  const activeProcessName = useStore(
    handle.store,
    (state) => state.activeProcessName,
  );
  const currentCwd = useStore(handle.store, (state) => state.currentCwd);
  const currentCwdReported = useStore(
    handle.store,
    (state) => state.currentCwdReported,
  );
  const syncDefaultTitle = useLandingTerminalStore(
    (state) => state.syncDefaultTitle,
  );
  const syncedTitle = resolveLandingTerminalSyncedTitle({
    snapshotLoaded,
    title,
    activeProcessName,
    currentCwd,
    currentCwdReported,
    launchCwd: tab.cwd,
  });

  useEffect(() => {
    if (props.authoritativeTerminal !== null || syncedTitle === null) return;
    syncDefaultTitle(tab.instanceId, syncedTitle);
  }, [
    props.authoritativeTerminal,
    syncedTitle,
    syncDefaultTitle,
    tab.instanceId,
  ]);

  // Backstop for a shell that dies at spawn (wrong path, stale flags, the Windows wsl.exe installer stub).
  const mountedAtRef = useRef<number | null>(null);
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    mountedAtRef.current ??= Date.now();
  }, []);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status !== "exited") return;
    if (prev !== "running" && prev !== "creating") return;
    const mountedAt = mountedAtRef.current;
    if (
      mountedAt !== null &&
      Date.now() - mountedAt <= FAST_EXIT_NOTICE_WINDOW_MS
    ) {
      const exitCode = handle.store.getState().exitCode;
      if (exitCode !== null && exitCode !== 0) {
        toast.warning(`Terminal exited immediately (code ${exitCode})`, {
          id: "landing-terminal-fast-exit",
          description:
            "The shell couldn't start. Check Settings → Shell — if it points at WSL, WSL may not be installed on this machine.",
        });
      }
    }
  }, [handle, status]);

  useEffect(() => {
    if (status !== "exited") return;
    onExited(tab.instanceId);
  }, [onExited, status, tab.instanceId]);

  const handleInput = useCallback(
    (data: string) => {
      handle.store.getState().writeInput(data);
    },
    [handle],
  );
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      handle.store.getState().requestResize(cols, rows);
    },
    [handle],
  );
  const handleWriter = useCallback(
    (writer: TerminalDataWriter | null) => {
      handle.store.getState().setWriter(writer);
    },
    [handle],
  );

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-canvas">
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<TerminalLoadingSkeleton />}>
          <TerminalXtermHost
            sessionId={handle.sessionId}
            hostId={tab.hostId}
            tileKind="terminal"
            chrome="flush"
            instanceId={tab.instanceId}
            effectiveCols={effectiveCols}
            effectiveRows={effectiveRows}
            onUserInput={handleInput}
            onContainerResize={handleResize}
            onWriterReady={handleWriter}
            // Landing tiles stay mounted while the panel is collapsed, so a visibility-driven focus grab would fire on
            // every landing-page mount (new tab, tab switch back) and steal the composer's focus.
            shouldFocusOnActivePane={false}
            registerImperativeFocus
            findTargetId={null}
            // Mirrors the registry's linger rule: while the session is live its handle outlives this unmount (tab switch
            // away from the landing page), and the store's writer keeps pointing at this engine.
            keepAlive={status !== "exited"}
            onTerminalReady={null}
          />
        </Suspense>
      </div>
    </div>
  );
}

/** Shared by the legacy and durable branches so the two failures stay one visual state - only the message
 * source differs. */
export function LandingTerminalErrorState(props: {
  readonly message: string;
  readonly isPending: boolean;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 bg-canvas p-4 text-center text-ui-sm text-destructive">
      <span>{props.message}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.isPending}
        onClick={props.onRetry}
      >
        {props.isPending ? (
          <AgentSpinningDots
            className="shrink-0"
            testId="landing-terminal-retry-pending"
            variant={undefined}
          />
        ) : null}
        Retry
      </Button>
    </div>
  );
}

function LandingTerminalWaiting(): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-canvas">
      <TerminalLoadingSkeleton />
    </div>
  );
}

/** The tile replaced by an explanation of why its host cannot be reached. */
export function TerminalDeadState(props: {
  readonly hostLabel: string;
  readonly unavailability: HostUnavailability | null;
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-canvas p-4 text-center text-ui-sm text-muted-foreground">
      {props.unavailability === "plan-restricted"
        ? `${props.hostLabel} is local only on your current plan, so it can't be reached from here. Upgrade to use it remotely; this terminal stays bound to it.`
        : `${props.hostLabel} is offline. This terminal stays bound to that host.`}
    </div>
  );
}
