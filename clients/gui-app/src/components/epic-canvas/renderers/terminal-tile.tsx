import { useStore } from "zustand";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import { beginTerminalLoad } from "@/lib/perf/terminal-load-perf";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  TerminalXtermHost,
  useTerminalTileBootstrap,
  type TerminalCreatePayload,
} from "@/hooks/agent/use-terminal-tile-bootstrap";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import {
  useTerminalSessionRecovery,
  type TerminalSessionRecovery,
} from "@/hooks/terminal/use-terminal-session-recovery";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import type {
  TerminalDataWriter,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import { TerminalLoadingSkeleton } from "./terminal-loading-skeleton";
import { TerminalDeadTileBanner } from "./dead-tile-banner";
import { TerminalConnectionOverlay } from "./terminal-connection-overlay";
import { resolveTerminalOverlayState } from "./terminal-connection-overlay-state";
import { Button } from "@/components/ui/button";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";

export interface TerminalTileProps {
  readonly node: EpicTerminalRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

export function TerminalTile(props: TerminalTileProps) {
  const hostId = useTabHostId();
  const reachability = useHostReachability(hostId);
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
  });
  // Open the load timeline at the outermost mount so the reachability gate
  // (which can show a skeleton first) counts toward first-paint time.
  const sessionId = props.node.id;
  useEffect(() => {
    beginTerminalLoad(sessionId, "terminal");
    Analytics.getInstance().track(AnalyticsEvent.TerminalOpened, {
      kind: "shell",
    });
  }, [sessionId]);
  if (reachability.status === "unreachable") {
    return (
      <TerminalDeadTileBanner
        hostLabel={reachability.hostLabel}
        onClose={closeCanvasTile}
        testId={`terminal-tile-${props.tileId}`}
      />
    );
  }
  if (reachability.status === "checking") {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-canvas"
        data-testid={`terminal-tile-${props.tileId}`}
      >
        <TerminalLoadingSkeleton />
      </div>
    );
  }
  // Keyed on `recoverNonce`: a recovery remounts the bootstrap subtree, re-running
  // `terminal.list -> create` against the (now invalidated) host list.
  return (
    <TerminalTileLive
      key={recovery.recoverNonce}
      recovery={recovery}
      {...props}
    />
  );
}

function TerminalTileLive(
  props: TerminalTileProps & { readonly recovery: TerminalSessionRecovery },
) {
  const hostId = useTabHostId();
  const sessionId = props.node.id;
  const instanceId = props.node.instanceId;
  const cwd = props.node.cwd;
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
  const bootstrap = useTerminalTileBootstrap({
    hostId,
    sessionId,
    instanceId,
    sessionKind: "terminal",
    preparePayload,
  });

  if (bootstrap.createIsError) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-canvas text-ui-sm text-destructive"
        data-testid={`terminal-tile-${props.tileId}`}
      >
        <span>
          Failed to start terminal:{" "}
          {bootstrap.createError?.message ?? "Unknown error"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-3"
          onClick={bootstrap.retry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (bootstrap.handle === null) {
    return (
      <div
        className="flex h-full w-full items-center justify-center bg-canvas text-ui-sm text-muted-foreground"
        data-testid={`terminal-tile-${props.tileId}`}
      >
        Starting terminal session…
      </div>
    );
  }

  return (
    <TerminalLive
      handle={bootstrap.handle}
      instanceId={instanceId}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
      recovery={props.recovery}
    />
  );
}

interface TerminalLiveProps {
  readonly handle: TerminalSessionStoreHandle;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  readonly recovery: TerminalSessionRecovery;
}

function TerminalLive(props: TerminalLiveProps) {
  const { handle } = props;
  const status = useStore(handle.store, (s) => s.status);
  const connectionStatus = useStore(handle.store, (s) => s.connectionStatus);
  const effectiveCols = useStore(handle.store, (s) => s.effectiveCols);
  const effectiveRows = useStore(handle.store, (s) => s.effectiveRows);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    props.instanceId,
  );

  const { onSessionLost, onSessionHealthy } = props.recovery;
  // Drive automatic recovery off the lifecycle status. "lost" is the dead-end a
  // dropped+reaped session lands in; the owner force-releases and remounts the
  // bootstrap to respawn it. "running" means a live session, which refills the
  // auto-recovery budget.
  useEffect(() => {
    if (status === "lost") onSessionLost();
  }, [status, onSessionLost]);
  useEffect(() => {
    if (status === "running") onSessionHealthy();
  }, [status, onSessionHealthy]);

  // Auto-close the canvas tab once the host reports the PTY has exited
  // (either because the user typed `exit`, or because something else
  // killed it - including the "X" in the terminals sidebar). The tile's
  // unmount tears down the subscription, which lets the host's grace
  // window evict the now-orphaned session.
  useEffect(() => {
    if (status !== "exited") return;
    // `closeCanvasTab` resolves the tile by its pane tab *instance* id
    // (`pane.tabInstanceIds`), not the content/session id. Passing
    // `handle.sessionId` silently no-ops, leaving the tab open after exit.
    closeCanvasTile();
  }, [status, closeCanvasTile]);

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

  return (
    <div
      className="flex h-full w-full min-h-0 flex-col bg-canvas"
      data-testid={`terminal-tile-${props.tileId}`}
    >
      {/* `relative` is the anchor for the absolutely-positioned xterm host;
          combined with `flex-1 min-h-0` it gets a definite box from the
          flex column ancestor without forcing children to chase a fragile
          percentage-height chain. */}
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<TerminalLoadingSkeleton />}>
          <TerminalXtermHost
            sessionId={handle.sessionId}
            tileKind="terminal"
            instanceId={props.instanceId}
            effectiveCols={effectiveCols}
            effectiveRows={effectiveRows}
            onUserInput={handleUserInput}
            onContainerResize={handleContainerResize}
            onWriterReady={handleWriterReady}
            shouldFocusOnActivePane={props.isActive}
            findTargetId={
              props.isActive
                ? `terminal:${props.viewTabId}:${props.tileId}:${handle.sessionId}`
                : null
            }
            // Plain terminals have no scrollback to preserve beyond the host
            // snapshot: their session handle is disposed on unmount and the next
            // open replays a fresh snapshot, so the xterm engine is rebuilt too.
            keepAlive={false}
          />
        </Suspense>
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
