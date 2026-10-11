import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  ChatRowSnapshot,
  ChatRowListEntry,
} from "@/stores/chats/chat-row-store";
import { ChatRowStoreContext } from "./chat-row-presentation";
import { useReadingWidthStyle } from "@/lib/layout-overrides";
import {
  createContext,
  memo,
  use,
  useCallback,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  LegendList,
  type LegendListRef,
  type MaintainVisibleContentPositionConfig,
  type OnViewableItemsChangedInfo,
} from "@legendapp/list/react";
import { cn } from "@/lib/utils";
import { ChatPrewarmContext } from "@/lib/registries/chat-prewarm";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import {
  ChatMessage,
  type ChatMessageActions,
} from "@/components/chat/chat-message";
import {
  CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
  NavigationHighlightStoreContext,
  useNavigationHighlightStore,
  useRowNavigationHighlight,
} from "@/components/chat/chat-navigation-highlight";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { chatTimelineGetItemType } from "@/components/chat/chat-messages-scroll-helpers";
import { registerPanelResizeParticipant } from "@/lib/layout/panel-resizing-class";
import {
  captureChatTimelineVisibleRows,
  clearChatTimelineVisibleRows,
} from "@/components/chat/chat-timeline-panel-resize-snapshot";
import { useFullscreenPinnedRowKeys } from "@/lib/sandbox/overlay-owner";
import { ChatTranscriptPlaceholderRow } from "./chat-transcript-placeholder-row";
import type { ChatTranscriptRowHeightMemory } from "./chat-transcript-row-height-memory";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import {
  useChatTimelineFollowLatch,
  type ChatTimelineFollowLatch,
  type ChatTimelineReaderGestureIntent,
} from "./chat-timeline-follow-latch";

/**
 * Shared, closure-free row context. Row components read business-logic
 * callbacks from context instead of a per-item closure, so `renderItem`
 * stays referentially stable and LegendList's own memo boundary is never
 * invalidated by it.
 *
 * Navigation highlight is NOT in this object: a shared context value would
 * re-render every mounted row on a highlight move. Rows subscribe to
 * {@link NavigationHighlightStoreContext} with a per-row selector instead.
 */
interface ChatTimelineRowSharedState {
  readonly taskTitle: string;
  readonly backgroundToolBlockIds: ReadonlySet<string>;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler | null;
  readonly onRowMount: ((messageId: string) => void) | undefined;
}

const ChatTimelineRowCtx = createContext<ChatTimelineRowSharedState | null>(
  null,
);

/** decision #5: "isNearEnd (library default 10% threshold)". */
const CHAT_TIMELINE_NEAR_END_THRESHOLD = 0.1;

/** The two configurations the timeline alternates between, at module scope so
 *  each keeps one identity and a commit that does not move between them hands
 *  the list the same object. See the prop itself for what selects which. */
const CHAT_TIMELINE_MVCP_SIZE_ONLY: MaintainVisibleContentPositionConfig<TimelineItem> =
  { data: false, size: true };
const CHAT_TIMELINE_MVCP_WITH_DATA: MaintainVisibleContentPositionConfig<TimelineItem> =
  { data: true, size: true };

/** Both arms are pinned by the prop-capture cases in `chat-timeline.test.tsx`,
 *  which observe what the list actually received rather than calling this. */
function resolveChatTimelineMvcp(
  keySequenceChanged: boolean,
): MaintainVisibleContentPositionConfig<TimelineItem> {
  return keySequenceChanged
    ? CHAT_TIMELINE_MVCP_WITH_DATA
    : CHAT_TIMELINE_MVCP_SIZE_ONLY;
}

// M4 (ticket 16 spacer alignment): the old 40px header/footer were
// unsanctioned drift (decision log #30).
// Consumers read the live measured size via `onListMetricsChange`, so they
// adapt automatically; nothing here is a hardcoded assumption elsewhere.
const CHAT_TIMELINE_LIST_HEADER = (
  <div aria-hidden="true" className="h-3 sm:h-4" />
);
const CHAT_TIMELINE_LIST_FOOTER = (
  <div aria-hidden="true" className="h-3 sm:h-4" />
);

