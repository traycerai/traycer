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
import type { StreamMethodSupportSource } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * The renderer side of `managedCommand.subscribeOutput@1.0`: one store per open
 * output window, holding the timeline the tile renders.
 *
 * The retained log runs to tens of megabytes, so the window holds only what it
 * has actually been served - the opening tail plus whatever the human scrolled
 * back to. While following, old frames are trimmed at host-positioned
 * boundaries; `start` advances with the cut, so the discarded gap remains
 * reachable through the ordinary load-older path.
 */

export type ManagedCommandOutputStreamClientHandle = Pick<
  ManagedCommandOutputStreamClient,
  "loadOlder" | "resnapshot" | "close"
> & {
  /**
   * Where this window reads what its bound host can serve: the negotiated
   * method support of the very client the subscription rides on. The app's
   * default-host client is the wrong place to ask - a tab is bound to its
   * host for life, and that host can be a different machine on a different
   * version. `null` when a test stub stands in for the transport.
   */
  readonly streamMethodSupport: StreamMethodSupportSource<HostStreamRpcRegistry> | null;
};

export type ManagedCommandOutputStreamClientFactory = (
  epicId: string,
  commandId: string,
  callbacks: ManagedCommandOutputStreamCallbacks,
) => ManagedCommandOutputStreamClientHandle;

/** One scroll-up page. Well under the wire's 2,000-line ceiling. */
export const MANAGED_COMMAND_OLDER_PAGE_LINES = 500;

/** Hysteresis keeps a loud shell from slicing the timeline on every frame. */
export const MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES = 20_000;
export const MANAGED_COMMAND_OUTPUT_RETENTION_TARGET_LINES = 15_000;

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
  /** Present only on the first row of a host-positioned wire frame. */
  readonly frameStart: ManagedCommandLogPosition | null;
}

export interface ManagedCommandOutputState {
  readonly connectionStatus: StreamConnectionStatus;
  /** `null` until the opening snapshot lands. */
  readonly command: ManagedCommand | null;
  /** Oldest line first - output and lifecycle records in one timeline. */
  readonly lines: readonly ManagedCommandTimelineLine[];
  /** Where the held lines begin; handed back verbatim to page up. */
  readonly start: ManagedCommandLogPosition | null;
  /**
   * The host has said the oldest held line is the oldest it retains. Only the
   * host says so - a deletion stops paging by other means, and must not claim
   * a cached tail was ever the start of anything.
   */
  readonly reachedStart: boolean;
  readonly loadingOlder: boolean;
  /** The held window no longer reaches the live tail and needs a resnapshot. */
  readonly detached: boolean;
  /** A fresh live-tail snapshot has been requested but has not landed yet. */
  readonly resyncPending: boolean;
  /** At least one live output frame arrived after the reader detached. */
  readonly newOutputAvailable: boolean;
  /** Increments whenever a snapshot replaces the entire timeline. */
  readonly timelineGeneration: number;
  /** The command was deleted while this window was open. */
  readonly deleted: boolean;
  /**
   * The host closed the stream for good rather than dropping it, and this is
   * its account of why. Kept verbatim: which code it carries decides whether
   * the shell is gone, the viewer lost access, or the stream merely failed -
   * and that reading belongs to the window, not to this store.
   */
  readonly fatalClose: FatalErrorDetails | null;
  readonly loadOlder: () => void;
  /** Reader intent controls whether head retention is allowed to advance. */
  readonly setFollowing: (following: boolean) => void;
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
  /** See `ManagedCommandOutputStreamClientHandle.streamMethodSupport`. */
  readonly streamMethodSupport: StreamMethodSupportSource<HostStreamRpcRegistry> | null;
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
  let following = true;
  let receivedSnapshot = false;

  const numberForward = (
    lines: readonly ManagedCommandLogLine[],
    frameStart: ManagedCommandLogPosition,
  ): readonly ManagedCommandTimelineLine[] =>
    lines.map((line, index) => ({
      ...line,
      seq: nextAppendSeq++,
      frameStart: index === 0 ? frameStart : null,
    }));

  const numberBackward = (
    lines: readonly ManagedCommandLogLine[],
    frameStart: ManagedCommandLogPosition,
  ): readonly ManagedCommandTimelineLine[] => {
    const numbered: ManagedCommandTimelineLine[] = [...lines]
      .reverse()
      .map((line) => ({ ...line, seq: nextPrependSeq--, frameStart: null }))
      .reverse();
    if (numbered.length === 0) return numbered;
    numbered[0] = { ...numbered[0], frameStart };
    return numbered;
  };

  const trimFollowingTimeline = (
    state: ManagedCommandOutputState,
  ): {
    readonly lines: readonly ManagedCommandTimelineLine[];
    readonly start: ManagedCommandLogPosition;
    readonly reachedStart: false;
  } | null => {
    if (
      !following ||
      state.loadingOlder ||
      state.lines.length <= MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES
    ) {
      return null;
    }
    const earliestCut =
      state.lines.length - MANAGED_COMMAND_OUTPUT_RETENTION_TARGET_LINES;
    for (let index = earliestCut; index < state.lines.length; index += 1) {
      const frameStart = state.lines[index].frameStart;
      if (frameStart === null) continue;
      return {
        lines: state.lines.slice(index),
        start: frameStart,
        reachedStart: false,
      };
    }
    // A single wire frame is indivisible: retaining it is the only way to keep
    // the cursor honest. The host bounds live frames, so this overflow is also
    // bounded and the next positioned frame supplies a cut point.
    return null;
  };

