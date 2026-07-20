import { create, type StoreApi, type UseBoundStore } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { TerminalSubscribeClientFrame } from "@traycer/protocol/host/terminal/subscribe";
import type {
  CanonicalTerminalSessionInfo,
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

export type TerminalStreamClientFactory = (
  sessionId: string,
  cols: number,
  rows: number,
  callbacks: TerminalStreamCallbacks,
) => TerminalStreamClientHandle;

export type TerminalReattachMode = "fresh" | "live";
/**
 * `"lost"` - the stream closed for an unknown/recoverable reason (transport
 * drop, host restart, etc.) - the session MAY still be alive server-side
 * (within its detach-linger window, T13); auto-recovery
 * (`useTerminalSessionRecovery`) is worth attempting.
 * `"reaped"` - the host explicitly confirmed via `TERMINAL_NOT_FOUND` that
 * this session no longer exists (linger expired + reaped, or the host
 * restarted and lost it) - a DEFINITIVE dead end. Retrying is guaranteed to
 * fail identically every time, so this bypasses auto-recovery entirely and
 * maps to the terminal "Session lost" tile state (Journey 4).
 */
export type TerminalLifecycleStatus =
  "creating" | "running" | "exited" | "lost" | "reaped";

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
  /**
   * The exact client frame originally sent for this action (T13 terminal
   * action protocol). Kept so a reconnect can replay it verbatim - the
   * client's own bounded buffer is the only place this data survives; the
   * host's per-session idempotency window dedupes a replay that already
   * landed instead of re-applying it.
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
  /**
   * Wall-clock time (`Date.now()`) the pending-action ring last evicted an
   * unacked action to make room (T13's honest overflow signal - see
   * {@link AppendPendingActionResult}). `null` until the first eviction.
   * Tiles watch this to surface an "input may have been lost" notice rather
   * than silently swallowing it.
   */
  readonly lastInputLostAt: number | null;
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

/**
 * Result of appending to the pending-action ring: the updated map, plus
 * whether an unacked action was evicted to make room (T13's overflow
 * policy - drop-oldest + an honest "input lost" signal, Architecture §3/§8).
 * An evicted action never got an `actionAck` and never will - it fell out of
 * the buffer that would have replayed it on reconnect, so the caller must
 * surface this rather than dropping it silently.
 */
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
 * `TERMINAL_NOT_FOUND` (see `terminal-stream-resolver.ts`'s subscribe-time
 * catch) is the host authoritatively confirming this session id no longer
 * exists - reattaching to it can never succeed. Every other closed reason
 * (a plain transport drop, another fatal code, or no reason at all) is
 * treated as recoverable: the session may simply be unreachable right now.
 */
function isDefinitiveSessionLoss(reason: StreamCloseReason | null): boolean {
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
  if (isDefinitiveSessionLoss(reason)) {
    return "reaped";
  }
  return "lost";
}

/** No PTY to address: the session has exited, or the tile has already dead-ended on `"lost"`/`"reaped"`. */
function isTerminalOrDead(status: TerminalLifecycleStatus): boolean {
  return status === "exited" || status === "lost" || status === "reaped";
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
  session:
    | Pick<CanonicalTerminalSessionInfo, "activeProcessName">
    | Pick<TerminalSessionInfo, "activeProcessName">,
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
     * Appends to the pending-action ring and, on eviction, stamps
     * `lastInputLostAt` in the SAME `set()` call (T13's honest overflow
     * signal) so a tile watching either field never observes them out of
     * sync.
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
     * Replays every still-unacked `write` action after a reconnect (T13
     * terminal action protocol - Architecture §3/§8's "in-flight keystrokes
     * replay exactly-once-effect on reattach"). The host's per-session
     * idempotency window dedupes by `clientActionId`, so a write the old
     * subscriber already applied (only its `actionAck` was lost) just gets
     * re-acked, not re-typed into the PTY.
     *
     * Stale `resize` entries are dropped rather than replayed verbatim:
     * `flushRequestedResize` already reissues a fresh resize reflecting the
     * CURRENT pane size on every reconnect, which supersedes whatever size
     * was requested before the drop - replaying the old value would just
     * race a more-correct one.
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
        reason: StreamCloseReason | null,
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
          // Exited sessions remain exited. A closed stream otherwise splits on
          // WHY (T13): the host's `TERMINAL_NOT_FOUND` fatal is a definitive
          // "this session is gone" ("reaped") - anything else is a recoverable
          // "lost" renderer attachment worth auto-retrying.
          status: nextLifecycleStatusAfterConnectionStatus(
            status,
            state.status,
            reason,
          ),
        }));
        if (status !== "open") return;
        // Replay stale pending actions from BEFORE this reconnect first, so the
        // fresh resize `flushRequestedResize` is about to dispatch isn't
        // immediately swept up and removed as one of those stale entries.
        replayPendingActionsAfterReconnect();
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
      pendingActions: {},
      lastOutputPreview: null,
      lastInputLostAt: null,
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
        // Dedupe only a size that is BOTH already requested and already the
        // effective grid. Skipping on requested alone stranded the xterm
        // engine's latch self-heal: a resize frame lost in flight leaves
        // `requested` recorded while the host never adopted it, and the
        // engine's deliberate re-report of the same size must reach the wire
        // to retry. Calls arriving here are already engine-dedupe-gated, so
        // this cannot re-send on render-tick churn.
        if (
          state.requestedCols === cols &&
          state.requestedRows === rows &&
          state.effectiveCols === cols &&
          state.effectiveRows === rows
        ) {
          return null;
        }
        // "lost" stashes rather than drops: the xterm engine records every
        // report in its own dedupe before this store sees it, so a dropped
        // resize here is never re-offered - after the reconnect the session
        // would stay latched at the pre-disconnect grid. The stash is flushed
        // by `flushRequestedResize` once the reconnect's snapshot restores the
        // session to "running".
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
