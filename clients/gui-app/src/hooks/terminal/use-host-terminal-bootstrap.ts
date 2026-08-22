import { useCallback, useEffect, useRef, useState } from "react";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { EnsurePlainTerminalRunningResponse } from "@traycer/protocol/host/terminal/plain-schemas";
import { useTerminalSessionHandle } from "@/lib/registries/terminal-session-registry";
import type { TerminalSessionStoreHandle } from "@/stores/terminals/terminal-session-store";
import {
  adoptWarmSessionInstance,
  peekXtermHostGrid,
  peekXtermHostGridForSession,
} from "@/components/epic-canvas/renderers/xterm-host-registry";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MEASURE_TIMEOUT_MS = 2_000;

export interface HostTerminalBootstrapResult {
  readonly handle: TerminalSessionStoreHandle | null;
  readonly ensureIsError: boolean;
  readonly ensureError: Error | null;
  readonly retry: () => void;
  readonly reportMeasuredGrid: (cols: number, rows: number) => void;
}

export interface EnsureRunningMutation {
  readonly isIdle: boolean;
  readonly isError: boolean;
  readonly error: Error | null;
  readonly data: EnsurePlainTerminalRunningResponse | undefined;
  readonly mutate: (request: {
    readonly hostId: string;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  }) => void;
  readonly reset: () => void;
}

/** Lazily revives a known durable id; this hook has no create path. */
export function useHostTerminalBootstrap(args: {
  readonly hostId: string;
  readonly epicId: string;
  readonly terminalId: string;
  readonly instanceId: string;
  readonly projection: PlainTerminalProjection;
  readonly canMutate: boolean;
  readonly ensureRunning: EnsureRunningMutation;
}): HostTerminalBootstrapResult {
  const [measuredGrid, setMeasuredGrid] = useState<{
    readonly cols: number;
    readonly rows: number;
  } | null>(null);
  const [measureTimedOut, setMeasureTimedOut] = useState(false);
  const dispatchedRevisionRef = useRef<number | null>(null);
  const reportMeasuredGrid = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    setMeasuredGrid({ cols, rows });
  }, []);

  useEffect(() => {
    if (measuredGrid !== null || measureTimedOut) return;
    const timer = window.setTimeout(
      () => setMeasureTimedOut(true),
      MEASURE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [measureTimedOut, measuredGrid]);
  const gridReady = measuredGrid !== null || measureTimedOut;

  useEffect(() => {
    if (args.projection.runtime.status === "running") {
      dispatchedRevisionRef.current = null;
      return;
    }
    if (!args.canMutate || !gridReady || !args.ensureRunning.isIdle) return;
    if (dispatchedRevisionRef.current === args.projection.record.revision)
      return;
    const grid = measuredGrid ??
      peekXtermHostGrid(args.instanceId) ??
      peekXtermHostGridForSession({
        hostId: args.hostId,
        sessionId: args.terminalId,
      }) ?? {
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      };
    dispatchedRevisionRef.current = args.projection.record.revision;
    args.ensureRunning.mutate({
      hostId: args.hostId,
      terminalId: args.terminalId,
      cols: grid.cols,
      rows: grid.rows,
    });
  }, [
    args.canMutate,
    args.ensureRunning,
    args.hostId,
    args.instanceId,
    args.projection,
    args.terminalId,
    gridReady,
    measuredGrid,
  ]);

  useEffect(() => {
    adoptWarmSessionInstance(
      { hostId: args.hostId, sessionId: args.terminalId },
      args.instanceId,
    );
  }, [args.hostId, args.instanceId, args.terminalId]);

  const openingGrid = measuredGrid ??
    peekXtermHostGrid(args.instanceId) ??
    peekXtermHostGridForSession({
      hostId: args.hostId,
      sessionId: args.terminalId,
    }) ?? {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
  const projectionRunning = args.projection.runtime.status === "running";
  const ensuredRunning =
    args.ensureRunning.data?.terminal.runtime.status === "running";
  const handle = useTerminalSessionHandle({
    hostId: args.hostId,
    scope: { kind: "epic", epicId: args.epicId },
    sessionId: args.terminalId,
    instanceId: args.instanceId,
    cols: openingGrid.cols,
    rows: openingGrid.rows,
    reattachMode: projectionRunning ? "live" : "fresh",
    kind: "terminal",
    enabled:
      args.canMutate && gridReady && (projectionRunning || ensuredRunning),
  });

  const retry = useCallback(() => {
    dispatchedRevisionRef.current = null;
    args.ensureRunning.reset();
  }, [args.ensureRunning]);

  return {
    handle,
    ensureIsError: args.ensureRunning.isError,
    ensureError: args.ensureRunning.error,
    retry,
    reportMeasuredGrid,
  };
}
