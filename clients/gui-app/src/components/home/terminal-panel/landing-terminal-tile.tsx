import { Suspense, useCallback, useEffect, type ReactNode } from "react";
import { useStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TerminalLoadingSkeleton } from "@/components/epic-canvas/renderers/terminal-loading-skeleton";
import { TerminalGridMeasureProbe } from "@/components/epic-canvas/renderers/terminal-grid-measure-probe";
import {
  TerminalXtermHost,
  useTerminalTileBootstrap,
  type TerminalCreatePayload,
} from "@/hooks/agent/use-terminal-tile-bootstrap";
import type {
  TerminalDataWriter,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { Button } from "@/components/ui/button";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";

const INDEPENDENT_SCOPE: TerminalScope = { kind: "independent" };

export interface LandingTerminalTileProps {
  readonly tab: LandingTerminalTabRef;
  readonly active: boolean;
  /** True only after active-host probe/reconciliation has settled. */
  readonly createEnabled: boolean;
}

/** One permanent, host-bound terminal tile in the landing panel stack. */
export function LandingTerminalTile(
  props: LandingTerminalTileProps,
): ReactNode {
  return (
    <TabHostProvider hostId={props.tab.hostId}>
      <PaneVisibilityContext.Provider value={props.active}>
        <LandingTerminalTileBody {...props} />
      </PaneVisibilityContext.Provider>
    </TabHostProvider>
  );
}

function LandingTerminalTileBody(props: LandingTerminalTileProps): ReactNode {
  // A `TERMINAL_ID_TAKEN` response re-keys the persisted ref. Bootstrap keeps
  // a one-shot create latch, so session id is intentionally a subtree key:
  // the fresh desired id must start with a fresh list/create lifecycle.
  return <LandingTerminalTileBootstrap key={props.tab.sessionId} {...props} />;
}

function LandingTerminalTileBootstrap(
  props: LandingTerminalTileProps,
): ReactNode {
  const removeExitedTab = useLandingTerminalStore(
    (state) => state.removeExitedTab,
  );
  const rekeyTab = useLandingTerminalStore((state) => state.rekeyTab);
  const hostEntry = useHostDirectoryEntry(props.tab.hostId);
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
    removeExitedTab(props.tab.instanceId);
  }, [bootstrap.hostSessionExited, props.tab.instanceId, removeExitedTab]);

  useEffect(() => {
    if (bootstrap.createError?.code !== "TERMINAL_ID_TAKEN") return;
    rekeyTab(props.tab.instanceId, `landing-term-${uuidv4()}`);
  }, [bootstrap.createError?.code, props.tab.instanceId, rekeyTab]);

  if (hostEntry === null || hostEntry.status === "unavailable") {
    return <TerminalDeadState hostLabel={hostEntry?.label ?? "This host"} />;
  }
  if (bootstrap.createIsError) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 bg-canvas p-4 text-center text-ui-sm text-destructive">
        <span>
          {bootstrap.createError?.message ?? "Could not start terminal."}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={bootstrap.retry}
        >
          Retry
        </Button>
      </div>
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
      onExited={removeExitedTab}
    />
  );
}

function LandingTerminalTileLive(props: {
  readonly handle: TerminalSessionStoreHandle;
  readonly tab: LandingTerminalTabRef;
  readonly onExited: (instanceId: string) => void;
}): ReactNode {
  const { handle, tab, onExited } = props;
  const status = useStore(handle.store, (state) => state.status);
  const effectiveCols = useStore(handle.store, (state) => state.effectiveCols);
  const effectiveRows = useStore(handle.store, (state) => state.effectiveRows);

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
            findTargetId={null}
            // Mirrors the registry's linger rule: while the session is live its
            // handle outlives this unmount (tab switch away from the landing
            // page), and the store's writer keeps pointing at this engine - so
            // the engine must survive too, or a return within the linger
            // window would reattach a blank terminal (the host snapshot was
            // already consumed). The registry follower disposes the engine
            // when the lingering handle is finally evicted.
            keepAlive={status !== "exited"}
          />
        </Suspense>
      </div>
    </div>
  );
}

function TerminalDeadState(props: { readonly hostLabel: string }): ReactNode {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center bg-canvas p-4 text-center text-ui-sm text-muted-foreground">
      {props.hostLabel} is offline. This terminal stays bound to that host.
    </div>
  );
}