/** Ticket 5: LegendList's own `initialScrollIndex` shape - a row index plus
 *  the exact pixel offset/anchoring edge to bootstrap-scroll to. */
export interface ChatTimelineInitialScrollAnchor {
  readonly index: number;
  readonly viewOffset: number;
  readonly viewPosition: number;
}

/**
 * The part of LegendList's `onItemSizeChanged` payload this component reads.
 * Declared locally because the library types it inline on the prop rather than
 * exporting it; a narrower parameter is assignable to the wider callback.
 */
type TimelineItem = TranscriptListRow | ChatRowListEntry;

interface ChatTimelineItemSizeInfo {
  readonly size: number;
  readonly itemData: TimelineItem;
}

export interface ChatTimelineProps {
  /**
   * The rows to draw, hydrated bodies and placeholders together.
   *
   * A full-length list on the windowed line: `transcriptListRows` fills every
   * ordinal the window says exists, so scrolling reaches the top of the CHAT
   * rather than the top of what happens to be loaded. On the legacy line every
   * row is hydrated and this is just the rendered messages.
   */
  readonly rows: ReadonlyArray<TranscriptListRow>;
  readonly visible: boolean;
  /**
   * Which ROW indexes the viewport is showing, from LegendList's viewability
   * pass - `[fromIndex, toIndex)` over `rows`, buffered by the list's render
   * window so hydration modestly prefetches around the reading line. The
   * windowed line turns this into ordinal-range hydration requests; on the
   * legacy line the ranges resolve to no ordinals and the report is inert.
   */
  readonly onVisibleRowRangeChange?: (
    fromIndex: number,
    toIndex: number,
  ) => void;
  readonly taskTitle: string;
  readonly backgroundToolBlockIds: ReadonlySet<string>;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler | null;
  /** Imperative handle for a future controller (scrollToIndex, getState). */
  readonly listRef: RefObject<LegendListRef | null>;
  readonly onScroll?: () => void;
  readonly className?: string;
  readonly "data-testid"?: string;
  /** Test-observability only: echoes the controller's current follow-vs-free
   *  scroll state. Not read by any production code. */
  readonly "data-scroll-mode"?: string;
  /** Top-fade chrome; the scroll-policy ticket decides when it's on. */
  /**
   * Whether the initial mount parks at the tail: `true` for a fresh,
   * never-scrolled-in chat with no saved reading position. The controller
   * passes `false` when restoring a tab whose saved reading position was NOT
   * the tail, so the initial DOM position does not contradict the restored
   * position; `initialScrollIndex` below carries the exact row-level restore.
   */
  readonly initialScrollAtEnd?: boolean;
  /**
   * Restored row bootstrap, passed straight through as LegendList's own
   * `initialScrollIndex`: the saved pixel offset, self-correcting as
   * variable-height rows are measured. `null` for the ordinary
   * fresh-open/no-restore case.
   */
  readonly initialScrollIndex?: ChatTimelineInitialScrollAnchor | null;
  /** Composer + queued-surface overlay height, reserved as bottom content inset. */
  readonly contentInsetEndAdjustment?: number;
  readonly onFollowIntentChange?: (isFollowing: boolean) => void;
  readonly onReaderGesture?: (intent: ChatTimelineReaderGestureIntent) => void;
  /** Controller bridge for explicit reader/navigation ownership changes. */
  readonly followLatchRef?: RefObject<ChatTimelineFollowLatch | null>;
  /** Explicit bootstrap/restoration ownership gate for automatic correction. */
  readonly isFollowCorrectionSuppressed?: () => boolean;
  /** Releases that gate only for a controller-validated reader end landing. */
  readonly resolveSuppressedEndLanding?: () => boolean;
  /** Message row receiving the temporary external-navigation highlight. */
  readonly navigationHighlightedMessageId?: string | null;
  /**
   * Card inside that row to flash instead of the whole message. `null` (or
   * omitted) paints the row, which is correct for delivered A2A, user prompts,
   * and event rows.
   */
  readonly navigationHighlightedBlockId?: string | null;
  /**
   * Where this transcript's measured row heights are kept, so a placeholder for
   * a row the list has already drawn stands at the height that row really
   * takes. `null` on the legacy line, which holds every body and never draws a
   * placeholder at all.
   */
  readonly rowHeightMemory?: ChatTranscriptRowHeightMemory | null;
  /** Notifies presentational consumers after LegendList remeasures any row. */
  readonly onItemSizeChanged?: () => void;
  /** Fires for every mounted virtual row, including cached equal-size rows. */
  readonly onRowMount?: (messageId: string) => void;
  /**
   * Ticket 5: LegendList's measured header/footer sizes. The free-scrolling
   * save path needs `headerSize` as the top-offset adjustment that
   * `initialScrollIndex` / `scrollToIndex` re-add on restore (decision #18
   * exact-pixel contract) - `positionAtIndex` is content-relative and does
   * not include it.
   */
  readonly onListMetricsChange?: (metrics: {
    readonly headerSize: number;
    readonly footerSize: number;
  }) => void;
}

