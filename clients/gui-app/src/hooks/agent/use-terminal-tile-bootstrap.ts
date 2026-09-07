/** Shared terminal/TUI bootstrap: lazy xterm host, list/create, bound-host session handle, retry. */
import { lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  markTerminalLoad,
  markXtermChunkLoad,
} from "@/lib/perf/terminal-load-perf";
import { useTerminalCreate } from "@/hooks/terminal/use-terminal-create-mutation";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTerminalSessionHandle } from "@/lib/registries/terminal-session-registry";
// Type-only for @xterm; importing it here does not pull the lazy `@xterm/*`
// chunk into the eager bundle.
import {
  adoptWarmSessionInstance,
  peekXtermHostGrid,
  peekXtermHostGridForSession,
} from "@/components/epic-canvas/renderers/xterm-host-registry";
import type {
  TerminalReattachMode,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import type { TuiHarnessId } from "@traycer/protocol/host/agent/shared";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { useTerminalThemeHint } from "@/lib/terminal-theme-hint";
// Last-resort opening grid when the measurement probe never reported (its chunk failed to load within the timeout, or the tile never mounted one) and no kept-alive engine exists to peek.
const TERMINAL_DEFAULT_COLS = 80;
const TERMINAL_DEFAULT_ROWS = 24;
/** The probe usually reports within one frame of the xterm chunk loading - far faster than the transport dial + prepare RPC it overlaps - so this ceiling only matters when the chunk load stalls or a caller never mounts a probe. */
export const MEASURE_GRID_TIMEOUT_MS = 2_000;

export const TerminalXtermHost = lazy(async () => {
  // Only the first terminal of a session downloads the ~150 KB `@xterm/*`
  // chunk; later tiles resolve from module cache. Time the fetch so that
  // one-off cost is visible and not blamed on per-tile mount work.
  const startedAt = performance.now();
  const module =
    await import("@/components/epic-canvas/renderers/terminal-tile-xterm");
  markXtermChunkLoad(performance.now() - startedAt);
  return module;
});

export type TerminalSessionKind = "terminal" | "terminal-agent";

export interface TerminalCreatePayload {
  readonly tuiHarnessId: TuiHarnessId | null;
  readonly cwd: string;
  readonly shellCommand: string | null;
  readonly shellArgs: readonly string[] | null;
  readonly worktreeBusyPaths: readonly string[];
}

export interface UseTerminalTileBootstrapInput {
  readonly hostId: string;
  /** Scope used for the list predicate and any terminal create request. */
  readonly scope: TerminalScope;
  readonly sessionId: string;
  /** Per-tab instance id. */
  readonly instanceId: string;
  readonly sessionKind: TerminalSessionKind;
  /** Return null to abort create (record not projected yet). */
  readonly preparePayload: () => Promise<TerminalCreatePayload | null>;
  /** "NOT YET", never "not ever" - it is expected to flip true.
   * For a tile that will never create, use {@link adoptOnly}: this flag also arms the measure-grid wait below, so a permanently-false `enabled` silently removes the bounded fallback that lets a tile attach when no probe ever reports. */
  readonly enabled?: boolean | undefined;
  /** Adopt-only: never create. Measure-grid wait still arms so subscribe has a grid. */
  readonly adoptOnly?: boolean | undefined;
  /** Optional reset hook for the upstream prepare step. */
  readonly resetPrepare?: (() => void) | undefined;
}

export interface TerminalTileBootstrapResult {
  readonly hostHasSession: boolean | null;
  /** A host-grace-window exit; callers must not treat it as a missing session. */
  readonly hostSessionExited: boolean;
  readonly handle: TerminalSessionStoreHandle | null;
  readonly createIsError: boolean;
  readonly createIsPending: boolean;
  readonly createRetryIsPending: boolean;
  readonly createIsSuccess: boolean;
  readonly createError: {
    readonly message?: string;
    readonly code?: string;
  } | null;
  readonly createRetryError: {
    readonly message?: string;
    readonly code?: string;
  } | null;
  readonly retry: () => void;
  /** Hold create/subscribe until the first measured grid (or MEASURE_GRID_TIMEOUT_MS). Later reports do not re-dispatch. */
  readonly reportMeasuredGrid: (cols: number, rows: number) => void;
}

export function useTerminalTileBootstrap(
  input: UseTerminalTileBootstrapInput,
): TerminalTileBootstrapResult {
  const hostEntry = useHostDirectoryEntry(input.hostId);
  const hostClient = useHostClientFor(hostEntry);
  const list = useTerminalList(input.scope, hostClient);
  const create = useTerminalCreate(hostClient);
  const [createRetryError, setCreateRetryError] = useState<{
    readonly message?: string;
    readonly code?: string;
  } | null>(null);

  // `!== false` / `=== true` rather than `??`: same defaults (absent means enabled, absent means not adopt-only) with no extra branch, and this hook sits right at the complexity ceiling.
  const enabled = input.enabled !== false;
  const adoptOnly = input.adoptOnly === true;
  const [measuredGrid, setMeasuredGrid] = useState<{
    readonly cols: number;
    readonly rows: number;
  } | null>(null);
  const [measureTimedOut, setMeasureTimedOut] = useState(false);
  const reportMeasuredGrid = useCallback((cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0) return;
    setMeasuredGrid({ cols, rows });
  }, []);
  // The bounded wait only ARMS while the bootstrap may actually proceed.
  useEffect(() => {
    if (!enabled) return;
    if (measuredGrid !== null) return;
    if (measureTimedOut) return;
    const timer = window.setTimeout(() => {
      setMeasureTimedOut(true);
    }, MEASURE_GRID_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, measuredGrid, measureTimedOut]);
  const gridReady = measuredGrid !== null || measureTimedOut;

  // The session HANDLE gate below derives from this, NOT from `hostHasSession`: `hostHasSession` degrades to `null` while `terminal.list` is in flight, and gating the handle on that tore down the live PTY stream on every list invalidation - a subscribe whose snapshot changed store metadata touching the list cache then re-subscribed, re-snapshotted, and invalidated again, bouncing the subscription forever and leaving reattached terminals blank.
  const sessionListedRunning =
    list.data !== undefined &&
    list.data.sessions.some(
      (s) =>
        s.sessionId === input.sessionId &&
        s.sessionKind === input.sessionKind &&
        s.status === "running",
    );

  const hostHasSession =
    list.data === undefined || list.isFetching ? null : sessionListedRunning;

  // Plain terminal with status exited must close, never recreate the same id. TUI agents may recreate their stable agent id.
  const hostSessionExited =
    input.sessionKind === "terminal" &&
    list.data !== undefined &&
    !list.isFetching &&
    list.data.sessions.some(
      (s) =>
        s.sessionId === input.sessionId &&
        s.sessionKind === input.sessionKind &&
        s.status === "exited",
    );

  // Subdivide the bootstrap leg (the dominant first-paint cost): when `terminal.list` resolves the host-has-session predicate, and when `terminal.create` succeeds.
  const sessionId = input.sessionId;
  const createIsSuccess = create.isSuccess;
  useEffect(() => {
    if (hostHasSession === null) return;
    markTerminalLoad(sessionId, "list-ready");
  }, [hostHasSession, sessionId]);
  useEffect(() => {
    if (!createIsSuccess) return;
    markTerminalLoad(sessionId, "create-done");
  }, [createIsSuccess, sessionId]);

  // Read through a ref: the create effect wants the CURRENT theme at dispatch time, but a theme toggle must not re-fire a one-shot create effect (the hint is spawn-time-only anyway - a TUI probes once).
  const themeHint = useTerminalThemeHint();
  const themeHintRef = useRef(themeHint);
  useEffect(() => {
    themeHintRef.current = themeHint;
  }, [themeHint]);

  // The mutate ref lets the create-effect dispatch through the latest
  // mutation without re-firing on every tanstack render.
  const createMutateRef = useRef(create.mutate);
  useEffect(() => {
    createMutateRef.current = create.mutate;
  }, [create.mutate]);

  // A ref latch - not the effect's cleanup - guards against double-fire.
  const hasDispatchedRef = useRef(false);
  const createIsIdle = create.isIdle;
  const preparePayload = input.preparePayload;
  useEffect(() => {
    if (hostClient === null) return;
    if (hostHasSession === true) return; // session already live
    if (hostSessionExited) return; // PTY exited - close, do not respawn
    if (!enabled) return;
    if (adoptOnly) return; // the session is someone else's to create
    if (hostHasSession === null) return; // list still loading
    // Measure-before-subscribe: hold the create until the probe reported the container's natural grid (or the bounded wait expired), so the PTY spawns at the real size instead of a placeholder it must be resized away from.
    if (!gridReady) return;
    if (!createIsIdle) return; // already mutating / done / errored
    if (hasDispatchedRef.current) return;
    hasDispatchedRef.current = true;
    void preparePayload()
      .then((payload) => {
        if (payload === null) {
          // Caller deferred (e.g., agent record not yet projected);
          // unlatch so a subsequent render can try again.
          hasDispatchedRef.current = false;
          return;
        }
        // Payload resolved: for TUI tiles this is the end of the
        // `prepareLaunch` RPC; for plain terminals it is effectively instant.
        markTerminalLoad(input.sessionId, "prepare-done");
        // Grid preference order: the probe's measurement of the final layout box (the by-construction correct value); else a revive-in-place (idle reap, binding restart) can peek this tab's kept-alive engine or - after a tab close+reopen minted a new instance id - any cached engine of the same session; else the last-resort defaults.
        const openingGrid =
          measuredGrid ??
          peekXtermHostGrid(input.instanceId) ??
          peekXtermHostGridForSession({
            hostId: input.hostId,
            sessionId: input.sessionId,
          });
        createMutateRef.current(
          {
            scope: input.scope,
            sessionKind: input.sessionKind,
            tuiHarnessId: payload.tuiHarnessId,
            desiredSessionId: input.sessionId,
            cols:
              openingGrid !== null ? openingGrid.cols : TERMINAL_DEFAULT_COLS,
            rows:
              openingGrid !== null ? openingGrid.rows : TERMINAL_DEFAULT_ROWS,
            cwd: payload.cwd,
            shellCommand: payload.shellCommand,
            shellArgs:
              payload.shellArgs === null ? null : [...payload.shellArgs],
            worktreeBusyPaths: [...payload.worktreeBusyPaths],
            themeHint: themeHintRef.current,
          },
          { onSettled: () => setCreateRetryError(null) },
        );
      })
      .catch(() => {
        // The upstream prepare hook surfaces the error via its own state;
        // keep the latch closed so we do not retry without `retry()`.
        setCreateRetryError(null);
      });
  }, [
    enabled,
    adoptOnly,
    hostHasSession,
    hostSessionExited,
    hostClient,
    createIsIdle,
    gridReady,
    measuredGrid,
    input.scope,
    input.hostId,
    input.sessionId,
    input.instanceId,
    input.sessionKind,
    preparePayload,
  ]);

  // Immune to background refetches by design (see `sessionListedRunning`):
  // a live handle is only released when a SETTLED list shows the session
  // gone or exited, never because a refetch is merely in flight.
  const reattachMode: TerminalReattachMode = sessionListedRunning
    ? "live"
    : "fresh";
  const sessionReady = sessionListedRunning || create.isSuccess;

  // Adopt the warm handle (and kept-alive engine) a closed tab of this session left behind, BEFORE the session-handle acquire below runs - effects fire in declaration order, so this one precedes the acquire effect inside `useTerminalSessionHandle` on the mount commit.
  const adoptSessionId = input.sessionId;
  const adoptInstanceId = input.instanceId;
  useEffect(() => {
    adoptWarmSessionInstance(
      { hostId: input.hostId, sessionId: adoptSessionId },
      adoptInstanceId,
    );
  }, [adoptInstanceId, adoptSessionId, input.hostId]);

  // Grid preference mirrors the create effect's: probe measurement first, then engine peeks (render-time reads - the handle hook consumes these only at store creation via a ref, so they are exactly as fresh as the acquire that follows), then the defaults.
  const openingGrid =
    measuredGrid ??
    peekXtermHostGrid(input.instanceId) ??
    peekXtermHostGridForSession({
      hostId: input.hostId,
      sessionId: input.sessionId,
    });
  const handle = useTerminalSessionHandle({
    hostId: input.hostId,
    scope: input.scope,
    sessionId: input.sessionId,
    instanceId: input.instanceId,
    cols: openingGrid !== null ? openingGrid.cols : TERMINAL_DEFAULT_COLS,
    rows: openingGrid !== null ? openingGrid.rows : TERMINAL_DEFAULT_ROWS,
    reattachMode,
    kind: input.sessionKind,
    enabled: sessionReady && gridReady,
  });

  // The session store handle resolving marks the end of the bootstrap leg:
  // host reachable, `terminal.create` settled, store acquired + stream
  // opened. Everything after this is xterm mount + first paint.
  useEffect(() => {
    if (handle === null) return;
    markTerminalLoad(sessionId, "session-handle");
  }, [handle, sessionId]);

  const resetPrepare = input.resetPrepare;
  const retrySessionId = input.sessionId;
  const retrySessionKind = input.sessionKind;
  const retry = useCallback(() => {
    hasDispatchedRef.current = false;
    setCreateRetryError(create.error);
    create.reset();
    if (resetPrepare !== undefined) resetPrepare();
    void list.refetch().then((result) => {
      if (
        result.data?.sessions.some(
          (session) =>
            session.sessionId === retrySessionId &&
            session.sessionKind === retrySessionKind &&
            session.status === "running",
        ) === true
      ) {
        setCreateRetryError(null);
      }
    });
  }, [create, list, resetPrepare, retrySessionId, retrySessionKind]);

  return {
    hostHasSession,
    hostSessionExited,
    handle,
    createIsError: create.isError,
    createIsPending: create.isPending,
    createRetryIsPending: createRetryError !== null,
    createIsSuccess: create.isSuccess,
    createError: create.error,
    createRetryError,
    retry,
    reportMeasuredGrid,
  };
}
