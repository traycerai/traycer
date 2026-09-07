import { create, type StoreApi, type UseBoundStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import {
  createGenerationGuard,
  guardHandler,
  type GenerationGuard,
} from "@traycer-clients/shared/replica-runtime";
import type {
  TerminalSubscribeClientFrame,
  TerminalSubscribeViewer,
} from "@traycer/protocol/host/terminal/subscribe";
import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
  TerminalSessionExitReason,
  TerminalSessionInfo,
  TerminalSessionKind,
  TerminalScope,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type {
  TerminalStreamCallbacks,
  TerminalStreamClient,
} from "@traycer-clients/shared/host-transport/terminal-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { markTerminalLoad } from "@/lib/perf/terminal-load-perf";

type TerminalStreamClientHandle = Pick<
  TerminalStreamClient,
  "sendAction" | "close"
>;

export interface TerminalStreamClientFactoryArgs {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly callbacks: TerminalStreamCallbacks;
  readonly viewer: TerminalSubscribeViewer;
}

export type TerminalStreamClientFactory = (
  args: TerminalStreamClientFactoryArgs,
) => TerminalStreamClientHandle;

export type TerminalReattachMode = "fresh" | "live";
/**
 * `"lost"` - the stream closed for an unknown/recoverable reason (transport drop, host restart,
 * etc.) - the session MAY still be alive server-side (within its detach-linger window, T13);
 */
export type TerminalLifecycleStatus =
  | "creating"
  | "running"
  | "exited"
  | "lost"
  | "reaped";

const MAX_PENDING_ACTIONS = 64;
// Cap the pre-writer queue so a misconfigured tile that never registers a writer can't grow the
// buffer unboundedly.
const MAX_PENDING_BYTES = 1024 * 1024;

// Ack-credit (terminal.subscribe@1.1) coalescing: acks are batched so a steady stream of parsed
// chunks doesn't send one `ack` frame per chunk.
const ACK_COALESCE_BYTES = 64 * 1024;
const ACK_COALESCE_MS = 50;

// A unit of terminal output handed to the xterm host.
export type TerminalWrite =
  | {
      readonly kind: "live";
      readonly chunk: string | Uint8Array;
      readonly onAckable: () => void;
    }
  | {
      readonly kind: "snapshot";
      readonly chunk: string | Uint8Array;
      readonly cols: number;
      readonly rows: number;
      readonly onAckable: () => void;
    };
export type TerminalDataWriter = (write: TerminalWrite) => void;

export interface PendingTerminalAction {
  readonly clientActionId: string;
  /**
   * Kept so a reconnect can replay it verbatim - the client's own bounded buffer is the only place
   * this data survives; the host's per-session idempotency window dedupes a replay that already
   */
  readonly frame: Extract<
    TerminalSubscribeClientFrame,
    { kind: "write" | "resize" }
  >;
}

export interface TerminalSessionState {
  readonly sessionId: string;
  readonly scope: TerminalScope;
  readonly connectionStatus: StreamConnectionStatus;
  readonly snapshotLoaded: boolean;
  readonly status: TerminalLifecycleStatus;
  readonly exitCode: number | null;
  /**
   * Why the PTY ended, from the host's exit frame / exited snapshot. `null` until exited, and for
   * hosts predating the field (treat as `process-exit`).
   */
  readonly exitReason: TerminalSessionExitReason | null;
  readonly effectiveCols: number;
  readonly effectiveRows: number;
  readonly requestedCols: number;
  readonly requestedRows: number;
  readonly reattachMode: TerminalReattachMode;
  /** Whether this session backs a plain terminal tab or a terminal-agent. */
  readonly kind: TerminalSessionKind;
  /** `terminal.subscribe@1.6` attachment intent currently on the wire. */
  readonly viewer: TerminalSubscribeViewer;
  readonly pendingActions: Readonly<Record<string, PendingTerminalAction>>;
  readonly lastOutputPreview: string | null;
  /**
   * Wall-clock time (`Date.now()`) the pending-action ring last evicted an unacked action to make
   * room (T13's honest overflow signal - see {@link AppendPendingActionResult}).
   */
  readonly lastInputLostAt: number | null;
  readonly title: string | null;
  readonly activeProcessName: string | null;
  readonly currentCwd: string | null;
  /** Whether a negotiated stream frame has explicitly carried `currentCwd`. */
  readonly currentCwdReported: boolean;

  /** Tile registers an xterm `term.write` proxy here once mounted. */
  setWriter: (writer: TerminalDataWriter | null) => void;
  /** Send keystrokes (or pasted text) to the host. */
  writeInput: (data: string) => string | null;
  /** Ask the host to resize; the host may pick a smaller min(cols/rows). */
  requestResize: (cols: number, rows: number) => string | null;
  /**
   * Retag attachment intent. A change reopens `terminal.subscribe` (open frame only; there is no
   * restate client frame).
   */
  setViewer: (viewer: TerminalSubscribeViewer) => void;
  /** Rebuilds the owned transport while preserving this retained PTY handle. */
  retryTransport: () => void;
  /** Closes the underlying stream client (does NOT call `terminal.kill`). */
  dispose: () => void;
}

export interface TerminalSessionStoreOptions {
  readonly scope: TerminalScope;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly reattachMode: TerminalReattachMode;
  readonly kind: TerminalSessionKind;
  readonly streamClientFactory: TerminalStreamClientFactory;
}

export interface TerminalSessionStoreHandle {
  readonly scope: TerminalScope;
  readonly sessionId: string;
  readonly store: UseBoundStore<StoreApi<TerminalSessionState>>;
  readonly dispose: () => void;
}

interface AppendPendingActionResult {
  readonly pendingActions: Readonly<Record<string, PendingTerminalAction>>;
  readonly evicted: boolean;
}

function appendPendingAction(
  pendingActions: Readonly<Record<string, PendingTerminalAction>>,
  next: PendingTerminalAction,
): AppendPendingActionResult {
  // Cap the ring with FIFO eviction so a never-acked action can't leak.
  const keys = Object.keys(pendingActions);
  if (keys.length < MAX_PENDING_ACTIONS) {
    return {
      pendingActions: { ...pendingActions, [next.clientActionId]: next },
      evicted: false,
    };
  }
  const trimmed = Object.fromEntries(
    keys
      .slice(keys.length - MAX_PENDING_ACTIONS + 1)
      .map((key): [string, PendingTerminalAction] => [
        key,
        pendingActions[key],
      ]),
  );
  trimmed[next.clientActionId] = next;
  return { pendingActions: trimmed, evicted: true };
}

function removePendingAction(
  pendingActions: Readonly<Record<string, PendingTerminalAction>>,
  clientActionId: string,
): Readonly<Record<string, PendingTerminalAction>> {
  if (!Object.prototype.hasOwnProperty.call(pendingActions, clientActionId)) {
    return pendingActions;
  }
  const next: Record<string, PendingTerminalAction> = { ...pendingActions };
  delete next[clientActionId];
  return next;
}

/**
 * `TERMINAL_NOT_FOUND` (see `terminal-stream-resolver.ts`'s subscribe-time catch) authoritatively
 * confirms that this handle's PTY incarnation no longer exists.
 */
function isDefinitiveHandleLoss(reason: StreamCloseReason | null): boolean {
  return (
    reason !== null &&
    reason.kind === "fatalError" &&
    reason.details.code === "TERMINAL_NOT_FOUND"
  );
}

function nextLifecycleStatusAfterConnectionStatus(
  status: StreamConnectionStatus,
  current: TerminalLifecycleStatus,
  reason: StreamCloseReason | null,
): TerminalLifecycleStatus {
  if (status !== "closed" || current === "exited") {
    return current;
  }
  if (isDefinitiveHandleLoss(reason)) {
    return "reaped";
  }
  return "lost";
}

/** No PTY to address: the session has exited, or the tile has already dead-ended on `"lost"`/`"reaped"`. */
function isTerminalOrDead(status: TerminalLifecycleStatus): boolean {
  return status === "exited" || status === "lost" || status === "reaped";
}

const textDecoder = new TextDecoder();

// The ANSI-stripping regex below only operates on strings.
function contentToText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : textDecoder.decode(content);
}

