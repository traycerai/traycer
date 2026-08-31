/**
 * The output window (`UI.md` §4): a read-only view of one managed command's
 * log. Deliberately NOT a terminal - managed commands are spawned over pipes
 * with no PTY, so there are no escape sequences to emulate and the lines arrive
 * already framed. A text view is truer and cheaper than an xterm.
 *
 * One interleaved timeline (stdout, tinted stderr, and lifecycle records as
 * distinct rows) with timestamps on by default, opened at the tail and paged
 * backwards on demand. Follow mode is the default and pauses the moment the
 * human scrolls away from the newest line.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useStore } from "zustand";
import { ArrowDownToLine, Info } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { SegmentCopyButton } from "@/components/chat/segments/segment-copy-button";
import { ManagedCommandChatBacklink } from "@/components/managed-commands/managed-command-chat-backlink";
import { ManagedCommandLifecycleActions } from "@/components/managed-commands/managed-command-lifecycle-actions";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import {
  useHostReachability,
  resolvedHostLabel,
} from "@/hooks/agent/use-host-reachability";
import { useBoundedHostLoad } from "@/hooks/host/use-bounded-host-load";
import { TileHostLoadState } from "@/components/epic-canvas/renderers/tile-host-load-state";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { ShellOutputAvailabilityNotice } from "@/components/managed-commands/shell-output-availability-notice";
import { useEffectiveTerminalFont } from "@/hooks/settings/use-effective-terminal-font";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";
import { useManagedCommandOutputSession } from "@/hooks/managed-command/use-managed-command-output-session";
import type {
  ManagedCommand,
  ManagedCommandCadence,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import type {
  ManagedCommandOutputStoreHandle,
  ManagedCommandTimelineLine,
} from "@/stores/managed-commands/managed-command-output-store";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import {
  createManagedCommandOutputFindAdapter,
  type ManagedCommandOutputFindMatch,
} from "./managed-command-output-find-adapter";
import {
  MANAGED_COMMAND_OUTPUT_WINDOW_TITLE,
  managedCommandStatusLabel,
} from "@/lib/managed-commands/managed-command-copy";
import {
  isShellOutputBanner,
  isShellOutputPanelReplacement,
  shellOutputHostAvailability,
  shellOutputStreamAvailability,
  type ShellOutputAvailability,
} from "@/lib/managed-commands/shell-output-availability";
import type { ManagedCommandOutputTileRef } from "@/stores/epics/canvas/types";
import { cn } from "@/lib/utils";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import {
  readReadingPosition,
  readingPositionIdentityForTileInstance,
  registerReadingPositionCapture,
  saveReadingPosition,
} from "@/lib/reading-position";

/**
 * How close to the newest line still counts as "following". A few pixels of
 * slack keeps sub-pixel scroll positions and a mid-flight append from reading
 * as the human deliberately scrolling away.
 */
const FOLLOW_SLACK_PX = 24;
/** Distance from the top that asks for the next page of older lines. */
const LOAD_OLDER_THRESHOLD_PX = 48;
const OUTPUT_VIRTUAL_OVERSCAN = 12;
const OUTPUT_VIRTUAL_INITIAL_RECT = { width: 0, height: 600 } as const;
// The terminal tiles' search decorations, so a hit looks the same on both
// surfaces. Both set a foreground as well as a fill: a match keeps its row's
// colour otherwise, and `text-destructive` on a stderr line over dark amber is
// barely readable.
const FIND_MATCH_STYLE = {
  backgroundColor: "#854d0e",
  color: "#fafaf9",
} as const;
const FIND_ACTIVE_MATCH_STYLE = {
  backgroundColor: "#facc15",
  color: "#1c1917",
} as const;

interface OutputRowFindMatch {
  readonly startCol: number;
  readonly length: number;
  readonly active: boolean;
}

interface FindPaint {
  readonly matchesBySeq: ReadonlyMap<number, readonly OutputRowFindMatch[]>;
}

const EMPTY_ROW_FIND_MATCHES: readonly OutputRowFindMatch[] = [];
const EMPTY_FIND_PAINT: FindPaint = {
  matchesBySeq: new Map<number, readonly OutputRowFindMatch[]>(),
};
/**
 * One test id for whatever the window has to say instead of (or over) the log;
 * the notice's `data-availability` carries WHICH state it is.
 */
