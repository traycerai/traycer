/**
 * Shared bootstrap for `TerminalTile` and `TuiAgentTile`. Owns:
 *
 *   - the lazy-loaded `TerminalXtermHost` (so the ~150 KB `@xterm/*`
 *     bundle is fetched once, not once per tile renderer),
 *   - the default cols/rows the tiles open with,
 *   - the `terminal.list` host-has-session predicate,
 *   - the `terminal.create` effect (gated on the per-tile
 *     `preparePayload` builder so the agent tile can route through
 *     `agent.tui.prepareLaunch` first),
 *   - the `useTerminalSessionHandle` resolution against the
 *     bound-host session,
 *   - a `retry` that resets both create and list (and the upstream
 *     prepare hook, when supplied).
 *
 * Tile bodies stay in their own files for the chrome that is
 * genuinely tile-specific (binding chip, exit-code toast, agent-record
 * loading state, error-classification copy).
 */
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
// Last-resort opening grid when the measurement probe never reported (its
// chunk failed to load within the timeout, or the tile never mounted one) and
// no kept-alive engine exists to peek. Everything downstream can still heal
// from these via the engine's re-report machinery - they are the floor, not
// the expected path.
const TERMINAL_DEFAULT_COLS = 80;
const TERMINAL_DEFAULT_ROWS = 24;
/**
 * Upper bound on how long the bootstrap holds `terminal.create` /
 * `terminal.subscribe` waiting for the measurement probe's first report
 * (measure-before-subscribe). The probe usually reports within one frame of
 * the xterm chunk loading - far faster than the transport dial + prepare RPC
 * it overlaps - so this ceiling only matters when the chunk load stalls or a
 * caller never mounts a probe. On expiry the bootstrap proceeds with the
 * best grid it can peek, which is the pre-measurement behavior.
 */
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
  /**
   * Per-tab instance id. The session handle is registered under this so two
   * tab instances of the same `sessionId` each get their own stream client.
   */
  readonly instanceId: string;
  readonly sessionKind: TerminalSessionKind;
  /**
   * Builds the per-create payload right before `terminal.create` is
   * dispatched. Plain terminals return a static payload; tui-agent
   * tiles use the callback to dispatch `agent.tui.prepareLaunch` first
   * and forward the prepared shell command + worktree-busy paths.
   *
   * Returning `null` aborts the create (e.g., when the agent record
   * has not projected yet). Errors propagate out of the effect; the
   * upstream prepare hook reports them via its own state.
   */
  readonly preparePayload: () => Promise<TerminalCreatePayload | null>;
  /**
   * Gate the create effect (defaults to true). Tui-agent tiles set
   * this to false until the agent record is in projection.
   */
  readonly enabled?: boolean | undefined;
  /**
   * Optional reset hook for the upstream prepare step. `retry` calls
   * it before re-dispatching create.
   */
  readonly resetPrepare?: (() => void) | undefined;
}

export interface TerminalTileBootstrapResult {
  readonly hostHasSession: boolean | null;
  /** A host-grace-window exit; callers must not treat it as a missing session. */
  readonly hostSessionExited: boolean;
  readonly handle: TerminalSessionStoreHandle | null;
  readonly createIsError: boolean;
  readonly createIsSuccess: boolean;
  readonly createError: {
    readonly message?: string;
    readonly code?: string;
  } | null;
  readonly retry: () => void;
  /**
   * Measure-before-subscribe: the tile's measurement probe (the persistent
   * xterm engine mounted into the final layout box while the tile shows its
   * loading state) reports the container's natural grid here. The bootstrap
   * holds `terminal.create` / `terminal.subscribe` until the first report
   * (bounded by {@link MEASURE_GRID_TIMEOUT_MS}), so the PTY spawns - and
   * the reattach snapshot is serialized - at the real grid by construction
   * instead of the 80x24 defaults. Later reports refresh the pending value
   * (pane resized mid-bootstrap) but never re-dispatch.
   */
  readonly reportMeasuredGrid: (cols: number, rows: number) => void;
}