  const trimDetachedTimeline = (
    state: ManagedCommandOutputState,
  ): ManagedCommandOutputState => {
    if (
      following ||
      state.lines.length <= MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES
    ) {
      return state;
    }
    // A detached reader is paging toward older output. Keep the oldest side
    // they just asked for and evict the stale newest side; returning to live
    // replaces the entire window with a fresh positioned snapshot anyway.
    return {
      ...state,
      lines: state.lines.slice(
        0,
        MANAGED_COMMAND_OUTPUT_RETENTION_TARGET_LINES,
      ),
      // Even a quiet command is now missing its retained tail. There is no
      // forward-page cursor, so returning live must replace this history
      // window exactly like returning after discarded live output.
      detached: true,
    };
  };

  const store = create<ManagedCommandOutputState>()((set, get) => ({
    connectionStatus: "connecting",
    command: null,
    lines: EMPTY_LINES,
    start: null,
    reachedStart: false,
    loadingOlder: false,
    detached: false,
    resyncPending: false,
    newOutputAvailable: false,
    timelineGeneration: 0,
    deleted: false,
    fatalClose: null,
    setFollowing: (nextFollowing) => {
      following = nextFollowing;
      if (!following) return;
      const state = store.getState();
      if (state.detached) {
        if (state.resyncPending) return;
        pendingOlderRequestId = null;
        store.setState({ resyncPending: true, loadingOlder: false });
        streamClient?.resnapshot();
        return;
      }
      store.setState((current) => trimFollowingTimeline(current) ?? current);
    },
    loadOlder: () => {
      const state = get();
      if (state.reachedStart || state.loadingOlder || state.resyncPending) {
        return;
      }
      // Nothing can be paged in behind a shell the host has dropped or a
      // stream it has closed for good; asking would send a frame into a dead
      // session and leave the spinner waiting on a reply that never comes.
      if (state.deleted || state.fatalClose !== null) return;
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
  }));

  const callbacks: ManagedCommandOutputStreamCallbacks = {
    onSnapshot: (snapshot) => {
      if (disposed) return;
      pendingOlderRequestId = null;
      // A replacement snapshot (reconnect or explicit resnapshot) restores
      // live-follow intent. The first snapshot preserves any reading anchor
      // the tile restored before it arrived.
      if (receivedSnapshot) following = true;
      receivedSnapshot = true;
      store.setState((state) => ({
        command: snapshot.command,
        lines: numberForward(snapshot.lines, snapshot.start),
        start: snapshot.start,
        reachedStart: snapshot.reachedStart,
        loadingOlder: false,
        detached: false,
        resyncPending: false,
        newOutputAvailable: false,
        timelineGeneration: state.timelineGeneration + 1,
      }));
    },
    onOutput: (frame) => {
      if (disposed || frame.lines.length === 0) return;
      store.setState((state) => {
        if (!following || state.detached || state.resyncPending) {
          if (state.detached && state.newOutputAvailable) return state;
          return {
            ...state,
            detached: true,
            newOutputAvailable: true,
          };
        }
        const appended = {
          ...state,
          lines: [...state.lines, ...numberForward(frame.lines, frame.start)],
        };
        // A stalled backward page must not suspend the live-window bound. If
        // output crosses the ceiling while that request is in flight, abandon
        // the page before advancing `start`; accepting its old-before window
        // afterward would splice a gap into the retained timeline.
        const trimmable =
          appended.loadingOlder &&
          appended.lines.length > MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES
            ? { ...appended, loadingOlder: false }
            : appended;
        if (trimmable !== appended) pendingOlderRequestId = null;
        const trimmed = trimFollowingTimeline(trimmable);
        return trimmed === null ? trimmable : { ...trimmable, ...trimmed };
      });
    },
    onOlder: (window) => {
      if (disposed) return;
      if (window.requestId !== pendingOlderRequestId) return;
      pendingOlderRequestId = null;
      store.setState((state) => {
        const prepended = {
          ...state,
          lines: [
            ...numberBackward(window.lines, window.start),
            ...state.lines,
          ],
          start: window.start,
          reachedStart: window.reachedStart,
          loadingOlder: false,
        };
        const followingTrim = trimFollowingTimeline(prepended);
        return trimDetachedTimeline(
          followingTrim === null
            ? prepended
            : { ...prepended, ...followingTrim },
        );
      });
    },
    onStatus: (command) => {
      if (disposed) return;
      store.setState({ command });
    },
    onDeleted: () => {
      if (disposed) return;
      // The history went with the shell; a page in flight has nothing to land
      // on. `reachedStart` is left alone - it is the host's word about the
      // retained log, and a deletion is not that word.
      pendingOlderRequestId = null;
      store.setState({ deleted: true, loadingOlder: false });
    },
    onConnectionStatus: (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
    ) => {
      if (disposed) return;
      const closedForGood =
        status === "closed" && reason?.kind === "fatalError";
      // A page can never land on a stream the host closed for good: drop the
      // wait, or the spinner sits at the top of a dead timeline forever.
      if (closedForGood) pendingOlderRequestId = null;
      store.setState((state) => ({
        connectionStatus: status,
        fatalClose: nextFatalClose(state.fatalClose, status, reason),
        loadingOlder: closedForGood ? false : state.loadingOlder,
      }));
    },
  };

  // Opened after the store exists, so a stream that speaks synchronously on
  // construction lands on a live store rather than a half-built one.
  streamClient = options.streamClientFactory(
    options.epicId,
    options.commandId,
    callbacks,
  );

  return {
    commandId: options.commandId,
    store,
    streamMethodSupport: streamClient.streamMethodSupport,
    dispose: () => {
      store.getState().dispose();
    },
  };
}
