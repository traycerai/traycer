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
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { cn } from "@/lib/utils";
import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import {
  ChatMessage,
  type ChatMessageActions,
} from "@/components/chat/chat-message";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { resolveChatTimelineIsAtEnd } from "@/components/chat/chat-scroll-restoration";
import { chatTimelineGetItemType } from "@/components/chat/chat-messages-scroll-helpers";
import { registerPanelResizeParticipant } from "@/lib/layout/panel-resizing-class";
import {
  captureChatTimelineVisibleRows,
  clearChatTimelineVisibleRows,
} from "@/components/chat/chat-timeline-panel-resize-snapshot";
import {
  computeStableChatTimelineRows,
  EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
  type StableChatTimelineRowsState,
} from "./chat-stable-rows";
import { useChatTimelineFollowLatch } from "./chat-timeline-follow-latch";

/**
 * Ticket 24 (painted-chat lifecycle audit, finding 5): a row-local
 * subscription for the navigation highlight, kept OUT of
 * `ChatTimelineRowSharedState`. That context's value is a single object
 * shared by every mounted row - React forces every context consumer to
 * re-render whenever the value changes, bypassing each row's own `memo`
 * bailout entirely (a probe confirmed 8/8 mounted rows re-rendering on one
 * highlight move). `useSyncExternalStore` lets each row subscribe with its
 * own selector (`id === message.id`); React re-renders a given subscriber
 * only when ITS boolean actually flips, so a highlight move re-renders
 * exactly the old and new highlighted rows.
 */
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

/** Owns the store's lifetime and keeps it synced with the latest prop -
 *  pulled out of `ChatTimeline`'s own body (alongside
 *  `resolveChatTimelineSizePreservationEnabled` below) to keep that
 *  component's cyclomatic complexity under the lint limit. */
function useNavigationHighlightStore(
  navigationHighlightedMessageId: string | null | undefined,
): NavigationHighlightStore {
  const [store] = useState<NavigationHighlightStore>(() =>
    createNavigationHighlightStore(navigationHighlightedMessageId ?? null),
  );

  // Review round 1, finding 1: a PASSIVE effect here runs after paint unless
  // the update happens to originate inside a parent `useLayoutEffect` (the
  // external-jump activation path) - the 3s highlight-timeout clear
  // (`setTimeout`) and the real-gesture clear (a plain callback, not a
  // layout effect) have no such guarantee, so a paint could commit the new
  // prop while the store - and therefore every row's boolean - still holds
  // the old id, and a row mounting in that window would read the stale
  // snapshot. `useLayoutEffect` publishes synchronously before the browser
  // paints on EVERY producer path uniformly, not just the ones that happen
  // to chain off another layout effect. The mutation itself is still
  // outside render (it runs in the commit/layout phase, not the render
  // phase), so `useSyncExternalStore`'s purity contract is unaffected.
  useLayoutEffect(() => {
    store.setHighlightedId(navigationHighlightedMessageId ?? null);
  }, [store, navigationHighlightedMessageId]);

  return store;
}

/**
 * Shared, closure-free row context. Row components read business-logic
 * callbacks from context instead of a per-item closure, so `renderItem`
 * stays referentially stable and LegendList's own memo boundary is never
 * invalidated by it.
 */
interface ChatTimelineRowSharedState {
  readonly taskTitle: string;
  readonly backgroundToolBlockIds: ReadonlySet<string>;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler | null;
  readonly navigationHighlightStore: NavigationHighlightStore;
}

const ChatTimelineRowCtx = createContext<ChatTimelineRowSharedState | null>(
  null,
);

/** decision #5: "isNearEnd (library default 10% threshold)". */
const CHAT_TIMELINE_NEAR_END_THRESHOLD = 0.1;

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