const AVAILABILITY_NOTICE_TEST_ID = "managed-command-output-availability";

let nextManagedOutputSessionIdentity = 1;
const managedOutputSessionIdentityByStore = new WeakMap<object, string>();

function managedOutputSessionViewKey(
  tileInstanceId: string,
  store: object,
): string {
  const existing = managedOutputSessionIdentityByStore.get(store);
  if (existing !== undefined) return `${tileInstanceId}:${existing}`;
  const minted = `managed-output-session-${String(nextManagedOutputSessionIdentity)}`;
  nextManagedOutputSessionIdentity += 1;
  managedOutputSessionIdentityByStore.set(store, minted);
  return `${tileInstanceId}:${minted}`;
}

interface ManagedCommandReadingAnchor {
  readonly following: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

function isManagedCommandReadingAnchor(
  value: unknown,
): value is ManagedCommandReadingAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (
    !("following" in value) ||
    !("scrollTop" in value) ||
    !("scrollHeight" in value)
  ) {
    return false;
  }
  return (
    typeof value.following === "boolean" &&
    typeof value.scrollTop === "number" &&
    Number.isFinite(value.scrollTop) &&
    typeof value.scrollHeight === "number" &&
    Number.isFinite(value.scrollHeight)
  );
}

function initialManagedCommandFollowing(
  anchor: ManagedCommandReadingAnchor | null,
): boolean {
  return anchor === null ? true : anchor.following;
}

export interface ManagedCommandOutputTileProps {
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
}

/**
 * Three layers, because each one gates the hooks of the next: the host has to
 * be reachable before a stream is dialled, and the stream's store has to exist
 * before it can be read. Every layer answers with the same
 * `ShellOutputAvailability` vocabulary and the same notice, so the reader
 * cannot tell where the seam is - only which wait, or which ending, this is.
 */
export function ManagedCommandOutputTile(props: ManagedCommandOutputTileProps) {
  const { epicId, node } = props;
  const reachability = useHostReachability(node.hostId);
  // Same bounded, worded wait the terminal tiles get (audit S5): a bare
  // spinner said nothing about which host it was waiting on and had no end.
  const hostLoad = useBoundedHostLoad({
    hostId: node.hostId,
    hostLabel: resolvedHostLabel(reachability),
    pending:
      reachability.status === "checking" ||
      reachability.status === "host-starting",
  });
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    node.instanceId,
  );

  const hostGate = shellOutputHostAvailability(reachability);
  if (hostGate !== null) {
    return (
      <ShellOutputAvailabilityNotice
        availability={hostGate}
        onClose={closeCanvasTile}
        onReopen={null}
        className={undefined}
        testId={AVAILABILITY_NOTICE_TEST_ID}
      />
    );
  }
  // Below the availability gate, not instead of it: the gate answers for
  // the HOST (unreachable / starting, in the shared shell vocabulary); this
  // bounds the remaining load window so a reachable host's slow read can
  // never hold the tile on a bare skeleton (the F4 class).
  if (hostLoad.kind !== "ready") {
    return (
      <TileHostLoadState
        load={hostLoad}
        subject="shell-output"
        onRetry={null}
        testId="managed-command-output-load"
      />
    );
  }
  return (
    <ManagedCommandOutputTileLive
      epicId={epicId}
      node={node}
      viewTabId={props.viewTabId}
      onClose={closeCanvasTile}
    />
  );
}

function ManagedCommandOutputTileLive(props: {
  readonly epicId: string;
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly onClose: () => void;
}) {
  const { epicId, node } = props;
  const { session, reopen } = useManagedCommandOutputSession({
    epicId,
    commandId: node.id,
    hostId: node.hostId,
  });

  if (session === null) {
    return (
      <ShellOutputAvailabilityNotice
        availability={{ kind: "bootstrapping", phase: "opening-stream" }}
        onClose={props.onClose}
        onReopen={null}
        className={undefined}
        testId={AVAILABILITY_NOTICE_TEST_ID}
      />
    );
  }
  return (
    <ManagedCommandOutputTileBody
      epicId={epicId}
      node={node}
      viewTabId={props.viewTabId}
      onClose={props.onClose}
      onReopen={reopen}
      session={session}
    />
  );
}

