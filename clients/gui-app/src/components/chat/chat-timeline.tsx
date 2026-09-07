import {
  createContext,
  memo,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
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
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import {
  ChatMessage,
  type ChatMessageActions,
} from "@/components/chat/chat-message";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { chatTimelineGetItemType } from "@/components/chat/chat-messages-scroll-helpers";
import { registerPanelResizeParticipant } from "@/lib/layout/panel-resizing-class";
import {
  captureChatTimelineVisibleRows,
  clearChatTimelineVisibleRows,
} from "@/components/chat/chat-timeline-panel-resize-snapshot";
import {
  computeStableTranscriptListRows,
  didTranscriptListKeySequenceChange,
  EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
  transcriptListKeySequence,
  type StableTranscriptListRowsState,
} from "./chat-stable-rows";
import { ChatTranscriptPlaceholderRow } from "./chat-transcript-placeholder-row";
import type { ChatTranscriptRowHeightMemory } from "./chat-transcript-row-height-memory";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import {
  useChatTimelineFollowLatch,
  type ChatTimelineFollowLatch,
  type ChatTimelineReaderGestureIntent,
} from "./chat-timeline-follow-latch";

/** `useSyncExternalStore` lets each row subscribe with its own selector (`id === message.id`); React re-renders a given subscriber only when ITS boolean actually flips, so a highlight move re-renders exactly the old and new highlighted rows. */
interface NavigationHighlightStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => string | null;
  readonly setHighlightedId: (id: string | null) => void;
}

function createNavigationHighlightStore(
  initialHighlightedId: string | null,
): NavigationHighlightStore {
  let highlightedId = initialHighlightedId;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return highlightedId;
    },
    setHighlightedId(next) {
      if (next === highlightedId) return;
      highlightedId = next;
      for (const listener of listeners) listener();
    },
  };
}

function useIsNavigationHighlighted(
  store: NavigationHighlightStore,
  messageId: string,
): boolean {
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot() === messageId,
  );
}

/** Owns the store's lifetime and keeps it synced with the latest prop - pulled out of `ChatTimeline`'s own body (alongside `resolveChatTimelineSizePreservationEnabled` below) to keep that component's cyclomatic complexity under the lint limit. */
function useNavigationHighlightStore(
  navigationHighlightedMessageId: string | null | undefined,
): NavigationHighlightStore {
  const [store] = useState<NavigationHighlightStore>(() =>
    createNavigationHighlightStore(navigationHighlightedMessageId ?? null),
  );

  // `useLayoutEffect` publishes synchronously before the browser paints on EVERY producer path uniformly, not just the ones that happen to chain off another layout effect.
  // The mutation itself is still outside render (it runs in the commit/layout phase, not the render phase), so `useSyncExternalStore`'s purity contract is unaffected.
  useLayoutEffect(() => {
    store.setHighlightedId(navigationHighlightedMessageId ?? null);
  }, [store, navigationHighlightedMessageId]);

  return store;
}

/** Shared, closure-free row context. Row components read business-logic callbacks from context instead of a per-item closure, so `renderItem` stays referentially stable and LegendList's own memo boundary is never invalidated by it. */
interface ChatTimelineRowSharedState {
  readonly taskTitle: string;
  readonly backgroundToolBlockIds: ReadonlySet<string>;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler | null;
  readonly navigationHighlightStore: NavigationHighlightStore;
  readonly onRowMount: ((messageId: string) => void) | undefined;
}

const ChatTimelineRowCtx = createContext<ChatTimelineRowSharedState | null>(
  null,
);

/** decision #5: "isNearEnd (library default 10% threshold)". */
const CHAT_TIMELINE_NEAR_END_THRESHOLD = 0.1;

/** The two configurations the timeline alternates between, at module scope so each keeps one identity and a commit that does not move between them hands the list the same object. See the prop itself for what selects which. */
const CHAT_TIMELINE_MVCP_SIZE_ONLY: MaintainVisibleContentPositionConfig<TranscriptListRow> =
  { data: false, size: true };
const CHAT_TIMELINE_MVCP_WITH_DATA: MaintainVisibleContentPositionConfig<TranscriptListRow> =
  { data: true, size: true };

/** Both arms are pinned by the prop-capture cases in `chat-timeline.test.tsx`,
 *  which observe what the list actually received rather than calling this. */
function resolveChatTimelineMvcp(
  keySequenceChanged: boolean,
): MaintainVisibleContentPositionConfig<TranscriptListRow> {
  return keySequenceChanged
    ? CHAT_TIMELINE_MVCP_WITH_DATA
    : CHAT_TIMELINE_MVCP_SIZE_ONLY;
}

