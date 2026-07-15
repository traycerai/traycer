import { useStore } from "zustand";
import { Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import { useOpenEpicId } from "@/lib/epic-selectors";
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
import {
  isTerminalCrashExit,
  useTerminalCrashNotification,
} from "@/hooks/terminal/use-terminal-crash-notification";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  TerminalDataWriter,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import { TerminalLoadingSkeleton } from "./terminal-loading-skeleton";
import { TerminalDeadTileBanner } from "./dead-tile-banner";
import { TerminalConnectionOverlay } from "./terminal-connection-overlay";
import { resolveTerminalOverlayState } from "./terminal-connection-overlay-state";
import { Button } from "@/components/ui/button";
import {
  emitTerminalClosedNotification,
  emitTerminalCrashedNotification,
} from "@/stores/notifications/app-local-notifications-store";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";

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
  const crashReportedRef = useRef(false);
  const reportCrashExit = useCallback(() => {
    if (epicId === null) return;
    if (crashReportedRef.current) return;
    crashReportedRef.current = true;
    emitTerminalCrashedNotification({
      instanceId: props.node.instanceId,
      epicId,
      chatId: props.node.id,
      cause: "exit",
    });
  }, [epicId, props.node.id, props.node.instanceId]);
  const reportRecoveryExhausted = useCallback(() => {
    // Whichever path observes this terminal death first owns its notification.
    if (crashReportedRef.current) return;
    if (epicId === null) return;
    crashReportedRef.current = true;
    emitTerminalCrashedNotification({
      instanceId: props.node.instanceId,
      epicId,
      chatId: props.node.id,
      cause: "recovery-exhausted",
    });
  }, [epicId, props.node.id, props.node.instanceId]);
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
    Analytics.getInstance().track(AnalyticsEvent.TerminalOpened, {
      kind: "shell",
    });
  }, [sessionId]);
  useEffect(() => {
    if (reachability.status !== "unreachable") return;
    if (epicId === null) return;
    emitTerminalClosedNotification({
      instanceId: props.node.instanceId,
      hostLabel: reachability.hostLabel,
      epicId,
      chatId: props.node.id,
    });
  }, [
    reachability.status,
    reachability.hostLabel,
    epicId,
    props.node.id,
    props.node.instanceId,
  ]);
  if (reachability.status === "unreachable") {
    return (
      <TerminalDeadTileBanner
        hostLabel={reachability.hostLabel}
        onClose={closeCanvasTile}
        testId={`terminal-tile-${props.tileId}`}
      />
    );
  }
  // "host-starting" = the directory is empty because the local host hasn't
  // published yet (boot/ensure/wake). Rendering the dead banner there showed
  // "permanently closed" for terminals that were seconds from reconnecting.
  if (
    reachability.status === "checking" ||
    reachability.status === "host-starting"
  ) {
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
      onCrashExit={reportCrashExit}
      {...props}
    />
  );
}

function TerminalTileLive(
  props: TerminalTileProps & {
    readonly recovery: TerminalSessionRecovery;
    readonly onCrashExit: () => void;
  },
) {
  const hostId = useTabHostId();
  const epicId = useOpenEpicId();
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
    scope: { kind: "epic", epicId },
    sessionId,
    instanceId,
    sessionKind: "terminal",
    preparePayload,
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
  const exitedBeforeAttach =
    bootstrap.hostSessionExited && bootstrap.handle === null;
  useEffect(() => {
    if (!exitedBeforeAttach) return;
    closeExitedTile();
  }, [exitedBeforeAttach, closeExitedTile]);

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
      onCrashExit={props.onCrashExit}
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
  readonly onCrashExit: () => void;
}

function TerminalLive(props: TerminalLiveProps) {
  const { handle } = props;
  const status = useStore(handle.store, (s) => s.status);
  const exitCode = useStore(handle.store, (s) => s.exitCode);
  const exitReason = useStore(handle.store, (s) => s.exitReason);
  const connectionStatus = useStore(handle.store, (s) => s.connectionStatus);
  const effectiveCols = useStore(handle.store, (s) => s.effectiveCols);
  const effectiveRows = useStore(handle.store, (s) => s.effectiveRows);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    props.instanceId,
  );
  useTerminalCrashNotification({
    handle,
    isExitSuppressed: terminalExitIsNeverSuppressed,
    onCrashExit: props.onCrashExit,
  });

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

  // A crash remains visible in its tile so its unread failure indicator has a
  // tab to attach to. Clean and lifecycle exits retain the existing close
  // behavior. Reuse the notification predicate so emit/close cannot drift.
  useEffect(() => {
    if (status !== "exited") return;
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
    closeCanvasTile();
  }, [status, exitCode, exitReason, closeCanvasTile]);

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
            chrome="padded"
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