/**
 * LegendList-owned chat transcript. Renders our existing `ChatMessage` rows
 * unchanged. Bottom-follow is a strict 1px edge, owned by
 * `useChatTimelineFollowLatch` (see that module) rather than LegendList's
 * own `maintainScrollAtEnd`, which this component never enables.
 * `maintainVisibleContentPosition` stays on unconditionally, but only on its
 * SIZE channel - it keeps an already-detached reader's view pixel-stable
 * against unrelated growth, which never pulls toward the tail. See the prop
 * itself for why the data channel is off. There is no app-owned scroll mode
 * here.
 */
export const ChatTimeline = memo(function ChatTimeline({
  rows: inputRows,
  visible,
  onVisibleRowRangeChange,
  taskTitle,
  backgroundToolBlockIds,
  getMessageActions,
  nextStepActions,
  listRef,
  onScroll,
  className,
  initialScrollAtEnd = true,
  initialScrollIndex = null,
  contentInsetEndAdjustment = 0,
  onFollowIntentChange,
  onReaderGesture,
  followLatchRef,
  isFollowCorrectionSuppressed,
  resolveSuppressedEndLanding,
  navigationHighlightedMessageId,
  navigationHighlightedBlockId,
  rowHeightMemory = null,
  onItemSizeChanged,
  onRowMount,
  onListMetricsChange,
  ...rest
}: ChatTimelineProps) {
  const prewarmEligible = use(ChatPrewarmContext);
  const rowsVisible = visible || prewarmEligible;
  const { frozenRows, keySequenceChanged } = useCommittedTimelineRows(
    inputRows,
    rowsVisible,
  );
  const rowStore = use(ChatRowStoreContext);
  const readListEntries = useCallback(
    () => rowStore?.getState().listEntries ?? null,
    [rowStore],
  );
  const listEntries = useSyncExternalStore(
    rowStore?.subscribe ?? noRowSubscription,
    readListEntries,
    readListEntries,
  );
  // Inline editing may retain an original row after the source removes it.
  const visibleRows =
    listEntries !== null && listEntries.length === inputRows.length
      ? listEntries
      : inputRows;
  const rows: ReadonlyArray<TimelineItem> = rowsVisible
    ? visibleRows
    : frozenRows;

  // Fixup (fix-detached-streaming-yank/callback-synchronous-follow): see the
  // hook's own doc comment. Bottom-follow is owned entirely here now -
  // LegendList's own `maintainScrollAtEnd` is never passed at all below.
  const followLatch = useChatTimelineFollowLatch(
    listRef,
    initialScrollAtEnd,
    rows.length > 0,
    {
      onFollowIntentChange,
      onReaderGesture,
      isCorrectionSuppressed: isFollowCorrectionSuppressed,
      resolveSuppressedEndLanding,
    },
  );

  useLayoutEffect(() => {
    if (!followLatchRef) return;
    followLatchRef.current = followLatch;
    return () => {
      followLatchRef.current = null;
    };
  }, [followLatch, followLatchRef]);

  // A row whose MCP App is fullscreen stays mounted wherever the list scrolls:
  // unmounting it would destroy the app's document (`overlay-owner.ts`).
  const pinnedRowKeys = useFullscreenPinnedRowKeys();
  const alwaysRender = useMemo(
    () =>
      pinnedRowKeys.length === 0 ? undefined : { keys: [...pinnedRowKeys] },
    [pinnedRowKeys],
  );

  const navigationHighlightStore = useNavigationHighlightStore(
    navigationHighlightedMessageId,
    navigationHighlightedBlockId,
  );

  const sharedState = useMemo<ChatTimelineRowSharedState>(
    () => ({
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      onRowMount,
    }),
    [
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      onRowMount,
    ],
  );

  // `endBuffered` is the last BUFFERED index, inclusive; the consumer takes
  // an end-exclusive range. Reported from the buffered bounds rather than the
  // strictly-visible ones so hydration warms the rows the list is about to
  // mount, not only the ones already on screen.
  const viewabilityRef = useRef({ visible, onVisibleRowRangeChange });
  // LegendList can call its previous callback during a new-data layout pass.
  useInsertionEffect(() => {
    viewabilityRef.current = { visible, onVisibleRowRangeChange };
  }, [visible, onVisibleRowRangeChange]);
  const handleViewableItemsChanged = useCallback(
    (info: OnViewableItemsChangedInfo<TimelineItem>): void => {
      const current = viewabilityRef.current;
      if (!current.visible) return;
      current.onVisibleRowRangeChange?.(
        info.startBuffered,
        info.endBuffered + 1,
      );
    },
    [],
  );

  // Stable renderItem: `rowHeightMemory` is a mount-lifetime object, not a
  // value that changes as rows are measured, so naming it as a dep does not
  // cost the identity this callback is kept stable for. ChatTimelineRow reads
  // shared state from ChatTimelineRowCtx, which propagates through
  // LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) =>
      item.kind === "placeholder" ? (
        <ChatTranscriptPlaceholderRow
          entry={item.entry}
          ordinal={item.ordinal}
          heightMemory={rowHeightMemory}
        />
      ) : (
        <SubscribedChatTimelineRow
          store={rowStore}
          rowId={item.key}
          fallback={item.kind === "hydrated" ? item.model : null}
          visible={rowsVisible}
        />
      ),
    [rowHeightMemory, rowStore, rowsVisible],
  );

  const handleScroll = useCallback(() => {
    followLatch.observeLiveGeometry();
    onScroll?.();
  }, [followLatch, onScroll]);

  // Fixup (callback-synchronous-follow): item-layout and footer/header-
  // layout are two of the real LegendList maintain triggers that never
  // re-enter this component's render - consult the latch right here, at the
  // actual callback boundary, not through a prop the library reads later.
  const handleItemSizeChanged = useCallback(
    (info: ChatTimelineItemSizeInfo) => {
      // Only a HYDRATED row's measurement says anything true about how tall
      // that row is. A placeholder measures at whatever height the memory just
      // told it to stand at, so recording one would be the memory reading its
      // own estimate back in as evidence for that estimate.
      if (rowHeightMemory !== null && info.itemData.kind !== "placeholder") {
        rowHeightMemory.recordMeasuredHeight({
          rowId: info.itemData.key,
          ordinal: info.itemData.ordinal,
          height: info.size,
        });
      }
      followLatch.followEndIfPermitted();
      onItemSizeChanged?.();
    },
    [followLatch, onItemSizeChanged, rowHeightMemory],
  );

  const handleMetricsChange = useCallback(
    (metrics: { readonly headerSize: number; readonly footerSize: number }) => {
      followLatch.followEndIfPermitted();
      onListMetricsChange?.(metrics);
    },
    [followLatch, onListMetricsChange],
  );

  // Fixup (callback-synchronous-follow): the data-change and content-inset
  // maintain triggers DO go through a React commit (both are props), so a
  // layout effect - synchronous, before paint - is the right boundary for
  // them; the viewport-layout trigger has its own ResizeObserver inside the
  // latch hook itself, since no prop change accompanies a pure container
  // resize.
  useLayoutEffect(() => {
    followLatch.followEndIfPermitted();
  }, [rows, contentInsetEndAdjustment, followLatch]);

  // Ticket 23 (D20 port): registers this mounted timeline as a panel-resize
  // participant so a divider drag's capture pass (see
  // `lib/layout/panel-resizing-class.ts`) can mark ITS OWN currently visible
  // rows right before the freeze class lands - see `ChatTimelineRow`'s own
  // doc comment for the freeze mechanism. `useLayoutEffect`, not `useEffect`:
  // registration must be live before the browser can paint a state where a
  // drag could start. Cleared defensively on unmount (in addition to
  // unregistering) even though the unmounted DOM is about to be discarded
  // anyway - matches the ticket's explicit "cleared ... at end/unmount"
  // contract.
  useLayoutEffect(() => {
    const capture = (): void => {
      const node = listRef.current?.getScrollableNode();
      if (node) captureChatTimelineVisibleRows(node);
    };
    const clear = (): void => {
      const node = listRef.current?.getScrollableNode();
      if (node) clearChatTimelineVisibleRows(node);
    };
    const unregister = registerPanelResizeParticipant({ capture, clear });
    return () => {
      clear();
      unregister();
    };
  }, [listRef]);

  if (rows.length === 0) {
    return <ChatEmptyState />;
  }

  return (
    <NavigationHighlightStoreContext value={navigationHighlightStore}>
      <ChatTimelineRowCtx value={sharedState}>
        <LegendList<TimelineItem>
          ref={listRef}
          data={rows}
          keyExtractor={chatTimelineKeyExtractor}
          getItemType={timelineItemType}
          renderItem={renderItem}
          estimatedItemSize={90}
          alwaysRender={alwaysRender}
          // Keep LegendList's proximity threshold explicit for onEndReached and
          // presentation consumers. Follow ownership deliberately reads only
          // fresh DOM geometry inside the latch; this 10% band can never
          // re-attach a detached reader.
          onEndReachedThreshold={CHAT_TIMELINE_NEAR_END_THRESHOLD}
          initialScrollAtEnd={initialScrollAtEnd}
          initialScrollIndex={initialScrollIndex ?? undefined}
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          // Fixup (callback-synchronous-follow): the library's own
          // `maintainScrollAtEnd` is never passed - every one of its internal
          // call sites (data/item/footer/layout) no-ops when this prop is
          // falsy, so leaving it unset makes them categorically unreachable.
          // Bottom-follow is reimplemented in `chat-timeline-follow-latch.ts`
          // and driven imperatively from the callbacks below instead - see
          // that module's doc comment for why the library's own cached
          // threshold could not be trusted, render-gated or not.
          //
          // The explicit zero still narrows `isWithinMaintainScrollAtEndThreshold`
          // (used internally by the library's own content-inset compensation)
          // to `distanceFromEnd <= 0` rather than its 10%-of-viewport default.
          // The separate `isAtEnd` calculation owns the 1px edge tolerance.
          maintainScrollAtEndThreshold={0}
          // SIZE is always on: it keeps a detached reader pixel-stable when
          // content above the viewport changes HEIGHT - a nested chain-open in
          // find, a row remeasuring above the reader.
          //
          // DATA rides the key sequence, because the two things it is asked to
          // tell apart arrive on the same signal. The library treats any row
          // object it cannot prove equal as a structural data change, and while
          // that channel is on it arms an MVCP anchor lock on every such pass.
          // A held lock stops the library recalculating item positions inline
          // and defers them to an animation frame; a row that grows is laid out
          // by the browser immediately while the offsets of the rows after it
          // are only rewritten a frame later, so the frame in between paints
          // those rows inside the grown row's band. A streaming reply hands over
          // a changed array on every token, well inside the lock's 300ms expiry,
          // so leaving DATA on holds that lock - and that overlap - for the
          // whole stream.
          //
          // The rows themselves distinguish the two: a streaming token changes a
          // row's CONTENT in place, while an insert, a removal, or a move
          // changes the sequence of row KEYS. Only structural changes need the
          // data anchor lock, so that channel is on for exactly those commits.
          // Content-only passes can still refresh unmeasured height estimates;
          // patches/@legendapp%2Flist@3.3.4.patch compensates via the SIZE channel,
          // without the lock, while recalculating positions inline before paint.
          //
          // Deliberately NOT `itemsAreEqual`: the library reuses that same
          // comparator to decide whether a mounted container refreshes its item
          // data, so calling same-key rows equal would freeze a streaming row's
          // rendered content in place.
          maintainVisibleContentPosition={resolveChatTimelineMvcp(
            keySequenceChanged,
          )}
          onItemSizeChanged={handleItemSizeChanged}
          onScroll={handleScroll}
          onMetricsChange={handleMetricsChange}
          onViewableItemsChanged={handleViewableItemsChanged}
          showsVerticalScrollIndicator
          className={cn(
            // The Legend List node is the sole scroll owner. It deliberately uses
            // the app-wide thin, transparent-track scrollbar theme from index.css.
            "h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]",
            className,
          )}
          {...TRANSCRIPT_LAYOUT_PASSIVE}
          ListHeaderComponent={CHAT_TIMELINE_LIST_HEADER}
          ListFooterComponent={CHAT_TIMELINE_LIST_FOOTER}
          {...rest}
        />
      </ChatTimelineRowCtx>
    </NavigationHighlightStoreContext>
  );
});