// M4 (the old 40px header/footer were unsanctioned drift (decision log #30).
// Consumers read the live measured size via `onListMetricsChange`, so they adapt automatically; nothing here is a hardcoded assumption elsewhere.
const CHAT_TIMELINE_LIST_HEADER = (
  <div aria-hidden="true" className="h-3 sm:h-4" />
);
const CHAT_TIMELINE_LIST_FOOTER = (
  <div aria-hidden="true" className="h-3 sm:h-4" />
);

/** LegendList's own `initialScrollIndex` shape - a row index plus the exact pixel offset/anchoring edge to bootstrap-scroll to. */
export interface ChatTimelineInitialScrollAnchor {
  readonly index: number;
  readonly viewOffset: number;
  readonly viewPosition: number;
}

/** The part of LegendList's `onItemSizeChanged` payload this component reads. Declared locally because the library types it inline on the prop rather than exporting it; a narrower parameter is assignable to the wider callback. */
interface ChatTimelineItemSizeInfo {
  readonly size: number;
  readonly itemData: TranscriptListRow;
}

export interface ChatTimelineProps {
  /** A full-length list on the windowed line: `transcriptListRows` fills every ordinal the window says exists, so scrolling reaches the top of the CHAT rather than the top of what happens to be loaded. */
  readonly rows: ReadonlyArray<TranscriptListRow>;
  /** Which ROW indexes the viewport is showing, from LegendList's viewability pass - `[fromIndex, toIndex)` over `rows`, buffered by the list's render window so hydration modestly prefetches around the reading line. The windowed line turns this into ordinal-range hydration requests; on the legacy line the ranges resolve to no ordinals and the report is inert. */
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
  /** Whether the initial mount parks at the tail: `true` for a fresh, never-scrolled-in chat with no saved reading position. The controller passes `false` when restoring a tab whose saved reading position was NOT the tail, so the initial DOM position does not contradict the restored position; `initialScrollIndex` below carries the exact row-level restore. */
  readonly initialScrollAtEnd?: boolean;
  /** Restored row bootstrap, passed straight through as LegendList's own `initialScrollIndex`: the saved pixel offset, self-correcting as variable-height rows are measured. `null` for the ordinary fresh-open/no-restore case. */
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
  /** Where this transcript's measured row heights are kept, so a placeholder for a row the list has already drawn stands at the height that row really takes. `null` on the legacy line, which holds every body and never draws a placeholder at all. */
  readonly rowHeightMemory?: ChatTranscriptRowHeightMemory | null;
  /** Notifies presentational consumers after LegendList remeasures any row. */
  readonly onItemSizeChanged?: () => void;
  /** Fires for every mounted virtual row, including cached equal-size rows. */
  readonly onRowMount?: (messageId: string) => void;
  /** LegendList's measured header/footer sizes. The free-scrolling save path needs `headerSize` as the top-offset adjustment that `initialScrollIndex` / `scrollToIndex` re-add on restore (decision #18 exact-pixel contract) - `positionAtIndex` is content-relative and does not include it. */
  readonly onListMetricsChange?: (metrics: {
    readonly headerSize: number;
    readonly footerSize: number;
  }) => void;
}

