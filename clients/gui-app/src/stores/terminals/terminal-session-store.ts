import { create, type StoreApi, type UseBoundStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { TerminalSubscribeClientFrame } from "@traycer/protocol/host/terminal/subscribe";
import type {
  TerminalSessionExitReason,
  TerminalSessionInfo,
  TerminalSessionKind,
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

// Ack-credit (terminal.subscribe@1.1) coalescing: acks are batched so a
// steady stream of parsed chunks doesn't send one `ack` frame per chunk. A
// pending credit is flushed as soon as either threshold is crossed.
const ACK_COALESCE_BYTES = 64 * 1024;
const ACK_COALESCE_MS = 50;

// A unit of terminal output handed to the xterm host. `snapshot` carries the
// grid dimensions the host serialized the redraw for: the host snapshot is a
// full-screen VT redraw (absolute cursor positioning) valid only at those
// cols/rows, so the host must resize the grid to them BEFORE replaying. `live`
// is raw PTY bytes appended at whatever the current grid is.
//
// `chunk` is `string | Uint8Array` (`terminal.subscribe@1.2`): a host
// negotiating binary framing sends raw UTF-8 bytes via the paired binary WS
// frame instead of a JSON string field, and xterm.js accepts `Uint8Array`
// directly - the renderer skips re-decoding it to a JS string, which is the
// whole point of the binary path (killing the 3-6x JSON-escaping tax on
// ANSI-heavy output). A `1.1`-or-older host still sends plain strings.
//
// `onAckable` is the ack-credit (terminal.subscribe@1.1) parse-completion
// channel: the xterm host calls it once this write's bytes have actually been
// parsed (via xterm's own `write(data, callback)`), or immediately if the
// write is dropped before ever reaching xterm (the pre-writer queue's byte
// cap). Either way the bytes are "accounted for" and safe to credit back to
// the host - crediting only on genuine parse would leak credit for anything
// dropped, eventually stalling the host's ack-credit gate for this
// subscriber forever.
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
  readonly action: "write" | "resize";
}

export interface TerminalSessionState {
  readonly sessionId: string;
  readonly epicId: string;
  readonly connectionStatus: StreamConnectionStatus;
  readonly snapshotLoaded: boolean;
  readonly status: TerminalLifecycleStatus;
  readonly exitCode: number | null;
  /**
   * Why the PTY ended, from the host's exit frame / exited snapshot.
   * `null` until exited, and for hosts predating the field (treat as
   * `process-exit`). A `reaped` exit is host lifecycle - the idle-reap of
   * an unwatched terminal-agent - and must not be presented as a crash.
   */
  readonly exitReason: TerminalSessionExitReason | null;
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
  readonly title: string | null;
  readonly activeProcessName: string | null;

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

const textDecoder = new TextDecoder();

// The ANSI-stripping regex below only operates on strings. Only ever called
// on `previewTail`'s bounded output (see `terminalOutputPreview`), so this
// decode stays a small, fixed-size cost regardless of the source frame's
// size - unrelated to (and far smaller than) the bulk-throughput decode
// xterm's own `Uint8Array` write path is specifically built to skip.
function contentToText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : textDecoder.decode(content);
}

// Ack-credit byte-counting convention (see `accountAckableBytes`): a `1.1`
// text connection counts JS string length (UTF-16 code units) since that's
// what it received and reports back; a `1.2`+ binary connection counts
// `Uint8Array.byteLength` since it never decodes to a string at all. The two
// conventions must never mix on the same tally - `TerminalWrite.chunk`'s
// type already guarantees a single connection stays on one or the other for
// its whole lifetime (see `terminal-session-manager.ts`'s host-side twin).
function contentAccountLength(content: string | Uint8Array): number {
  return typeof content === "string" ? content.length : content.byteLength;
}

// Bounds preview-extraction cost on a large coalesced binary frame (up to
// ~2 MB under a `@1.2` firehose): the preview only ever needs the trailing
// non-empty line, so decoding/scanning more than a generous tail is wasted
// work on exactly the firehose path binary framing exists to speed up. A
// byte offset can split a multi-byte UTF-8 sequence at the slice boundary -
// `TextDecoder` replaces it with U+FFFD, which can't land in the retained
// line (the split fragment is discarded by the following newline-split),
// inconsequential for a cosmetic preview.
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
  session: TerminalSessionInfo,
): string | null {
  const name = session.activeProcessName;
  if (name === undefined || name === null) return null;
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
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
        // Dropped before ever reaching xterm - it will never fire its own
        // parse-completion callback, so credit it back to the host right
        // here. Without this the host's ack-credit tally for these bytes
        // never clears, eventually stalling this subscriber's gate for good.
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

  // Ack-credit accounting: bytes accounted (parsed by xterm, or dropped
  // before ever reaching it) since the last `ack` frame was sent, and the
  // coalescing timer for the current batch.
  let unackedLocalBytes = 0;
  let ackFlushTimer: number | null = null;
  // Bumped on every disconnect so `onAckable` callbacks captured by writes
  // handed to xterm before the drop become no-ops if xterm's write callback
  // fires late (after a reconnect has already minted a fresh host
  // subscriber). Without this, a stale callback would credit bytes that
  // subscriber never sent, letting the host believe the renderer has more
  // headroom than it really does.
  let ackGeneration = 0;
  // Capability sentinel: the renderer has no direct way to read the minor
  // negotiated for this stream, so it waits for the host to confirm
  // ack-credit support on a snapshot frame (same pattern as
  // `chat.subscribe@1.1`'s `backgroundItems`) before ever sending an `ack`.
  // A `1.0` host's frame schema can't parse "ack", so sending one blind
  // would just produce a steady stream of malformed-frame warnings
  // server-side instead of a fatal error - annoying, not dangerous, but
  // avoidable.
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
      onSnapshot: (frame, scrollback) => {
        if (disposed || frame.sessionId !== options.sessionId) return;
        // First host frame for this session: the scrollback is in hand even
        // if xterm hasn't registered its writer yet (it lands in pendingWrites).
        markTerminalLoad(options.sessionId, "snapshot");
        // Capability sentinel (see `ackCreditSupported` above) - re-read on
        // every snapshot, including a reconnect's, so the flag always
        // reflects the CURRENT subscription's negotiated support rather than
        // a stale value from before a drop. `binarySnapshot` has no field to
        // read: receiving it at all already proves the connection negotiated
        // `1.2`, which implies `1.1`'s ack-credit support.
        ackCreditSupported =
          frame.kind === "binarySnapshot" || frame.ackCreditSupported === true;
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
        if (scrollback.length > 0) {
          // Carry the snapshot's grid so the host resizes xterm to it BEFORE
          // replaying. `session.cols/rows` are the post-`min()` effective size
          // the host serialized the redraw at; replaying into a differently
          // sized grid garbles it (see `TerminalWrite`).
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
        // A live exit frame carries no reason - it is only ever a genuine
        // process exit or an explicit kill to an attached viewer (a reaped
        // idle session has no viewer, so it is observed via the reattach
        // snapshot's `session.exitReason` instead). Leave `exitReason`
        // untouched here; the snapshot path is authoritative for it.
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
        set({
          status: frame.session.status === "exited" ? "exited" : "running",
          exitCode: frame.session.exitCode,
          title: frame.session.title,
          activeProcessName: activeProcessNameFromSession(frame.session),
        });
      },
      onConnectionStatus: (
        status: StreamConnectionStatus,
        _reason: StreamCloseReason | null,
      ) => {
        if (disposed) return;
        if (status !== "open") {
          // A reconnect re-subscribes and the host mints a fresh subscriber
          // with unackedBytes = 0, so any credit accumulated for the old
          // connection is moot - drop it rather than send a stale ack (or
          // leak the timer) once the new connection opens.
          resetAckAccounting();
        }
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
      exitReason: null,
      effectiveCols: options.cols,
      effectiveRows: options.rows,
      requestedCols: options.cols,
      requestedRows: options.rows,
      reattachMode: options.reattachMode,
      kind: options.kind,
      pendingActions: {},
      lastOutputPreview: null,
      title: null,
      activeProcessName: null,

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
        resetAckAccounting();
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