/**
 * The transcript body is non-editable chrome, so the layout editor dims it
 * while a session is live (4.2). It is marked HERE rather than on the tile's
 * transcript container, which is an ancestor of the minimap's region - a
 * `filter` above a region would dim the region too.
 *
 * Spread rather than written as an attribute because the list's props are
 * typed, and a lone `data-*` JSX attribute on them is an excess property.
 */
const TRANSCRIPT_LAYOUT_PASSIVE = { "data-layout-passive": "opacity-only" };

function chatTimelineKeyExtractor(item: TimelineItem): string {
  return item.key;
}

/** Ticket 13 (bonus): the assistant estimate (14rem) is tuned for
 *  multi-paragraph turns; a synthesized `role: "system"` row (the fork
 *  marker, the collapsed setup card) is a single hairline-ruled line, so
 *  reusing that estimate overshoots badly for the pre-measurement paint. */
function chatTimelineRowSizeHintClassName(
  role: ChatMessageModel["role"],
): string {
  if (role === "user") return "[contain-intrinsic-size:auto_8rem]";
  if (role === "system") return "[contain-intrinsic-size:auto_4rem]";
  return "[contain-intrinsic-size:auto_14rem]";
}

const EMPTY_TIMELINE_ROWS: ReadonlyArray<TranscriptListRow> = [];