// Ack-credit byte-counting convention (see `accountAckableBytes`): a `1.1` text connection counts
// JS string length (UTF-16 code units) since that's what it received and reports back; a `1.2`+
function contentAccountLength(content: string | Uint8Array): number {
  return typeof content === "string" ? content.length : content.byteLength;
}

// Bounds preview-extraction cost on a large coalesced binary frame (up to ~2 MB under a `@1.2`
// firehose): the preview only ever needs the trailing non-empty line, so decoding/scanning more
const PREVIEW_SOURCE_TAIL_BYTES = 8 * 1024;

function previewTail(content: string | Uint8Array): string | Uint8Array {
  return content.length > PREVIEW_SOURCE_TAIL_BYTES
    ? content.slice(-PREVIEW_SOURCE_TAIL_BYTES)
    : content;
}

function terminalOutputPreview(content: string | Uint8Array): string | null {
  const preview = contentToText(previewTail(content))
    // eslint-disable-next-line no-control-regex -- intentional ANSI escape stripping
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex -- intentional ANSI escape stripping
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (preview === undefined) return null;
  return preview.slice(0, 240);
}

function activeProcessNameFromSession(
  session:
    | Pick<CanonicalTerminalSessionInfo, "activeProcessName">
    | Pick<TerminalSessionInfo, "activeProcessName">,
): string | null {
  const name = session.activeProcessName;
  if (name === undefined || name === null) return null;
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function currentCwdFromSession(
  session:
    | CanonicalTerminalSessionInfoWithCurrentCwd
    | CanonicalTerminalSessionInfo
    | TerminalSessionInfo,
): string | null | undefined {
  if (!("currentCwd" in session)) return undefined;
  return session.currentCwd.length === 0 ? null : session.currentCwd;
}

/** Every frame this store accepts, made inert once `generation` is retired. */
function bindStreamCallbacks(
  callbacks: TerminalStreamCallbacks,
  guard: GenerationGuard,
  generation: number,
): TerminalStreamCallbacks {
  const guarded = <TArgs extends unknown[]>(
    handler: (...args: TArgs) => void,
  ): ((...args: TArgs) => void) => guardHandler(guard, generation, handler);
  return {
    onSnapshot: guarded(callbacks.onSnapshot),
    onData: guarded(callbacks.onData),
    onResized: guarded(callbacks.onResized),
    onExit: guarded(callbacks.onExit),
    onActionAck: guarded(callbacks.onActionAck),
    onSessionUpdated: guarded(callbacks.onSessionUpdated),
    onConnectionStatus: guarded(callbacks.onConnectionStatus),
  };
}

export function createTerminalSessionStore(
  options: TerminalSessionStoreOptions,
): TerminalSessionStoreHandle {
  let disposed = false;
  let writer: TerminalDataWriter | null = null;
  let streamClient: TerminalStreamClientHandle | null = null;
  let viewer: TerminalSubscribeViewer = "presentation";
  // Bumped before tearing down a subscriber so its close-driven status
  // callback cannot map a deliberate viewer-intent reopen to "lost".
  const streamGuard = createGenerationGuard();
  // After a viewer-intent reopen of an already-open session, ignore the replacement stream's
  // connecting/reconnecting statuses so the tile does not flash a reconnect overlay (keep-warm
  let ignoreTransientStatus = false;
  // Buffers host output that arrives before the tile has finished mounting its xterm host and
  // registered a writer.
  const pendingWrites: TerminalWrite[] = [];
  let pendingBytes = 0;
  const enqueuePending = (write: TerminalWrite): void => {
    // Live zero-length writes carry no bytes.
    if (write.chunk.length === 0 && write.kind !== "snapshot") return;
    pendingWrites.push(write);
    pendingBytes += write.chunk.length;
    while (pendingBytes > MAX_PENDING_BYTES && pendingWrites.length > 1) {
      const dropped = pendingWrites.shift();
      if (dropped !== undefined) {
        pendingBytes -= dropped.chunk.length;
        // Dropped before ever reaching xterm - it will never fire its own parse-completion callback, so
        // credit it back to the host right here.
        dropped.onAckable();
      }
    }
  };
  const flushPending = (target: TerminalDataWriter): void => {
    if (pendingWrites.length === 0) return;
    const writes = pendingWrites.splice(0, pendingWrites.length);
    pendingBytes = 0;
    for (const write of writes) {
      target(write);
    }
  };

  const closeStreamClient = (): void => {
    if (streamClient === null) return;
    const client = streamClient;
    streamClient = null;
    client.close();
  };

  // Ack-credit accounting: bytes accounted (parsed by xterm, or dropped before ever reaching it)
  // since the last `ack` frame was sent, and the coalescing timer for the current batch.
  let unackedLocalBytes = 0;
  let ackFlushTimer: number | null = null;
  // Bumped on every disconnect so `onAckable` callbacks captured by writes handed to xterm before
  // the drop become no-ops if xterm's write callback fires late (after a reconnect has already
  let ackGeneration = 0;
  // Capability sentinel: the renderer has no direct way to read the minor negotiated for this
  // stream, so it waits for the host to confirm ack-credit support on a snapshot frame (same pattern
  let ackCreditSupported = false;
  const clearAckFlushTimer = (): void => {
    if (ackFlushTimer === null) return;
    window.clearTimeout(ackFlushTimer);
    ackFlushTimer = null;
  };
  const resetAckAccounting = (): void => {
    clearAckFlushTimer();
    unackedLocalBytes = 0;
    ackGeneration += 1;
    ackCreditSupported = false;
  };

  const store = create<TerminalSessionState>()((set, get) => {
    const dispatchClientFrame = (frame: TerminalSubscribeClientFrame): void => {
      const client = streamClient;
      if (client === null) return;
      if (get().connectionStatus !== "open") {
        return;
      }
      client.sendAction(frame);
    };

    const flushAck = (): void => {
      clearAckFlushTimer();
      if (unackedLocalBytes === 0) return;
      const bytes = unackedLocalBytes;
      unackedLocalBytes = 0;
      dispatchClientFrame({
        kind: "ack",
        hasBinaryPayload: false,
        sessionId: options.sessionId,
        bytes,
      });
    };

    const accountAckableBytes = (
      generation: number,
      byteCount: number,
    ): void => {
      if (!ackCreditSupported) return;
      if (generation !== ackGeneration) return;
      if (byteCount <= 0) return;
      unackedLocalBytes += byteCount;
      if (unackedLocalBytes >= ACK_COALESCE_BYTES) {
        flushAck();
        return;
      }
      if (ackFlushTimer === null) {
        ackFlushTimer = window.setTimeout(() => {
          ackFlushTimer = null;
          flushAck();
        }, ACK_COALESCE_MS);
      }
    };

    const flushRequestedResize = (): void => {
      // Reconnect ordering is open -> snapshot.
      const state = get();
      if (isTerminalOrDead(state.status)) return;
      if (state.connectionStatus !== "open") return;
      if (
        state.requestedCols === state.effectiveCols &&
        state.requestedRows === state.effectiveRows
      ) {
        return;
      }
      const clientActionId = uuidv4();
      const frame: TerminalSubscribeClientFrame = {
        kind: "resize",
        hasBinaryPayload: false,
        sessionId: options.sessionId,
        clientActionId,
        cols: state.requestedCols,
        rows: state.requestedRows,
      };
      recordPendingAction({ clientActionId, frame });
      dispatchClientFrame(frame);
    };

    /**
     * Appends to the pending-action ring and, on eviction, stamps `lastInputLostAt` in the SAME
     * `set()` call (T13's honest overflow signal) so a tile watching either field never observes them
     */
    const recordPendingAction = (next: PendingTerminalAction): void => {
      set((current) => {
        const { pendingActions, evicted } = appendPendingAction(
          current.pendingActions,
          next,
        );
        return {
          pendingActions,
          lastInputLostAt: evicted ? Date.now() : current.lastInputLostAt,
        };
      });
    };

    /**
     * Replays every still-unacked `write` action after a reconnect (T13 terminal action protocol -
     * Architecture §3/§8's "in-flight keystrokes replay exactly-once-effect on reattach").
     */
    const replayPendingActionsAfterReconnect = (): void => {
      const pendingActions = get().pendingActions;
      const staleResizeIds = Object.values(pendingActions)
        .filter((pending) => pending.frame.kind === "resize")
        .map((pending) => pending.clientActionId);
      if (staleResizeIds.length > 0) {
        set((current) => ({
          pendingActions: staleResizeIds.reduce(
            (acc, id) => removePendingAction(acc, id),
            current.pendingActions,
          ),
        }));
      }
      for (const pending of Object.values(pendingActions)) {
        if (pending.frame.kind !== "write") continue;
        dispatchClientFrame(pending.frame);
      }
    };

    const callbacks: TerminalStreamCallbacks = {
      onSnapshot: (frame, scrollback) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        const currentCwd = currentCwdFromSession(frame.session);
        // First host frame for this session: the scrollback is in hand even
        // if xterm hasn't registered its writer yet (it lands in pendingWrites).
        markTerminalLoad(options.sessionId, "snapshot");
        // Capability sentinel (see `ackCreditSupported` above) - re-read on every snapshot, including a
        // reconnect's, so the flag always reflects the CURRENT subscription's negotiated support rather
        ackCreditSupported =
          frame.kind === "binarySnapshot" || frame.ackCreditSupported === true;
        // Per the protocol contract on `terminalSubscribeServerFrameSchema`, `scrollback` is raw terminal
        // bytes the renderer feeds straight into xterm.
        const scrollbackAccountLength = contentAccountLength(scrollback);
        const generationAtWrite = ackGeneration;
        const write: TerminalWrite = {
          kind: "snapshot",
          chunk: scrollback,
          cols: frame.session.cols,
          rows: frame.session.rows,
          onAckable: () =>
            accountAckableBytes(generationAtWrite, scrollbackAccountLength),
        };
        if (writer !== null) {
          writer(write);
        } else {
          enqueuePending(write);
        }
        const lastOutputPreview =
          scrollback.length === 0
            ? get().lastOutputPreview
            : (terminalOutputPreview(scrollback) ?? get().lastOutputPreview);
        set({
          snapshotLoaded: true,
          status: frame.session.status === "exited" ? "exited" : "running",
          exitCode: frame.session.exitCode,
          exitReason: frame.session.exitReason ?? null,
          effectiveCols: frame.session.cols,
          effectiveRows: frame.session.rows,
          reattachMode: "live",
          lastOutputPreview,
          title: frame.session.title,
          activeProcessName: activeProcessNameFromSession(frame.session),
          currentCwd: currentCwd === undefined ? get().currentCwd : currentCwd,
          currentCwdReported:
            currentCwd === undefined ? get().currentCwdReported : true,
        });
        flushRequestedResize();
      },
      onData: (frame, chunk) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        const chunkAccountLength = contentAccountLength(chunk);
        const generationAtWrite = ackGeneration;
        const write: TerminalWrite = {
          kind: "live",
          chunk,
          onAckable: () =>
            accountAckableBytes(generationAtWrite, chunkAccountLength),
        };
        if (writer !== null) {
          writer(write);
        } else {
          enqueuePending(write);
        }
        const lastOutputPreview = terminalOutputPreview(chunk);
        if (lastOutputPreview !== null) {
          set({ lastOutputPreview });
        }
      },
      onResized: (frame) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        set({
          effectiveCols: frame.cols,
          effectiveRows: frame.rows,
        });
      },
      onExit: (frame) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        // A live exit frame carries no reason. It is NOT only ever a genuine process exit to an attached
        // viewer: the host's setup-terminal reap kills sessions whose canvas tiles are live subscribers.
        set({
          status: "exited",
          exitCode: frame.exitCode,
          activeProcessName: null,
        });
      },
      onActionAck: (frame) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        set((state) => ({
          pendingActions: removePendingAction(
            state.pendingActions,
            frame.clientActionId,
          ),
        }));
      },
      onSessionUpdated: (frame) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        const currentCwd = currentCwdFromSession(frame.session);
        set({
          status: frame.session.status === "exited" ? "exited" : "running",
          exitCode: frame.session.exitCode,
          // The one live carrier of the exit reason for an attached viewer.
          exitReason: frame.session.exitReason ?? get().exitReason,
          title: frame.session.title,
          activeProcessName: activeProcessNameFromSession(frame.session),
          currentCwd: currentCwd === undefined ? get().currentCwd : currentCwd,
          currentCwdReported:
            currentCwd === undefined ? get().currentCwdReported : true,
        });
      },
      onConnectionStatus: (
        status: StreamConnectionStatus,
        reason: StreamCloseReason | null,
      ) => {
        if (disposed) return;
        if (ignoreTransientStatus) {
          ignoreTransientStatus = false;
          // Drop only the replacement stream's initial connecting/reconnecting
          // so a keep-warm reattach does not flash the reconnect overlay.
          if (status === "connecting" || status === "reconnecting") {
            return;
          }
        }
        if (status !== "open") {
          resetAckAccounting();
        }
        set((state) => ({
          connectionStatus: status,
          // If the stream drops before a snapshot, "creating" would otherwise survive forever and leave the
          // tile stuck on its loading state. Exited sessions remain exited.
          status: nextLifecycleStatusAfterConnectionStatus(
            status,
            state.status,
            reason,
          ),
        }));
        if (status !== "open") return;
        replayPendingActionsAfterReconnect();
        flushRequestedResize();
      },
    };

    const attachStream = (cols: number, rows: number): void => {
      const generation = streamGuard.current();
      streamClient = options.streamClientFactory({
        sessionId: options.sessionId,
        cols,
        rows,
        callbacks: bindStreamCallbacks(callbacks, streamGuard, generation),
        viewer,
      });
    };

    streamGuard.next();
    attachStream(options.cols, options.rows);

    const setViewer = (nextViewer: TerminalSubscribeViewer): void => {
      if (disposed) return;
      if (nextViewer === viewer) return;
      viewer = nextViewer;
      set({ viewer: nextViewer });
      const state = get();
      if (isTerminalOrDead(state.status)) return;
      const wasOpen = state.connectionStatus === "open";
      resetAckAccounting();
      // Invalidate before close() so the outgoing client's closed status
      // cannot mark this still-alive session lost.
      streamGuard.next();
      closeStreamClient();
      ignoreTransientStatus = wasOpen;
      attachStream(state.requestedCols, state.requestedRows);
    };

    return {
      sessionId: options.sessionId,
      scope: options.scope,
      connectionStatus: "connecting",
      snapshotLoaded: false,
      status: "creating",
      exitCode: null,
      exitReason: null,
      effectiveCols: options.cols,
      effectiveRows: options.rows,
      requestedCols: options.cols,
      requestedRows: options.rows,
      reattachMode: options.reattachMode,
      kind: options.kind,
      viewer: "presentation",
      pendingActions: {},
      lastOutputPreview: null,
      lastInputLostAt: null,
      title: null,
      activeProcessName: null,
      currentCwd: null,
      currentCwdReported: false,

      setWriter: (next) => {
        writer = next;
        if (next !== null) {
          flushPending(next);
        }
      },
      writeInput: (data) => {
        if (disposed || streamClient === null) return null;
        const state = get();
        if (isTerminalOrDead(state.status)) return null;
        if (state.connectionStatus !== "open") {
          return null;
        }
        const clientActionId = uuidv4();
        const frame: TerminalSubscribeClientFrame = {
          kind: "write",
          hasBinaryPayload: false,
          sessionId: options.sessionId,
          clientActionId,
          data,
        };
        recordPendingAction({ clientActionId, frame });
        dispatchClientFrame(frame);
        return clientActionId;
      },
      requestResize: (cols, rows) => {
        if (disposed || streamClient === null) return null;
        const state = get();
        if (state.status === "exited" || state.status === "reaped") return null;
        // Dedupe only a size that is BOTH already requested and already the effective grid.
        if (
          state.requestedCols === cols &&
          state.requestedRows === rows &&
          state.effectiveCols === cols &&
          state.effectiveRows === rows
        ) {
          return null;
        }
        if (state.status === "lost" || state.connectionStatus !== "open") {
          set({
            requestedCols: cols,
            requestedRows: rows,
          });
          return null;
        }
        const clientActionId = uuidv4();
        const frame: TerminalSubscribeClientFrame = {
          kind: "resize",
          hasBinaryPayload: false,
          sessionId: options.sessionId,
          clientActionId,
          cols,
          rows,
        };
        set((current) => {
          const { pendingActions, evicted } = appendPendingAction(
            current.pendingActions,
            { clientActionId, frame },
          );
          return {
            requestedCols: cols,
            requestedRows: rows,
            pendingActions,
            lastInputLostAt: evicted ? Date.now() : current.lastInputLostAt,
          };
        });
        dispatchClientFrame(frame);
        return clientActionId;
      },
      setViewer,
      retryTransport: () => {
        if (disposed) return;
        const state = get();
        if (state.status === "exited" || state.status === "reaped") return;
        resetAckAccounting();
        // Upstream bumped a bare `streamGeneration` counter here; this branch replaced that counter with
        // `streamGuard`, so the bump is its `next()`.
        streamGuard.next();
        closeStreamClient();
        set({
          connectionStatus: "connecting",
          status: state.snapshotLoaded ? "running" : "creating",
        });
        try {
          attachStream(state.requestedCols, state.requestedRows);
        } catch (cause) {
          // Leave the retained handle in the same recoverable terminal state as an ordinary transport close,
          // so registry replacement and explicit retry remain available after the bounded automatic attempts
          set({
            connectionStatus: "closed",
            status: "lost",
            snapshotLoaded: state.snapshotLoaded,
          });
          throw cause;
        }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        writer = null;
        resetAckAccounting();
        closeStreamClient();
      },
    };
  });

  return {
    scope: options.scope,
    sessionId: options.sessionId,
    store,
    dispose: () => {
      const current = store.getState();
      current.dispose();
    },
  };
}