function ManagedCommandOutputTileBody(props: {
  readonly epicId: string;
  readonly node: ManagedCommandOutputTileRef;
  readonly viewTabId: string;
  readonly onClose: () => void;
  readonly onReopen: () => void;
  readonly session: ManagedCommandOutputStoreHandle;
}) {
  const { epicId, node, session } = props;
  const store = session.store;
  const command = useStore(store, (state) => state.command);
  const lines = useStore(store, (state) => state.lines);
  const deleted = useStore(store, (state) => state.deleted);
  const fatalClose = useStore(store, (state) => state.fatalClose);
  const connectionStatus = useStore(store, (state) => state.connectionStatus);
  const reachedStart = useStore(store, (state) => state.reachedStart);
  const loadingOlder = useStore(store, (state) => state.loadingOlder);
  const detached = useStore(store, (state) => state.detached);
  const resyncPending = useStore(store, (state) => state.resyncPending);
  const newOutputAvailable = useStore(
    store,
    (state) => state.newOutputAvailable,
  );
  const timelineGeneration = useStore(
    store,
    (state) => state.timelineGeneration,
  );
  const loadOlder = useStore(store, (state) => state.loadOlder);
  const setOutputFollowing = useStore(store, (state) => state.setFollowing);
  // Asked of the client this window's own subscription rides on. The app-wide
  // reader answers for the DEFAULT host, and a tab is bound to its own host for
  // life - when the two differ, the default host's answer is about the wrong
  // machine, and this window would either call a capable host too old or take
  // an old host's refusal for a deletion.
  const streamSupport = useStreamMethodSupportFor(
    session.streamMethodSupport,
    "managedCommand.subscribeOutput",
  );
  const terminalFont = useEffectiveTerminalFont();
  const findAdapter = useMemo(
    () =>
      createManagedCommandOutputFindAdapter({
        tileInstanceId: node.instanceId,
      }),
    [node.instanceId],
  );
  useRegisterTileFindAdapter(findAdapter);
  const [findPaint, setFindPaint] = useState(EMPTY_FIND_PAINT);

  const visible = useTileBodyVisible();
  const readingIdentity = useMemo(
    () => ({
      ...readingPositionIdentityForTileInstance(node.instanceId),
      viewKey: managedOutputSessionViewKey(node.instanceId, store),
    }),
    [node.instanceId, store],
  );
  const restoredReadingAnchor = useMemo(
    () =>
      readReadingPosition(
        readingIdentity,
        "managed-command",
        isManagedCommandReadingAnchor,
      ),
    [readingIdentity],
  );
  const viewRef = useRef<HTMLDivElement>(null);
  const lastReadingAnchorRef = useRef<ManagedCommandReadingAnchor | null>(
    restoredReadingAnchor,
  );
  const restoredReadingPositionRef = useRef(false);
  const [following, setFollowing] = useState(() =>
    initialManagedCommandFollowing(restoredReadingAnchor),
  );
  const getScrollElement = useCallback(() => viewRef.current, []);
  const estimateOutputRowSize = useCallback(
    () => Math.ceil(terminalFont.fontSize * 1.5),
    [terminalFont.fontSize],
  );
  const getOutputRowKey = useCallback(
    (index: number) => lines[index]?.seq ?? index,
    [lines],
  );
  // `useVirtualizer` returns fresh function identities each render; the React
  // Compiler already treats the hook as incompatible, while this component's
  // own inputs and derived callbacks remain memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const outputVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement,
    estimateSize: estimateOutputRowSize,
    getItemKey: getOutputRowKey,
    overscan: OUTPUT_VIRTUAL_OVERSCAN,
    initialRect: OUTPUT_VIRTUAL_INITIAL_RECT,
    // The first snapshot scrolls to an estimated tail. Wrapped rows at that
    // tail are measured after the scroll and can grow the virtual document;
    // end anchoring carries that growth into scrollTop so the fresh window
    // stays live. This does not turn every focus into "jump to live": TanStack
    // applies the end correction only while the viewport is already at the
    // end, so a restored reader parked in history keeps their position.
    anchorTo: "end",
    // Row measurement can land while the follow/prepend layout effects are
    // committing. TanStack's synchronous default calls React `flushSync` from
    // that ResizeObserver path, which React rejects and which turns a burst of
    // output into repeated main-thread stalls. A normal scheduled rerender is
    // sufficient: the estimate is already the exact height for ordinary rows.
    useFlushSync: false,
  });
  const virtualRows = outputVirtualizer.getVirtualItems();
  const outputVirtualizerRef = useRef(outputVirtualizer);
  outputVirtualizerRef.current = outputVirtualizer;
  const lastTimelineGenerationRef = useRef(timelineGeneration);

  const scrollToNewest = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.scrollTop = view.scrollHeight;
  }, []);

  const setFollowMode = useCallback(
    (nextFollowing: boolean) => {
      setFollowing(nextFollowing);
      setOutputFollowing(nextFollowing);
    },
    [setOutputFollowing],
  );

  const revealMatch = useCallback(
    (match: ManagedCommandOutputFindMatch) => {
      // Follow pins the viewport to the tail; drop it before the jump or the
      // next append immediately undoes the scroll-to-match. Only ever reached
      // for a find command the human gave -- the adapter does not reveal on a
      // re-scan -- so this never takes a tailing reader off the live tail.
      setFollowMode(false);
      outputVirtualizerRef.current.scrollToIndex(match.lineIndex, {
        align: "center",
      });
    },
    [setFollowMode],
  );

  useEffect(() => {
    const syncPaint = (): void => {
      const snapshot = findAdapter.getSnapshot();
      setFindPaint(
        buildFindPaint(findAdapter.getMatches(), snapshot.current - 1),
      );
    };
    syncPaint();
    return findAdapter.subscribe(syncPaint);
  }, [findAdapter]);

  // Seed the store before any user scroll. A restored, scrolled-back reader
  // must keep their held history even if output lands immediately after mount.
  useLayoutEffect(() => {
    setOutputFollowing(following);
  }, [following, setOutputFollowing]);

  const captureReadingPosition = useCallback((): void => {
    const view = viewRef.current;
    const anchor =
      view !== null && view.clientHeight !== 0
        ? {
            following,
            scrollTop: view.scrollTop,
            scrollHeight: view.scrollHeight,
          }
        : lastReadingAnchorRef.current;
    if (anchor === null) return;
    lastReadingAnchorRef.current = anchor;
    saveReadingPosition(readingIdentity, "managed-command", anchor);
  }, [following, readingIdentity]);

  useLayoutEffect(
    () =>
      registerReadingPositionCapture({
        captureKey: node.instanceId,
        identity: readingIdentity,
        capture: captureReadingPosition,
      }),
    [captureReadingPosition, node.instanceId, readingIdentity],
  );

  useLayoutEffect(() => {
    if (!visible) {
      captureReadingPosition();
      restoredReadingPositionRef.current = false;
      return;
    }
    if (restoredReadingPositionRef.current || lines.length === 0) return;
    // Read again after a hidden interval: that path captures a newer anchor
    // without changing `readingIdentity`, so the mount seed can be stale.
    const anchor = readReadingPosition(
      readingIdentity,
      "managed-command",
      isManagedCommandReadingAnchor,
    );
    if (anchor === null || anchor.following) {
      restoredReadingPositionRef.current = true;
      return;
    }
    const view = viewRef.current;
    if (view === null || view.clientHeight === 0) return;
    const max = Math.max(0, view.scrollHeight - view.clientHeight);
    const proportional =
      anchor.scrollHeight <= 0
        ? 0
        : Math.round(
            (anchor.scrollTop / anchor.scrollHeight) * view.scrollHeight,
          );
    view.scrollTop =
      anchor.scrollTop <= max ? anchor.scrollTop : Math.min(proportional, max);
    restoredReadingPositionRef.current = true;
  }, [captureReadingPosition, lines.length, readingIdentity, visible]);

  // The first snapshot participates in reading-position restore. Every later
  // snapshot is a deliberate rebase (resnapshot or reconnect), so it restores
  // the live latch and pins the replacement tail before paint.
  useLayoutEffect(() => {
    const previousGeneration = lastTimelineGenerationRef.current;
    if (timelineGeneration === previousGeneration) return;
    lastTimelineGenerationRef.current = timelineGeneration;
    if (previousGeneration === 0) return;
    setFollowMode(true);
    scrollToNewest();
  }, [scrollToNewest, setFollowMode, timelineGeneration]);

  // Following is a scroll effect, not render state: new lines land, then the
  // view is pinned back to the bottom.
  useEffect(() => {
    if (!following || resyncPending) return;
    scrollToNewest();
  }, [following, lines, resyncPending, scrollToNewest]);

  // A Terminal typography change resizes every row at once. Re-pin before
  // paint instead of leaving a tailing reader somewhere they did not scroll to.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (following && !resyncPending) view.scrollTop = view.scrollHeight;
  }, [
    following,
    resyncPending,
    terminalFont.fontFamily,
    terminalFont.fontSize,
  ]);

  const onScroll = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (resyncPending) return;
    const distanceFromBottom =
      view.scrollHeight - view.scrollTop - view.clientHeight;
    const nextFollowing = distanceFromBottom <= FOLLOW_SLACK_PX;
    setFollowMode(nextFollowing);
    const nextAnchor = {
      following: nextFollowing,
      scrollTop: view.scrollTop,
      scrollHeight: view.scrollHeight,
    };
    lastReadingAnchorRef.current = nextAnchor;
    saveReadingPosition(readingIdentity, "managed-command", nextAnchor);
    if (view.scrollTop <= LOAD_OLDER_THRESHOLD_PX) {
      loadOlder();
    }
  }, [loadOlder, readingIdentity, resyncPending, setFollowMode]);

  const onTimelineKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "Home" && event.key !== "End")
      ) {
        return;
      }
      event.preventDefault();
      event.currentTarget.scrollTop =
        event.key === "Home" ? 0 : event.currentTarget.scrollHeight;
      // Programmatic scrolling emits a browser scroll event, but applying the
      // latch synchronously keeps Home/End deterministic and makes returning
      // to a detached live tail request its resnapshot immediately.
      onScroll();
    },
    [onScroll],
  );

  // Derived here, after the scroll machinery above, and read only by the JSX
  // below: what the window shows is a pure function of the store's signals
  // and the bound host's capability, computed once per render.
  const availability = shellOutputStreamAvailability({
    streamSupport,
    connectionStatus,
    snapshotArrived: command !== null,
    hasLines: lines.length > 0,
    deleted,
    fatalClose,
  });
  const findAvailable = managedCommandOutputFindAvailability(availability);

  useEffect(() => {
    findAdapter.updateEnvironment({
      lines,
      available: findAvailable,
      reachedStart,
      detached,
      revealMatch,
    });
  }, [detached, findAdapter, findAvailable, lines, reachedStart, revealMatch]);

  let jumpLiveLabel = "Jump to live";
  if (newOutputAvailable) jumpLiveLabel = "New output available";
  if (resyncPending) jumpLiveLabel = "Loading live output…";

  // A terminal state, or a host that cannot serve the stream: the panel is the
  // sentence, and nothing of the log survives under it. Whatever this window
  // had read is not the history any more - the host destroyed or withdrew
  // that - and a ghost of it contradicted every other surface's account of a
  // deleted shell.
  if (isShellOutputPanelReplacement(availability)) {
    return (
      <ShellOutputAvailabilityNotice
        availability={availability}
        onClose={props.onClose}
        onReopen={props.onReopen}
        className={undefined}
        testId={AVAILABILITY_NOTICE_TEST_ID}
      />
    );
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-canvas">
      {isShellOutputBanner(availability) ? (
        <ShellOutputAvailabilityNotice
          availability={availability}
          onClose={props.onClose}
          onReopen={props.onReopen}
          testId={AVAILABILITY_NOTICE_TEST_ID}
          className="border-b border-border/60 px-3"
        />
      ) : null}

      <div className="relative min-h-0 flex-1">
        {/*
         * Present whenever a snapshot has said what this shell is - including
         * under a failed stream. Process status and stream status are two
         * different facts: a broken output stream must never hide Stop for a
         * process that is still running.
         */}
        {command === null ? null : (
          <>
            {/*
             * The fade the floating cluster is legible against. Sits under the
             * cluster and over the log, and is painted in the tile's own
             * surface token so every preset theme dissolves scrolling text
             * into its own background rather than into a grey of ours.
             */}
            <div
              aria-hidden
              data-testid="managed-command-output-scrim"
              className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-13 bg-linear-to-b from-canvas/95 via-canvas/75 via-45% to-canvas/0"
            />
            <ManagedCommandOutputControls
              command={command}
              epicId={epicId}
              hostId={node.hostId}
              viewTabId={props.viewTabId}
            />
          </>
        )}
        <div
          ref={viewRef}
          onScroll={onScroll}
          onKeyDown={onTimelineKeyDown}
          tabIndex={0}
          data-testid="managed-command-output-timeline"
          role="textbox"
          aria-readonly="true"
          aria-multiline="true"
          aria-live="polite"
          aria-label={
            command === null ? "Output" : MANAGED_COMMAND_OUTPUT_WINDOW_TITLE
          }
          // Command output is terminal output, so it follows the Terminal
          // typography settings the way a terminal tile does. `font-mono` and
          // the `text-*` scales would silently track the Code font instead,
          // leaving a Terminal override with no effect on the one surface
          // whose whole content is a program's stdout. Colours stay the log
          // view's own (stderr tint, lifecycle rows).
          style={{
            fontFamily: terminalFont.fontFamily,
            fontSize: `${terminalFont.fontSize}px`,
          }}
          // The log keeps the full width of the pane. The cluster used to buy
          // its clearance with a reserved right lane, which cost every line a
          // share of the width for a collision that only ever happens in the
          // top row - and cost most on a split pane, where the log is already
          // narrow. Clearance is bought vertically instead: the log starts
          // below the cluster, so nothing is under it at rest, and a line
          // scrolled up dissolves into the scrim rather than colliding with
          // the label. Only the flow of the log moves; the cluster is still
          // lifted out of it.
          className={cn(
            "h-full w-full overflow-y-auto px-3 leading-relaxed focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
            command === null ? "py-2" : "pt-9.5 pb-2",
          )}
        >
          {loadingOlder ? (
            <div className="flex justify-center py-1">
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="managed-command-output-loading-older"
                variant={undefined}
              />
            </div>
          ) : null}
          {reachedStart && lines.length > 0 ? (
            <p className="py-1 text-center text-muted-foreground/60">
              Start of the retained log
            </p>
          ) : null}
          {/*
           * An opened, empty log says so. Blank, it was indistinguishable from
           * a stream that never connected.
           */}
          {availability.kind === "empty" ? (
            <ShellOutputAvailabilityNotice
              availability={availability}
              onClose={props.onClose}
              onReopen={props.onReopen}
              className={undefined}
              testId={AVAILABILITY_NOTICE_TEST_ID}
            />
          ) : null}
          {lines.length === 0 ? null : (
            <div
              data-testid="managed-command-output-virtual-list"
              className="relative w-full"
              style={{ height: `${outputVirtualizer.getTotalSize()}px` }}
            >
              {virtualRows.map((virtualRow) => {
                const line = lines[virtualRow.index];
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={outputVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <OutputRow
                      line={line}
                      matches={
                        findPaint.matchesBySeq.get(line.seq) ??
                        EMPTY_ROW_FIND_MATCHES
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {following && !resyncPending ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid="managed-command-output-jump-live"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
            disabled={resyncPending}
            onClick={() => {
              setFollowMode(true);
              if (!detached) scrollToNewest();
            }}
          >
            <ArrowDownToLine aria-hidden className="size-3.5" />
            {jumpLiveLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The window's whole chrome, floating over the log's top-right corner instead
 * of sitting in a bar above it.
 *
 * The bar this replaces spent a permanent row of every shell window restating
 * what the TAB beside it already said - the same glyph, the same
 * "Monitor · deploy watcher" - so the log, which is the only thing here a
 * person came to read, started one line lower for nothing. Identity lives in
 * the tab; what stays is the pair of facts the tab cannot carry: what the shell
 * is doing right now, and the two verbs that change it.
 *
 * Bare text and icons - no card, no border, no fill. A box here read as chrome
 * pasted onto the log; without one the pair of facts sits in the window's air.
 * What makes that legible is not this component: the log's own top fade
 * (rendered beside it, one layer below) is what the label is read against, and
 * the log starting below this row is what keeps a line from ever resting under
 * it. Neither can be removed without giving the box back. The buttons keep
 * their ghost hover fill, which is now the only affordance saying they are
 * pressable.
 */
function ManagedCommandOutputControls(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string;
}) {
  return (
    <div className="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-0.5">
      {/*
       * Stays pointer-transparent: it is a readout, and it sits permanently
       * over a corner of a scrollable log, so a wheel turn there has to reach
       * the log rather than land on a label that cannot do anything with it.
       */}
      <span
        className="flex shrink-0 items-center gap-1.5 px-1.5 py-1 text-ui-xs text-foreground/85"
        data-testid="managed-command-output-status"
      >
        <ManagedCommandStatusDot
          status={props.command.status}
          className={undefined}
        />
        {managedCommandStatusLabel(props.command.status)}
      </span>
      <span className="pointer-events-auto flex shrink-0 items-center">
        <ManagedCommandOutputDetails
          command={props.command}
          epicId={props.epicId}
          hostId={props.hostId}
          viewTabId={props.viewTabId}
        />
        <ManagedCommandLifecycleActions
          command={props.command}
          epicId={props.epicId}
          hostId={props.hostId}
          className={undefined}
        />
      </span>
    </div>
  );
}

/**
 * Everything about this shell that is not its output, one click away.
 *
 * The window used to answer "what exactly is this running, and where?" with
 * nothing at all - you went to the agent's transcript and found the tool call.
 * That is the surface refusing to say what it plainly knows, and it is the
 * question a person reading a log at 3am actually has.
 *
 * Every field here is CURRENT, not historical, and says so. The retained log
 * spans every run of this shell, and a restart can re-spec both the command and
 * its directory - so these describe the shell as it stands now rather than
 * whatever produced the lines being read. The transcript's start card is the
 * other half of that pair: it holds the command the creating call asked for,
 * frozen.
 */
function ManagedCommandOutputDetails(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string;
}) {
  const { command } = props;
  const pid = command.status.state === "running" ? command.status.pid : null;
  return (
    <Popover>
      <TooltipWrapper
        label="Details"
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Shell details"
            data-testid="managed-command-output-details"
            className="size-6 text-muted-foreground hover:text-foreground"
          >
            <Info aria-hidden className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-[min(90vw,26rem)] p-3 text-ui-xs"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          <DetailRow label="Command">
            {/* Wrapping, not truncated: a shell command is the one value here
                worth reading in full, and it is the reason someone opened this.
                Copyable for the "run it myself" move. */}
            <span className="flex items-start gap-1">
              <span
                className="min-w-0 font-mono wrap-anywhere"
                data-testid="managed-command-output-details-command"
              >
                {command.command ?? "—"}
              </span>
              {command.command === null ? null : (
                <SegmentCopyButton
                  value={command.command}
                  ariaLabel="Copy command"
                  className={undefined}
                />
              )}
            </span>
          </DetailRow>
          <DetailRow label="Directory">
            <span className="font-mono wrap-anywhere">
              {command.cwd ?? "—"}
            </span>
          </DetailRow>
          {/* Only while it runs: a pid outlives nothing, and a stale one points
              at whatever the OS handed out next. */}
          {pid === null ? null : (
            <DetailRow label="PID">
              <span className="font-mono tabular-nums">{pid}</span>
            </DetailRow>
          )}
          {command.cadence === null ? null : (
            <DetailRow label="Notifies">
              <span data-testid="managed-command-output-details-cadence">
                {managedCommandCadenceSentence(command.cadence)}
              </span>
            </DetailRow>
          )}
          <DetailRow label="Started by">
            <ManagedCommandChatBacklink
              epicId={props.epicId}
              tabId={props.viewTabId}
              chatId={command.chatId}
              fallbackHostId={props.hostId}
              testId="managed-command-output-backlink"
              className={undefined}
            />
          </DetailRow>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function DetailRow(props: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 text-foreground/90">{props.children}</dd>
    </>
  );
}

/**
 * The pacing in one short line. Whoever opened this popover already knows what
 * a monitor is; each number gets a one-word tag and no more, so the row reads
 * at a glance instead of as a paragraph.
 */
function managedCommandCadenceSentence(cadence: ManagedCommandCadence): string {
  const duration = (ms: number): string =>
    ms % 1000 === 0 ? `${(ms / 1000).toString()}s` : `${ms.toString()}ms`;
  return `On output · ${duration(cadence.debounceMs)} quiet · ${duration(cadence.maxWaitMs)} max wait · ${duration(cadence.throttleMs)} min gap`;
}

const CHANNEL_CLASS = {
  stdout: "text-foreground",
  stderr: "text-destructive",
  lifecycle: "text-muted-foreground italic",
} as const;

const OutputRow = memo(function OutputRow(props: {
  readonly line: ManagedCommandTimelineLine;
  readonly matches: readonly OutputRowFindMatch[];
}) {
  const { line, matches } = props;
  return (
    <div
      data-testid={`managed-command-output-line-${line.seq}`}
      data-channel={line.channel}
      className="flex min-w-0 gap-2"
    >
      <span
        data-testid={`managed-command-output-time-${line.seq}`}
        className="shrink-0 tabular-nums text-muted-foreground/60"
      >
        {formatLineTime(line.atMs)}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere",
          CHANNEL_CLASS[line.channel],
        )}
      >
        <OutputLineText text={line.text} matches={matches} />
      </span>
    </div>
  );
});

function OutputLineText(props: {
  readonly text: string;
  readonly matches: readonly OutputRowFindMatch[];
}): ReactNode {
  const { text, matches } = props;
  if (matches.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.startCol > cursor) {
      parts.push(text.slice(cursor, match.startCol));
    }
    const end = match.startCol + match.length;
    parts.push(
      <span
        key={match.startCol}
        data-testid={
          match.active
            ? "managed-command-output-find-match-active"
            : "managed-command-output-find-match"
        }
        data-start-col={match.startCol}
        style={match.active ? FIND_ACTIVE_MATCH_STYLE : FIND_MATCH_STYLE}
      >
        {text.slice(match.startCol, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

function buildFindPaint(
  matches: readonly ManagedCommandOutputFindMatch[],
  activeIndex: number,
): FindPaint {
  if (matches.length === 0) return EMPTY_FIND_PAINT;
  const matchesBySeq = new Map<number, OutputRowFindMatch[]>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const rowMatches = matchesBySeq.get(match.seq) ?? [];
    rowMatches.push({
      startCol: match.startCol,
      length: match.length,
      active: index === activeIndex,
    });
    matchesBySeq.set(match.seq, rowMatches);
  }
  return { matchesBySeq };
}

function managedCommandOutputFindAvailability(
  availability: ShellOutputAvailability,
): boolean | string {
  if (!isShellOutputPanelReplacement(availability)) return true;
  switch (availability.kind) {
    case "bootstrapping":
      return "Output is still loading.";
    case "gone":
      return "This shell is no longer available.";
    case "unauthorized":
      return "You no longer have access to this shell.";
    case "unsupported-host":
      return "This host cannot serve shell output.";
    case "unreachable-host":
      return "The host is unreachable.";
  }
}

/**
 * Wall-clock time of day, seconds included: a human reading a shell at 3am is
 * matching lines against something else that happened, and the date is already
 * carried by the window they are in. `null` is a line the host could not read a
 * timestamp from - a partial record left by a crash.
 *
 * 24-hour regardless of locale, like every other log this one is read beside:
 * a fixed-width column of eight characters instead of a locale's eleven, in a
 * gutter that repeats on every line of the pane.
 */
function formatLineTime(atMs: number | null): string {
  if (atMs === null) return "--:--:--";
  return new Date(atMs).toLocaleTimeString(undefined, {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