// Publish the rendered snapshot after commit: hidden rows stay frozen, and a
// structural commit retires its data-anchoring signal on the following pass.
function useCommittedTimelineRows(
  rows: ReadonlyArray<TranscriptListRow>,
  visible: boolean,
): {
  readonly frozenRows: ReadonlyArray<TranscriptListRow>;
  readonly keySequenceChanged: boolean;
} {
  const [committed] = useState(() =>
    createStore<{
      readonly rows: ReadonlyArray<TranscriptListRow>;
      readonly keys: ReadonlyArray<string>;
    }>(() => ({ rows: EMPTY_TIMELINE_ROWS, keys: [] })),
  );
  const frozen = useStore(committed, (state) => (visible ? null : state.rows));
  const committedKeys = useStore(committed, (state) => state.keys);
  const frozenRows = frozen ?? rows;
  const keysDiffer =
    committedKeys.length !== frozenRows.length ||
    frozenRows.some((row, index) => committedKeys[index] !== row.key);
  const keySequenceChanged = committedKeys.length > 0 && keysDiffer;
  useLayoutEffect(() => {
    if (visible) {
      committed.setState({
        rows,
        keys: keysDiffer ? rows.map((row) => row.key) : committedKeys,
      });
    }
  }, [committed, committedKeys, keysDiffer, rows, visible]);
  return { frozenRows, keySequenceChanged };
}