export interface ChatTimelineProps {
  readonly messages: ReadonlyArray<ChatMessageModel>;
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
  readonly onIsAtEndChange?: (isAtEnd: boolean) => void;
  /** Message row receiving the temporary external-navigation highlight. */
  readonly navigationHighlightedMessageId?: string | null;
  /** Notifies presentational consumers after LegendList remeasures any row. */
  readonly onItemSizeChanged?: () => void;
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
 * `maintainVisibleContentPosition` stays on unconditionally - it keeps an
 * already-detached reader's view pixel-stable against unrelated growth,
 * which never pulls toward the tail. There is no app-owned scroll mode here.
 */
export const ChatTimeline = memo(function ChatTimeline({
  messages,
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
  onIsAtEndChange,
  navigationHighlightedMessageId,
  onItemSizeChanged,
  onListMetricsChange,
  ...rest
}: ChatTimelineProps) {
  const rows = useStableChatTimelineRows(listRef, messages);

  // Fixup (fix-detached-streaming-yank/callback-synchronous-follow): see the
  // hook's own doc comment. Bottom-follow is owned entirely here now -
  // LegendList's own `maintainScrollAtEnd` is never passed at all below.
  const followLatch = useChatTimelineFollowLatch(
    listRef,
    initialScrollAtEnd,
    rows.length > 0,
  );

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
    }),
    [
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      navigationHighlightStore,
    ],
  );

  // Stable renderItem - no closure deps. ChatTimelineRow reads shared state
  // from ChatTimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: ChatMessageModel }) => (
      <ChatTimelineRow message={item} />
    ),
    [],
  );

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState();
    const isAtEnd = resolveChatTimelineIsAtEnd(state);
    if (isAtEnd !== undefined) {
      onIsAtEndChange?.(isAtEnd);
    }
    onScroll?.();
  }, [listRef, onIsAtEndChange, onScroll]);

  // Fixup (callback-synchronous-follow): item-layout and footer/header-
  // layout are two of the real LegendList maintain triggers that never
  // re-enter this component's render - consult the latch right here, at the
  // actual callback boundary, not through a prop the library reads later.
  const handleItemSizeChanged = useCallback(() => {
    followLatch.followEndIfPermitted();
    onItemSizeChanged?.();
  }, [followLatch, onItemSizeChanged]);

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
    <ChatTimelineRowCtx value={sharedState}>
      <LegendList<ChatMessageModel>
        ref={listRef}
        data={rows}
        keyExtractor={chatTimelineKeyExtractor}
        getItemType={chatTimelineGetItemType}
        renderItem={renderItem}
        estimatedItemSize={90}
        // Keep LegendList's proximity threshold explicit for onEndReached and
        // presentation consumers. Follow ownership deliberately reads only
        // strict `isAtEnd` via resolveChatTimelineIsAtEnd; this 10% band can
        // never re-attach a detached reader.
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
        maintainVisibleContentPosition
        onItemSizeChanged={handleItemSizeChanged}
        onScroll={handleScroll}
        onMetricsChange={handleMetricsChange}
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

function chatTimelineKeyExtractor(item: ChatMessageModel): string {
  return item.id;
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

/**
 * Module-scope cache (never `useState`/`useRef`-owned - not a hook value the
 * compiler tracks for immutability at all), keyed by each `ChatTimeline`
 * mount's own `listRef` object - a stable identity for the lifetime of that
 * mounted instance (chat tiles remount wholesale per tab switch, decision
 * #17, so a fresh `listRef` naturally starts a fresh cache entry; multiple
 * simultaneously-mounted tiles never share one). Same shape as
 * `rendered-messages.ts`'s per-context `WeakMap`s.
 *
 * Review fix (F4, ticket 16 batch review): the earlier `useState`-held `Map`
 * mutated mid-render was flagged as a lint loophole, not real purity - a
 * speculative/discarded React render still executes `useMemo`'s callback and
 * could publish a cache write that a LATER, actually-committed render then
 * reads. This shape is safe under that scenario for the same reason
 * `rendered-messages.ts`'s caches are: every read is immediately followed by
 * a fresh, from-scratch correctness check against the CURRENT real input,
 * never a trust-the-cache-blindly hit. Walking the scenario -
 * `computeStableChatTimelineRows(rows, previous)` per row either (a) reuses
 * `previous.byId.get(row.id)` ONLY when `isChatMessageUnchanged` confirms
 * every tracked field matches the CURRENT real `row`, or (b) falls back to
 * `row` itself - the fresh object the CURRENT real props already carry,
 * never a value derived FROM `previous`. So if a discarded speculative
 * render (rows never actually committed) writes a polluted `previous` into
 * the cache, the next REAL render can only ever (a) correctly reuse a
 * reference when its content genuinely, byte-for-byte matches what's
 * already cached - reuse is never wrong merely because of which past render
 * produced the cached value - or (b) miss and fall back to its own real,
 * already-correct `row` - never displaying wrong content. The one possible
 * cost of pollution is a missed reuse opportunity (an extra `ChatMessage`
 * memo-bail re-render), the same failure mode `rendered-messages.ts`'s own
 * cache-key mismatch path has, not a correctness bug.
 */
const stableChatTimelineRowsCache = new WeakMap<
  RefObject<LegendListRef | null>,
  StableChatTimelineRowsState
>();

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused.
 *  `messages` is rebuilt wholesale on every store update (every streaming
 *  token), so this runs on nearly every render - a `use-mounted-pane-tabs.ts`
 *  -style adjust-state-during-render retry would cost a genuine extra render
 *  pass on that hot path, not just a Strict Mode dev artifact. See
 *  `stableChatTimelineRowsCache`'s own doc comment for the cache shape and
 *  why it stays correct under a discarded speculative render. */
function useStableChatTimelineRows(
  listRef: RefObject<LegendListRef | null>,
  rows: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatMessageModel> {
  return useMemo(() => {
    const previous =
      stableChatTimelineRowsCache.get(listRef) ??
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE;
    const next = computeStableChatTimelineRows(rows, previous);
    stableChatTimelineRowsCache.set(listRef, next);
    return next.result;
  }, [rows, listRef]);
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
const ChatTimelineRow = memo(function ChatTimelineRow({
  message,
}: {
  message: ChatMessageModel;
}) {
  const ctx = use(ChatTimelineRowCtx);
  if (ctx === null) {
    throw new Error("ChatTimelineRow must render inside ChatTimeline");
  }
  const isNavigationHighlighted = useIsNavigationHighlighted(
    ctx.navigationHighlightStore,
    message.id,
  );

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
