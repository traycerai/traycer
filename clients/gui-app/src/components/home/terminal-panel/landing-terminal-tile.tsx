import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
  type HostReachability,
} from "@/hooks/agent/use-host-reachability";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import {
  clearPendingTerminalFocus,
  focusTerminalInstance,
  terminalFocusOwnsInstance,
} from "@/lib/terminals/terminal-focus-registry";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import { resolveLandingTerminalSyncedTitle } from "./landing-terminal-reconciliation";
import type { LandingTerminalAuthorityEntry } from "./landing-terminal-authority-fleet";
import { useLandingTerminalDurableLifecycle } from "./landing-terminal-durable-bootstrap";
import {
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

/** One permanent, host-bound terminal tile in the landing panel stack. */
export function LandingTerminalTile(
  props: LandingTerminalTileProps,
): ReactNode {
  // Compose with the hosting surface's visibility rather than replacing it: the
  // panel now stays mounted while its start page is merely retained, so the
  // ACTIVE tile of a backgrounded page would otherwise report itself visible
  // (and, through `usePaneFocused`, focused) while its whole pane sits under
  // `display:none`. Both halves have to be true for this tile to be on screen.
  const surfaceVisible = usePaneVisible();
  // Computed here rather than inline in the JSX: `jsx-no-leaked-render`
  // rewrites an inline `&&` into `? … : null`, which is right for children and
  // wrong for a boolean prop.
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
  const removeExitedTab = useLandingTerminalStore(
    (state) => state.removeExitedTab,
  );
  const handleExitedTab = useCallback(
    (instanceId: string): void => {
      const ownsFocus = terminalFocusOwnsInstance(instanceId);
      const wasActive =
        useLandingTerminalStore.getState().activeInstanceId === instanceId;
      removeExitedTab(props.landingPageId, instanceId);
      if (!wasActive || !ownsFocus) return;
      const state = useLandingTerminalStore.getState();
      if (
        landingTerminalLayoutFor(state, props.landingPageId).panelOpen &&
        state.activeInstanceId !== null
      ) {
        focusTerminalInstance(state.activeInstanceId);
        return;
      }
      clearPendingTerminalFocus(instanceId);
      focusActiveComposer();
    },
    [props.landingPageId, removeExitedTab],
  );
  const rekeyTab = useLandingTerminalStore((state) => state.rekeyTab);
  // Derivation, not a coarse read. This gate replaces the tile with an explicit
  // "is offline" state, which is a claim about a machine — so it asks the one
  // hook that knows the difference between the cloud saying a host is gone and
  // the cloud failing to answer, and that lets a live E2E session outrank
  // either. It used to read the coarse bit, so a single degraded liveness read
  // told someone their working terminal's host was off.
  const reachability = useHostReachability(props.tab.hostId);
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
  if (
    reachability.status === "checking" ||
    reachability.status === "host-starting"
  ) {
    // The directory has not answered yet, or is empty because this machine's
    // own host has not published. Neither is evidence about the bound host, and
    // this tile used to render the dead state for both.
    return <LandingTerminalWaiting />;
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
    // Same layout box as the live tile below (relative flex-1 column) so the
    // measurement probe underneath measures the real grid before the
    // create/subscribe are dispatched - see `TerminalGridMeasureProbe`.
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col bg-canvas">
        <div className="relative min-h-0 flex-1">
          <TerminalGridMeasureProbe
            sessionId={props.tab.sessionId}
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
  const projection =
    entry.authority.collection?.terminalsById[props.tab.sessionId];
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
    peekXtermHostGridForSession(props.tab.sessionId) ?? {
      cols: TERMINAL_DEFAULT_COLS,
      rows: TERMINAL_DEFAULT_ROWS,
    };
  const runtimeRunning = projection?.runtime.status === "running";
  // Memoized because `useLandingTerminalDurableLifecycle` lists both in its
  // effect deps: fresh identities every render re-run that effect on every
  // render, leaving its dispatched-episode ref as the only thing standing
  // between a re-render and a duplicate create. `mutateAsync` is referentially
  // stable (the authority fleet already depends on it that way), so the real
  // inputs are the request fields.
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
    adoptWarmSessionInstance(props.tab.sessionId, props.tab.instanceId);
  }, [props.tab.instanceId, props.tab.sessionId]);

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
    // `canMutate` tracks LIST-STREAM freshness, not terminal liveness - the
    // authority hook drops it on every `reconnecting` status and restores it
    // only once a fresh snapshot lands. Gating the whole tile on it swapped a
    // running terminal (and the input focus in it) for a skeleton on each
    // reconnect, which the legacy branch never does. It only means "cannot
    // dispatch a mutation yet", so it belongs here, where there is nothing to
    // tear down.
    if (!props.canMutate) return <LandingTerminalWaiting />;
    return (
      <div className="relative flex h-full min-h-0 w-full flex-col bg-canvas">
        <div className="relative min-h-0 flex-1">
          <TerminalGridMeasureProbe
            sessionId={props.tab.sessionId}
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

function LandingTerminalTileLive(props: {
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
            tileKind="terminal"
            chrome="flush"
            instanceId={tab.instanceId}
            effectiveCols={effectiveCols}
            effectiveRows={effectiveRows}
            onUserInput={handleInput}
            onContainerResize={handleResize}
            onWriterReady={handleWriter}
            // Landing tiles stay mounted while the panel is collapsed, so a
            // visibility-driven focus grab would fire on every landing-page
            // mount (new tab, tab switch back) and steal the composer's focus.
            // Focus moves here only through explicit gestures, routed via the
            // terminal-focus registry by the panel.
            shouldFocusOnActivePane={false}
            registerImperativeFocus
            findTargetId={null}
            // Mirrors the registry's linger rule: while the session is live its
            // handle outlives this unmount (tab switch away from the landing
            // page), and the store's writer keeps pointing at this engine - so
            // the engine must survive too, or a return within the linger
            // window would reattach a blank terminal (the host snapshot was
            // already consumed). The registry follower disposes the engine
            // when the lingering handle is finally evicted.
            keepAlive={status !== "exited"}
            onTerminalReady={null}
          />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The tile replaced by a failed start and its retry. Shared by the legacy and
 * durable branches so the two failures stay one visual state - only the
 * message source differs.
 */
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

/**
 * The tile replaced by an explanation of why its host cannot be reached.
 *
 * `plan-restricted` gets its own sentence rather than the offline one, because
 * "is offline" is false for it in a way that costs the reader real time: the
 * machine is running and healthy, it simply has no remote route on this
 * account's plan. Telling them it is off sends them to restart it, and hides
 * the only thing that would actually help.
 *
 * `indeterminate` never reaches here — `useHostReachability` reports it as
 * reachable, so the live path runs and the dial either succeeds or fails on its
 * own evidence.
 */
function TerminalDeadState(props: {
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