export function useTerminalTileBootstrap(
  input: UseTerminalTileBootstrapInput,
): TerminalTileBootstrapResult {
  const hostEntry = useHostDirectoryEntry(input.hostId);
  const hostClient = useHostClientFor(hostEntry);
  const list = useTerminalList(input.scope, hostClient);
  const create = useTerminalCreate(hostClient);

  // Measure-before-subscribe state. `measuredGrid` holds the probe's latest
  // report (last write wins - the freshest measurement should seed the
  // subscribe); `measureTimedOut` unblocks the bootstrap when no probe ever
  // reports. `gridReady` is the gate the create effect and the session-handle
  // enable both honor.
  const enabled = input.enabled ?? true;
  const [measuredGrid, setMeasuredGrid] = useState<{
    readonly cols: number;
    readonly rows: number;
  } | null>(null);
  const [measureTimedOut, setMeasureTimedOut] = useState(false);
  const reportMeasuredGrid = useCallback((cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0) return;
    setMeasuredGrid({ cols, rows });
  }, []);
  // The bounded wait only ARMS while the bootstrap may actually proceed. A
  // TUI tile disables the bootstrap until its agent record projects and the
  // tile renders no probe in that state, so a timer running from mount would
  // expire during a slow projection and let the create dispatch at the
  // fallback grid before the freshly-mounted probe ever reports - exactly
  // the wrong-sized spawn this machinery exists to prevent. An expiry that
  // DID fire (while enabled) latches: the agent tile's `enabled` goes false
  // again once the prepare mutation leaves idle, and un-readying the grid at
  // that point would strand the timeout-fallback flow mid-bootstrap.
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

  // The last SETTLED list's verdict on the session, kept stable across
  // background refetches (TanStack keeps previous `data` while refetching).
  // The session HANDLE gate below derives from this, NOT from
  // `hostHasSession`: `hostHasSession` degrades to `null` while
  // `terminal.list` is in flight, and gating the handle on that tore down the
  // live PTY stream on every list invalidation - a subscribe whose snapshot
  // changed store metadata touching the list cache then re-subscribed,
  // re-snapshotted, and invalidated again, bouncing the subscription forever
  // and leaving reattached terminals blank.
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

  // The host still reports a session it has seen EXIT for ~60s (its
  // grace window) with `status: "exited"`. For a plain terminal that is
  // categorically different from a session that is simply absent: an
  // exited PTY means the user ended it (`exit`/Ctrl-D, or a sidebar
  // "Close" kill), so the tile must close - never silently respawn a fresh
  // PTY under the same id. The absent case stays eligible for create so the
  // documented eviction-recreate resilience (host restart) still holds.
  //
  // Scoped to `sessionKind === "terminal"` deliberately. Terminal-agents
  // key the PTY on the *stable* agent-record id, so a reopen within the
  // grace window legitimately re-creates the same id (the closed tab is
  // being restarted); gating them would strand that restart. Plain-terminal
  // ids are unique per open and an exited one can never be reopened (the
  // sidebar lists running sessions only), so there is no such collision.
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

  // Subdivide the bootstrap leg (the dominant first-paint cost): when
  // `terminal.list` resolves the host-has-session predicate, and when
  // `terminal.create` succeeds. The `prepare-done` span between them is
  // marked from inside the create effect once `preparePayload` resolves
  // (instant for plain terminals; the `prepareLaunch` RPC for TUI tiles).
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

  // The mutate ref lets the create-effect dispatch through the latest
  // mutation without re-firing on every tanstack render.
  const createMutateRef = useRef(create.mutate);
  useEffect(() => {
    createMutateRef.current = create.mutate;
  }, [create.mutate]);

  // The dance (preparePayload -> terminal.create) is a one-shot per
  // tile mount. A ref latch - not the effect's cleanup - guards against
  // double-fire. The cleanup-cancellation we used previously dropped the
  // create call when `enabled` flipped false mid-prepare (it depends on
  // `prepareLaunch.isIdle`, which the prepare itself flips), leaving the
  // tile stuck on "Starting terminal session…".
  const hasDispatchedRef = useRef(false);
  const createIsIdle = create.isIdle;
  const preparePayload = input.preparePayload;
  useEffect(() => {
    if (hostClient === null) return;
    if (hostHasSession === true) return; // session already live
    if (hostSessionExited) return; // PTY exited - close, do not respawn
    if (!enabled) return;
    if (hostHasSession === null) return; // list still loading
    // Measure-before-subscribe: hold the create until the probe reported the
    // container's natural grid (or the bounded wait expired), so the PTY
    // spawns at the real size instead of a placeholder it must be resized
    // away from.
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
        // Grid preference order: the probe's measurement of the final layout
        // box (the by-construction correct value); else a revive-in-place
        // (idle reap, binding restart) can peek this tab's kept-alive engine
        // or - after a tab close+reopen minted a new instance id - any cached
        // engine of the same session; else the last-resort defaults.
        const openingGrid =
          measuredGrid ??
          peekXtermHostGrid(input.instanceId) ??
          peekXtermHostGridForSession(input.sessionId);
        createMutateRef.current({
          scope: input.scope,
          sessionKind: input.sessionKind,
          tuiHarnessId: payload.tuiHarnessId,
          desiredSessionId: input.sessionId,
          cols: openingGrid !== null ? openingGrid.cols : TERMINAL_DEFAULT_COLS,
          rows: openingGrid !== null ? openingGrid.rows : TERMINAL_DEFAULT_ROWS,
          cwd: payload.cwd,
          shellCommand: payload.shellCommand,
          shellArgs: payload.shellArgs === null ? null : [...payload.shellArgs],
          worktreeBusyPaths: [...payload.worktreeBusyPaths],
        });
      })
      .catch(() => {
        // The upstream prepare hook surfaces the error via its own state;
        // keep the latch closed so we do not retry without `retry()`.
      });
  }, [
    enabled,
    hostHasSession,
    hostSessionExited,
    hostClient,
    createIsIdle,
    gridReady,
    measuredGrid,
    input.scope,
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

  // Adopt the warm handle (and kept-alive engine) a closed tab of this
  // session left behind, BEFORE the session-handle acquire below runs -
  // effects fire in declaration order, so this one precedes the acquire
  // effect inside `useTerminalSessionHandle` on the mount commit.
  const adoptSessionId = input.sessionId;
  const adoptInstanceId = input.instanceId;
  useEffect(() => {
    adoptWarmSessionInstance(adoptSessionId, adoptInstanceId);
  }, [adoptSessionId, adoptInstanceId]);

  // Grid preference mirrors the create effect's: probe measurement first,
  // then engine peeks (render-time reads - the handle hook consumes these
  // only at store creation via a ref, so they are exactly as fresh as the
  // acquire that follows), then the defaults. The subscribe itself is held
  // behind `gridReady`, so a measured value is normally present here.
  const openingGrid =
    measuredGrid ??
    peekXtermHostGrid(input.instanceId) ??
    peekXtermHostGridForSession(input.sessionId);
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
  const retry = useCallback(() => {
    hasDispatchedRef.current = false;
    create.reset();
    if (resetPrepare !== undefined) resetPrepare();
    void list.refetch();
  }, [create, list, resetPrepare]);

  return {
    hostHasSession,
    hostSessionExited,
    handle,
    createIsError: create.isError,
    createIsSuccess: create.isSuccess,
    createError: create.error,
    retry,
    reportMeasuredGrid,
  };
}