/**
 * One transcript row. Ticket 23's live profile measured a divider drag
 * across two heavy transcripts at ~2x the idle frame budget (19.5-24% of
 * frames over 1.5x budget, 50-75ms long tasks); a count-only ResizeObserver
 * pass recorded substantial multi-row churn per pointermove (~22 entries in
 * a typical callback - not literally every mounted row on every event).
 * During a panel-resize drag (`traycer-panel-resizing` on `<html>`),
 * `ChatTimeline`'s capture pass (D20 port, wired through
 * `registerPanelResizeParticipant`) marks each row that was on-screen at
 * drag START with `data-panel-resize-visible`; only UNMARKED rows flip to
 * `content-visibility: hidden` below - marked rows stay live and can still
 * re-render/remeasure normally. The `auto` keyword in the per-role
 * `contain-intrinsic-size` hints below means a row that was already laid out
 * before the drag keeps its own last-remembered size once hidden; the
 * accompanying role length (8rem/4rem/14rem) is only the fallback for a row
 * that mounts already-frozen, i.e. has no remembered size to fall back on
 * (CSS Sizing Level 4's "last remembered size" - `auto` prefers it when one
 * exists, the length is the no-memory fallback, not the other way around).
 * So LegendList's measured heights survive the freeze untouched and one
 * reflow on release restores content at the final width.
 */
