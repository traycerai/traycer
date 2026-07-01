import { create, type StoreApi, type UseBoundStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { TerminalSubscribeClientFrame } from "@traycer/protocol/host/terminal/subscribe";
import type { TerminalSessionKind } from "@traycer/protocol/host/terminal/unary-schemas";
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

export type TerminalStreamClientFactory = (
  sessionId: string,
  cols: number,
  rows: number,
  callbacks: TerminalStreamCallbacks,
) => TerminalStreamClientHandle;

export type TerminalReattachMode = "fresh" | "live";
export type TerminalLifecycleStatus =
  "creating" | "running" | "exited" | "lost";

const MAX_PENDING_ACTIONS = 64;
// Cap the pre-writer queue so a misconfigured tile that never registers a
// writer can't grow the buffer unboundedly. The host's own scrollback is
// 512 KB so 1 MB is generous headroom for snapshot + a burst of data frames.
const MAX_PENDING_BYTES = 1024 * 1024;

// A unit of terminal output handed to the xterm host. `snapshot` carries the
// grid dimensions the host serialized the redraw for: the host snapshot is a
// full-screen VT redraw (absolute cursor positioning) valid only at those
// cols/rows, so the host must resize the grid to them BEFORE replaying. `live`
// is raw PTY bytes appended at whatever the current grid is.
export type TerminalWrite =
  | { readonly kind: "live"; readonly chunk: string }
  | {
      readonly kind: "snapshot";
      readonly chunk: string;
      readonly cols: number;
      readonly rows: number;
    };
export type TerminalDataWriter = (write: TerminalWrite) => void;

export interface PendingTerminalAction {
  readonly clientActionId: string;
  readonly action: "write" | "resize";
}

export interface TerminalSessionState {
  readonly sessionId: string;
  readonly epicId: string;
  readonly connectionStatus: StreamConnectionStatus;
  readonly snapshotLoaded: boolean;
  readonly status: TerminalLifecycleStatus;
  readonly exitCode: number | null;
  readonly effectiveCols: number;
  readonly effectiveRows: number;
  readonly requestedCols: number;
  readonly requestedRows: number;
  readonly reattachMode: TerminalReattachMode;
  /**
   * Whether this session backs a plain terminal tab or a terminal-agent. The
   * agent-activity monitor counts a live terminal-agent PTY as "an agent in
   * progress" (for sleep prevention) but ignores an idle plain shell.
   */
  readonly kind: TerminalSessionKind;
  readonly pendingActions: Readonly<Record<string, PendingTerminalAction>>;
  readonly lastOutputPreview: string | null;

  /** Tile registers an xterm `term.write` proxy here once mounted. */
  setWriter: (writer: TerminalDataWriter | null) => void;
  /** Send keystrokes (or pasted text) to the host. */
  writeInput: (data: string) => string | null;
  /** Ask the host to resize; the host may pick a smaller min(cols/rows). */
  requestResize: (cols: number, rows: number) => string | null;
  /** Closes the underlying stream client (does NOT call `terminal.kill`). */
  dispose: () => void;
}

export interface TerminalSessionStoreOptions {
  readonly epicId: string;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  readonly reattachMode: TerminalReattachMode;
  readonly kind: TerminalSessionKind;
  readonly streamClientFactory: TerminalStreamClientFactory;
}

export interface TerminalSessionStoreHandle {
  readonly epicId: string;
  readonly sessionId: string;
  readonly store: UseBoundStore<StoreApi<TerminalSessionState>>;
  readonly dispose: () => void;
}

function appendPendingAction(
  pendingActions: Readonly<Record<string, PendingTerminalAction>>,
  next: PendingTerminalAction,
): Readonly<Record<string, PendingTerminalAction>> {
  // Cap the ring with FIFO eviction so a never-acked action can't leak.
  const keys = Object.keys(pendingActions);
  if (keys.length < MAX_PENDING_ACTIONS) {
    return { ...pendingActions, [next.clientActionId]: next };
  }
  const trimmed: Record<string, PendingTerminalAction> = {};
  for (const key of keys.slice(keys.length - MAX_PENDING_ACTIONS + 1)) {
    trimmed[key] = pendingActions[key];
  }
  trimmed[next.clientActionId] = next;
  return trimmed;
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

function terminalOutputPreview(chunk: string): string | null {
  const preview = chunk
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

export function createTerminalSessionStore(
  options: TerminalSessionStoreOptions,
): TerminalSessionStoreHandle {
  let disposed = false;
  let writer: TerminalDataWriter | null = null;
  let streamClient: TerminalStreamClientHandle | null = null;
  // Buffers host output that arrives before the tile has finished mounting
  // its xterm host and registered a writer. Without this queue the snapshot
  // frame and any initial shell output (zsh's first prompt, motd, etc.) get
  // dropped, and the user sees an empty terminal even though the host is
  // streaming bytes. Flushed in `setWriter` when the writer is first set.
  const pendingWrites: TerminalWrite[] = [];
  let pendingBytes = 0;
  const enqueuePending = (write: TerminalWrite): void => {
    if (write.chunk.length === 0) return;
    pendingWrites.push(write);
    pendingBytes += write.chunk.length;
    while (pendingBytes > MAX_PENDING_BYTES && pendingWrites.length > 1) {
      const dropped = pendingWrites.shift();
      if (dropped !== undefined) {
        pendingBytes -= dropped.chunk.length;
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

  const store = create<TerminalSessionState>()((set, get) => {
    const dispatchClientFrame = (frame: TerminalSubscribeClientFrame): void => {
      const client = streamClient;
      if (client === null) return;
      if (get().connectionStatus !== "open") {
        return;
      }
      client.sendAction(frame);
    };

    const flushRequestedResize = (): void => {
      // Reconnect ordering is open -> snapshot. The open callback can see the
      // old effective grid and skip, then the snapshot can overwrite effective
      // with the host's stale serialized size. Re-check after both events so a
      // remembered resize is not stranded behind the xterm engine's dedupe.
      const state = get();
      if (state.status === "exited" || state.status === "lost") return;
      if (state.connectionStatus !== "open") return;
      if (
        state.requestedCols === state.effectiveCols &&
        state.requestedRows === state.effectiveRows
      ) {
        return;
      }
      const clientActionId = uuidv4();
      set((current) => ({
        pendingActions: appendPendingAction(current.pendingActions, {
          clientActionId,
          action: "resize",
        }),
      }));
      dispatchClientFrame({
        kind: "resize",
        hasBinaryPayload: false,
        sessionId: options.sessionId,
        clientActionId,
        cols: state.requestedCols,
        rows: state.requestedRows,
      });
    };

    const callbacks: TerminalStreamCallbacks = {
      onSnapshot: (frame) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        // First host frame for this session: the scrollback is in hand even
        // if xterm hasn't registered its writer yet (it lands in pendingWrites).
        markTerminalLoad(options.sessionId, "snapshot");
        // Per the protocol contract on `terminalSubscribeServerFrameSchema`,
        // `scrollback` is raw terminal bytes the renderer feeds straight into
        // xterm. This is usually the first frame into a fresh xterm, but NOT
        // always: a transport reconnect re-subscribes and the host re-sends a
        // full snapshot into the SAME kept-alive engine that still holds
        // pre-disconnect content. The engine's snapshot write path resets the
        // buffer before replaying a snapshot once it already has content (see
        // `writerProxy`), so the authoritative snapshot lands clean instead of
        // colliding with the stale screen (which dropped the trailing output and
        // left the native OSC theme un-rasterized until a tab switch). The
        // `snapshot` kind is load-bearing: xterm can emit protocol responses
        // while parsing historical bytes, and those must not be forwarded back
        // to the live PTY as user input.
        if (frame.scrollback.length > 0) {
          // Carry the snapshot's grid so the host resizes xterm to it BEFORE
          // replaying. `session.cols/rows` are the post-`min()` effective size
          // the host serialized the redraw at; replaying into a differently
          // sized grid garbles it (see `TerminalWrite`).
          const write: TerminalWrite = {
            kind: "snapshot",
            chunk: frame.scrollback,
            cols: frame.session.cols,
            rows: frame.session.rows,
          };
          if (writer !== null) {
            writer(write);
          } else {
            enqueuePending(write);
          }
        }
        const lastOutputPreview =
          frame.scrollback.length === 0
            ? get().lastOutputPreview
            : (terminalOutputPreview(frame.scrollback) ??
              get().lastOutputPreview);
        set({
          snapshotLoaded: true,
          status: frame.session.status === "exited" ? "exited" : "running",
          exitCode: frame.session.exitCode,
          effectiveCols: frame.session.cols,
          effectiveRows: frame.session.rows,
          reattachMode: "live",
          lastOutputPreview,
        });
        flushRequestedResize();
      },
      onData: (frame) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        const write: TerminalWrite = { kind: "live", chunk: frame.chunk };
        if (writer !== null) {
          writer(write);
        } else {
          enqueuePending(write);
        }
        const lastOutputPreview = terminalOutputPreview(frame.chunk);
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
        set({
          status: "exited",
          exitCode: frame.exitCode,
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
      onConnectionStatus: (
        status: StreamConnectionStatus,
        _reason: StreamCloseReason | null,
      ) => {
        if (disposed) return;
        set((state) => ({
          connectionStatus: status,
          // If the stream drops before a snapshot, "creating" would otherwise
          // survive forever and leave the tile stuck on its loading state.
          // Exited sessions remain exited; every other closed stream is a lost
          // renderer attachment until the registry reacquires it.
          status:
            status === "closed" && state.status !== "exited"
              ? "lost"
              : state.status,
        }));
        if (status !== "open") return;
        flushRequestedResize();
      },
    };

    streamClient = options.streamClientFactory(
      options.sessionId,
      options.cols,
      options.rows,
      callbacks,
    );

    return {
      sessionId: options.sessionId,
      epicId: options.epicId,
      connectionStatus: "connecting",
      snapshotLoaded: false,
      status: "creating",
      exitCode: null,
      effectiveCols: options.cols,
      effectiveRows: options.rows,
      requestedCols: options.cols,
      requestedRows: options.rows,
      reattachMode: options.reattachMode,
      kind: options.kind,
      pendingActions: {},
      lastOutputPreview: null,

      setWriter: (next) => {
        writer = next;
        if (next !== null) {
          flushPending(next);
        }
      },
      writeInput: (data) => {
        if (disposed || streamClient === null) return null;
        const state = get();
        if (state.status === "exited" || state.status === "lost") return null;
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
        set((current) => ({
          pendingActions: appendPendingAction(current.pendingActions, {
            clientActionId,
            action: "write",
          }),
        }));
        dispatchClientFrame(frame);
        return clientActionId;
      },
      requestResize: (cols, rows) => {
        if (disposed || streamClient === null) return null;
        const state = get();
        if (state.status === "exited" || state.status === "lost") return null;
        if (state.requestedCols === cols && state.requestedRows === rows) {
          return null;
        }
        if (state.connectionStatus !== "open") {
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
        set((current) => ({
          requestedCols: cols,
          requestedRows: rows,
          pendingActions: appendPendingAction(current.pendingActions, {
            clientActionId,
            action: "resize",
          }),
        }));
        dispatchClientFrame(frame);
        return clientActionId;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        writer = null;
        closeStreamClient();
      },
    };
  });

  return {
    epicId: options.epicId,
    sessionId: options.sessionId,
    store,
    dispose: () => {
      const current = store.getState();
      current.dispose();
    },
  };
}
