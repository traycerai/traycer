import { v4 as uuidv4 } from "uuid";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type {
  ManagedCommandOutputStreamCallbacks,
  ManagedCommandOutputStreamClient,
} from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import type {
  ManagedCommandLogLine,
  ManagedCommandLogPosition,
} from "@traycer/protocol/host/managed-command/subscribe";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";

/**
 * The renderer side of `managedCommand.subscribeOutput@1.0`: one store per open
 * output window, holding the timeline the tile renders.
 *
 * The retained log runs to tens of megabytes, so the window holds only what it
 * has actually been served - the opening tail plus whatever the human scrolled
 * back to. Nothing is trimmed from the head in return: `start` is the host's
 * own cursor for "the oldest line you hold", and dropping lines behind it would
 * open a gap the wire has no way to express.
 */

export type ManagedCommandOutputStreamClientHandle = Pick<
  ManagedCommandOutputStreamClient,
  "loadOlder" | "close"
>;

export type ManagedCommandOutputStreamClientFactory = (
  epicId: string,
  commandId: string,
  callbacks: ManagedCommandOutputStreamCallbacks,
) => ManagedCommandOutputStreamClientHandle;

/** One scroll-up page. Well under the wire's 2,000-line ceiling. */
export const MANAGED_COMMAND_OLDER_PAGE_LINES = 500;

/**
 * A log line plus the identity the viewer needs and the wire does not carry.
 * Log lines have no id and repeat verbatim, so a row is identified by its
 * place in the timeline: the opening tail is numbered from zero, live output
 * counts up from the end, and a scroll-up page counts down below the start.
 * Position alone (an array index) would not do - prepending a page of older
 * lines renumbers every row after it, remounting the whole list under the
 * viewer.
 */
export interface ManagedCommandTimelineLine extends ManagedCommandLogLine {
  readonly seq: number;
}

export interface ManagedCommandOutputState {
  readonly connectionStatus: StreamConnectionStatus;
  /** `null` until the opening snapshot lands. */
  readonly command: ManagedCommand | null;
  /** Oldest line first - output and lifecycle records in one timeline. */
  readonly lines: readonly ManagedCommandTimelineLine[];
  /** Where the held lines begin; handed back verbatim to page up. */
  readonly start: ManagedCommandLogPosition | null;
  readonly reachedStart: boolean;
  readonly loadingOlder: boolean;
  /** The command was deleted while this window was open. */
  readonly deleted: boolean;
  /**
   * The host closed the stream for good rather than dropping it. The one that
   * matters here is `MANAGED_COMMAND_NOT_FOUND`: a window restored from a
   * previous session for a command deleted while the app was closed never gets
   * a snapshot at all, and without this the tile has nothing to say.
   */
  readonly fatalClose: FatalErrorDetails | null;
  readonly loadOlder: () => void;
  readonly dispose: () => void;
}

export interface ManagedCommandOutputStoreOptions {
  readonly epicId: string;
  readonly commandId: string;
  readonly streamClientFactory: ManagedCommandOutputStreamClientFactory;
}

export interface ManagedCommandOutputStoreHandle {
  readonly commandId: string;
  readonly store: UseBoundStore<StoreApi<ManagedCommandOutputState>>;
  readonly dispose: () => void;
}

const EMPTY_LINES: readonly ManagedCommandTimelineLine[] = [];

/**
 * A fatal close is remembered until a fresh connection clears it - it is the
 * only account the window has of why nothing is arriving. A caller-initiated
 * close (the tab going away) says nothing about the command and leaves it.
 */
function nextFatalClose(
  current: FatalErrorDetails | null,
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): FatalErrorDetails | null {
  if (status === "open") return null;
  if (status === "closed" && reason?.kind === "fatalError") {
    return reason.details;
  }
  return current;
}

export function createManagedCommandOutputStore(
  options: ManagedCommandOutputStoreOptions,
): ManagedCommandOutputStoreHandle {
  let disposed = false;
  let streamClient: ManagedCommandOutputStreamClientHandle | null = null;
  // The request the store is waiting on. A window that arrives under any other
  // id belongs to a request this one outran, and is dropped.
  let pendingOlderRequestId: string | null = null;
  // Sequence numbers grow upward for live output and downward for pages read
  // backwards, so every row keeps one identity for as long as the window lives.
  let nextAppendSeq = 0;
  let nextPrependSeq = -1;

  const numberForward = (
    lines: readonly ManagedCommandLogLine[],
  ): readonly ManagedCommandTimelineLine[] =>
    lines.map((line) => ({ ...line, seq: nextAppendSeq++ }));

  const numberBackward = (
    lines: readonly ManagedCommandLogLine[],
  ): readonly ManagedCommandTimelineLine[] =>
    [...lines]
      .reverse()
      .map((line) => ({ ...line, seq: nextPrependSeq-- }))
      .reverse();

  const store = create<ManagedCommandOutputState>()((set, get) => {
    const callbacks: ManagedCommandOutputStreamCallbacks = {
      onSnapshot: (snapshot) => {
        if (disposed) return;
        pendingOlderRequestId = null;
        nextAppendSeq = 0;
        nextPrependSeq = -1;
        set({
          command: snapshot.command,
          lines: numberForward(snapshot.lines),
          start: snapshot.start,
          reachedStart: snapshot.reachedStart,
          loadingOlder: false,
        });
      },
      onOutput: (lines) => {
        if (disposed || lines.length === 0) return;
        set((state) => ({ lines: [...state.lines, ...numberForward(lines)] }));
      },
      onOlder: (window) => {
        if (disposed) return;
        if (window.requestId !== pendingOlderRequestId) return;
        pendingOlderRequestId = null;
        set((state) => ({
          lines: [...numberBackward(window.lines), ...state.lines],
          start: window.start,
          reachedStart: window.reachedStart,
          loadingOlder: false,
        }));
      },
      onStatus: (command) => {
        if (disposed) return;
        set({ command });
      },
      onDeleted: () => {
        if (disposed) return;
        // Scrollback survives: it is the last trace of a history the host has
        // just destroyed, and nothing older can be paged in now.
        set({ deleted: true, reachedStart: true, loadingOlder: false });
      },
      onConnectionStatus: (
        status: StreamConnectionStatus,
        reason: StreamCloseReason | null,
      ) => {
        if (disposed) return;
        set((state) => ({
          connectionStatus: status,
          fatalClose: nextFatalClose(state.fatalClose, status, reason),
        }));
      },
    };

    streamClient = options.streamClientFactory(
      options.epicId,
      options.commandId,
      callbacks,
    );

    return {
      connectionStatus: "connecting",
      command: null,
      lines: EMPTY_LINES,
      start: null,
      reachedStart: false,
      loadingOlder: false,
      deleted: false,
      fatalClose: null,
      loadOlder: () => {
        const state = get();
        if (state.reachedStart || state.loadingOlder) return;
        const before = state.start;
        if (before === null || streamClient === null) return;
        const requestId = uuidv4();
        pendingOlderRequestId = requestId;
        set({ loadingOlder: true });
        streamClient.loadOlder({
          kind: "loadOlder",
          hasBinaryPayload: false,
          requestId,
          before,
          maxLines: MANAGED_COMMAND_OLDER_PAGE_LINES,
        });
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (streamClient === null) return;
        const client = streamClient;
        streamClient = null;
        client.close();
      },
    };
  });

  return {
    commandId: options.commandId,
    store,
    dispose: () => {
      store.getState().dispose();
    },
  };
}