function noRowSubscription(): () => void {
  return () => {};
}

function timelineItemType(item: TimelineItem): string {
  if (item.kind !== "stored") return chatTimelineGetItemType(item);
  if (item.role !== "user") return item.role;
  return item.agentAuthored ? "user:a2a" : "user:human";
}

function SubscribedChatTimelineRow({
  store,
  rowId,
  fallback,
  visible,
}: {
  readonly store: StoreApi<ChatRowSnapshot> | null;
  readonly rowId: string;
  readonly fallback: ChatMessageModel | null;
  readonly visible: boolean;
}) {
  const getSnapshot = useCallback(() => {
    if (!visible || store === null) return fallback;
    const row = store.getState().byId.get(rowId);
    return row?.kind === "hydrated" ? row.model : fallback;
  }, [store, rowId, fallback, visible]);
  const message = useSyncExternalStore(
    visible ? (store?.subscribe ?? noRowSubscription) : noRowSubscription,
    getSnapshot,
    getSnapshot,
  );
  return message === null ? null : <ChatTimelineRow message={message} />;
}

const ChatTimelineRow = memo(function ChatTimelineRow({
  message,
}: {
  message: ChatMessageModel;
}) {
  const ctx = use(ChatTimelineRowCtx);
  const readingWidth = useReadingWidthStyle();
  const highlightStore = use(NavigationHighlightStoreContext);
  const navigationHighlight = useRowNavigationHighlight(
    highlightStore,
    message.id,
  );
  if (ctx === null) {
    throw new Error("ChatTimelineRow must render inside ChatTimeline");
  }
  const { onRowMount } = ctx;
  const highlightRow = navigationHighlight === "row";

  // LegendList's size callback is not a mount callback: a recycled row whose
  // cached height is unchanged does not report a size delta. Find needs this
  // commit-boundary signal to resume a pending reveal for every real row mount.
  useLayoutEffect(() => {
    onRowMount?.(message.id);
  }, [message.id, onRowMount]);

  return (
    <div
      data-message-id={message.id}
      data-navigation-highlighted={highlightRow ? "true" : undefined}
      className={cn(
        "mx-auto w-full rounded-lg px-6 pb-6 transition-[background-color,box-shadow] duration-300 [contain:layout_paint_style] [.traycer-panel-resizing_&:not([data-panel-resize-visible])]:[content-visibility:hidden]",
        readingWidth.className,
        highlightRow && CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
        chatTimelineRowSizeHintClassName(message.role),
      )}
      style={{ maxWidth: readingWidth.maxWidth }}
    >
      <ChatMessage
        message={message}
        actions={ctx.getMessageActions(message)}
        backgroundToolBlockIds={ctx.backgroundToolBlockIds}
        nextStepActions={ctx.nextStepActions}
      />
    </div>
  );
});