/** Bottom-follow is a strict 1px edge, owned by `useChatTimelineFollowLatch` (see that module) rather than LegendList's own `maintainScrollAtEnd`, which this component never enables. `maintainVisibleContentPosition` stays on unconditionally, but only on its SIZE channel - it keeps an already-detached reader's view pixel-stable against unrelated growth, which never pulls toward the tail. */
export const ChatTimeline = memo(function ChatTimeline({
  rows: inputRows,
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
  rowHeightMemory = null,
  onItemSizeChanged,
  onRowMount,
  onListMetricsChange,
  ...rest
}: ChatTimelineProps) {
  const rows = useStableChatTimelineRows(listRef, inputRows);

  const keySequenceChanged = useCommittedKeySequenceChanged(listRef, rows);

  // Bottom-follow is owned entirely here now - LegendList's own `maintainScrollAtEnd` is never passed at all below.
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

  const navigationHighlightStore = useNavigationHighlightStore(
    navigationHighlightedMessageId,
  );

  const sharedState = useMemo<ChatTimelineRowSharedState>(
    () => ({
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      navigationHighlightStore,
      onRowMount,
    }),
    [
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      navigationHighlightStore,
      onRowMount,
    ],
  );

  // `endBuffered` is the last BUFFERED index, inclusive; the consumer takes an end-exclusive range.
  // Reported from the buffered bounds rather than the strictly-visible ones so hydration warms the rows the list is about to mount, not only the ones already on screen.
  const handleViewableItemsChanged = useCallback(
    (info: OnViewableItemsChangedInfo<TranscriptListRow>): void => {
      onVisibleRowRangeChange?.(info.startBuffered, info.endBuffered + 1);
    },
    [onVisibleRowRangeChange],
  );

  // Stable renderItem: `rowHeightMemory` is a mount-lifetime object, not a value that changes as rows are measured, so naming it as a dep does not cost the identity this callback is kept stable for.
  // ChatTimelineRow reads shared state from ChatTimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: TranscriptListRow }) =>
      item.kind === "placeholder" ? (
        <ChatTranscriptPlaceholderRow
          entry={item.entry}
          ordinal={item.ordinal}
          heightMemory={rowHeightMemory}
        />
      ) : (
        <ChatTimelineRow message={item.model} />
      ),
    [rowHeightMemory],
  );

  const handleScroll = useCallback(() => {
    followLatch.observeLiveGeometry();
    onScroll?.();
  }, [followLatch, onScroll]);

  const handleItemSizeChanged = useCallback(
    (info: ChatTimelineItemSizeInfo) => {
      // Only a HYDRATED row's measurement says anything true about how tall that row is.
      // A placeholder measures at whatever height the memory just told it to stand at, so recording one would be the memory reading its own estimate back in as evidence for that estimate.
      if (rowHeightMemory !== null && info.itemData.kind === "hydrated") {
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

  useLayoutEffect(() => {
    followLatch.followEndIfPermitted();
  }, [rows, contentInsetEndAdjustment, followLatch]);

  // registers this mounted timeline as a panel-resize participant so a divider drag's capture pass (see `lib/layout/panel-resizing-class.ts`) can mark ITS OWN currently visible rows right before the freeze class lands - see `ChatTimelineRow`'s own doc comment for the freeze mechanism.
  // `useLayoutEffect`, not `useEffect`: registration must be live before the browser can paint a state where a drag could start.
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
    <ChatTimelineRowCtx value={sharedState}>
      <LegendList<TranscriptListRow>
        ref={listRef}
        data={rows}
        keyExtractor={chatTimelineKeyExtractor}
        getItemType={chatTimelineGetItemType}
        renderItem={renderItem}
        estimatedItemSize={90}
        // Keep LegendList's proximity threshold explicit for onEndReached and presentation consumers.
        // Follow ownership deliberately reads only fresh DOM geometry inside the latch; this 10% band can never re-attach a detached reader.
        onEndReachedThreshold={CHAT_TIMELINE_NEAR_END_THRESHOLD}
        initialScrollAtEnd={initialScrollAtEnd}
        initialScrollIndex={initialScrollIndex ?? undefined}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        // The explicit zero still narrows `isWithinMaintainScrollAtEndThreshold` (used internally by the library's own content-inset compensation) to `distanceFromEnd <= 0` rather than its 10%-of-viewport default.
        maintainScrollAtEndThreshold={0}
        // The library treats any row object it cannot prove equal as a structural data change, and while that channel is on it arms an MVCP anchor lock on every such pass.
        // Deliberately NOT `itemsAreEqual`: the library reuses that same comparator to decide whether a mounted container refreshes its item data, so calling same-key rows equal would freeze a streaming row's rendered content in place.
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
        ListHeaderComponent={CHAT_TIMELINE_LIST_HEADER}
        ListFooterComponent={CHAT_TIMELINE_LIST_FOOTER}
        {...rest}
      />
    </ChatTimelineRowCtx>
  );
});

function chatTimelineKeyExtractor(item: TranscriptListRow): string {
  return item.key;
}

/** the assistant estimate (14rem) is tuned for multi-paragraph turns; a synthesized `role: "system"` row (the fork marker, the collapsed setup card) is a single hairline-ruled line, so reusing that estimate overshoots badly for the pre-measurement paint. */
function chatTimelineRowSizeHintClassName(
  role: ChatMessageModel["role"],
): string {
  if (role === "user") return "[contain-intrinsic-size:auto_8rem]";
  if (role === "system") return "[contain-intrinsic-size:auto_4rem]";
  return "[contain-intrinsic-size:auto_14rem]";
}

/** Module-scope cache (never `useState`/`useRef`-owned - not a hook value the compiler tracks for immutability at all), keyed by each `ChatTimeline` mount's own `listRef` object - a stable identity for the lifetime of that mounted instance (a fresh mount naturally starts a fresh cache entry, and multiple simultaneously-mounted tiles never share one - which now includes the retained-but-deselected chats a pane keeps alive, since pane chat retention reversed decision #17). Walking the scenario - `computeStableChatTimelineRows(rows, previous)` per row either (a) reuses `previous.byId.get(row.id)` ONLY when `isChatMessageUnchanged` confirms every tracked field matches the CURRENT real `row`, or (b) falls back to `row` itself - the fresh object the CURRENT real props already carry, never a value derived FROM `previous`. */
const stableChatTimelineRowsCache = new WeakMap<
  RefObject<LegendListRef | null>,
  StableTranscriptListRowsState
>();

/** The row key sequence each mounted timeline last RENDERED, keyed by that mount's `listRef` exactly as `stableChatTimelineRowsCache` is. Written only from a layout effect, so a render React discards never advances it - which is the whole point of keeping it separate from the row-reuse cache above, whose entry is published during render by design. */
const committedChatTimelineKeysCache = new WeakMap<
  RefObject<LegendListRef | null>,
  ReadonlyArray<string>
>();

/** `messages` is rebuilt wholesale on every store update (every streaming token), so this runs on nearly every render - a `use-mounted-pane-tabs.ts` -style adjust-state-during-render retry would cost a genuine extra render pass on that hot path, not just a Strict Mode dev artifact. */
function useStableChatTimelineRows(
  listRef: RefObject<LegendListRef | null>,
  rows: ReadonlyArray<TranscriptListRow>,
): ReadonlyArray<TranscriptListRow> {
  return useMemo(() => {
    const previous =
      stableChatTimelineRowsCache.get(listRef) ??
      EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE;
    const next = computeStableTranscriptListRows(rows, previous);
    stableChatTimelineRowsCache.set(listRef, next);
    return next.result;
  }, [rows, listRef]);
}

/** The baseline is published from a layout effect, never from render, and that is the whole design: React discards renders, and a baseline a discarded one advanced makes the real render that replaces it compare against a sequence nothing ever rendered. A discarded render runs no layout effect, so it cannot move this. */
function useCommittedKeySequenceChanged(
  listRef: RefObject<LegendListRef | null>,
  rows: ReadonlyArray<TranscriptListRow>,
): boolean {
  const keySequenceChanged = useMemo(
    () =>
      didTranscriptListKeySequenceChange(
        committedChatTimelineKeysCache.get(listRef),
        rows,
      ),
    [listRef, rows],
  );

  useLayoutEffect(() => {
    committedChatTimelineKeysCache.set(
      listRef,
      transcriptListKeySequence(rows),
    );
  }, [listRef, rows]);

  return keySequenceChanged;
}

/** The `auto` keyword in the per-role `contain-intrinsic-size` hints below means a row that was already laid out before the drag keeps its own last-remembered size once hidden; the accompanying role length (8rem/4rem/14rem) is only the fallback for a row that mounts already-frozen, i.e. has no remembered size to fall back on (CSS Sizing Level 4's "last remembered size" - `auto` prefers it when one exists, the length is the no-memory fallback, not the other way around). */
const ChatTimelineRow = memo(function ChatTimelineRow({
  message,
}: {
  message: ChatMessageModel;
}) {
  const ctx = use(ChatTimelineRowCtx);
  if (ctx === null) {
    throw new Error("ChatTimelineRow must render inside ChatTimeline");
  }
  const { onRowMount } = ctx;
  const isNavigationHighlighted = useIsNavigationHighlighted(
    ctx.navigationHighlightStore,
    message.id,
  );

  // LegendList's size callback is not a mount callback: a recycled row whose cached height is unchanged does not report a size delta.
  // Find needs this commit-boundary signal to resume a pending reveal for every real row mount.
  useLayoutEffect(() => {
    onRowMount?.(message.id);
  }, [message.id, onRowMount]);

  return (
    <div
      data-message-id={message.id}
      data-navigation-highlighted={isNavigationHighlighted ? "true" : undefined}
      className={cn(
        "mx-auto w-full max-w-3xl rounded-lg px-6 pb-6 transition-[background-color,box-shadow] duration-300 [contain:layout_paint_style] [.traycer-panel-resizing_&:not([data-panel-resize-visible])]:[content-visibility:hidden]",
        isNavigationHighlighted &&
          "bg-primary/15 ring-2 ring-inset ring-primary/80 motion-safe:animate-pulse",
        chatTimelineRowSizeHintClassName(message.role),
      )}
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
