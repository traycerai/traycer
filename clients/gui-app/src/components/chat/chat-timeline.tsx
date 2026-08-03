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
import {
  CHAT_LIST_ANCHOR_OFFSET,
  resolveChatListAnchoredEndSpace,
  resolveChatTimelineIsAtEnd,
} from "@/components/chat/chat-scroll-anchoring";
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
  /** Test-observability only: the controller's current three-mode policy
   *  state (decision log #1). Not read by any production code - the anchor
   *  engine and reveal-pass effect already own every real behavior; this
   *  exists purely so black-box component tests can assert "anchored" vs.
   *  "following-end" vs. "free-scrolling" directly instead of reverse-
   *  engineering it from scroll position (the jsdom LegendList test shim's
   *  `scrollHeight` is a large fixed constant, not real content height, so
   *  position-based inference cannot reliably tell them apart). */
  readonly "data-scroll-mode"?: string;
  /** Top-fade chrome; the scroll-policy ticket decides when it's on. */
  /**
   * Whether the initial mount parks at the tail. `true` (the default) for a
   * fresh, never-scrolled-in chat (decision #15 - ticket 4 replaces this with
   * the anchor-last-user-turn policy). The controller passes `false` when
   * restoring a tab whose saved reading position was NOT following the tail,
   * so the initial DOM position does not contradict the restored mode;
   * `initialScrollIndex` below carries the exact row-level restore.
   */
  readonly initialScrollAtEnd?: boolean;
  /**
   * Ticket 5: restored row bootstrap, passed straight through as LegendList's
   * own `initialScrollIndex`. For free-scrolling this carries the saved pixel
   * offset and self-corrects as variable-height rows are measured. For a
   * restored new-turn session it makes a deep semantic query row measurable;
   * the anchor engine then owns the exact offset and reply reserve. `null` for
   * the ordinary fresh-open/no-restore case.
   */
  readonly initialScrollIndex?: ChatTimelineInitialScrollAnchor | null;
  /**
   * Message id the anchor engine is actively tracking (a sent/steered/queued
   * turn's user row), or `null` when no turn is anchored - the ordinary
   * follow/free-scroll case. Reserves trailing space so the anchored row can
   * sit `anchorOffset` px from the viewport top while its reply streams in.
   */
  readonly anchorMessageId?: string | null;
  /** Pixel offset from the viewport top for the anchored row. The controller
   *  keeps it at least as large as the measured fade/header so the query is
   *  fully visible while its reply streams below. */
  readonly anchorOffset?: number;
  readonly onAnchorReady?: (messageId: string, anchorIndex: number) => void;
  readonly onAnchorSizeChanged?: (messageId: string, size: number) => void;
  /** Composer + queued-surface overlay height, reserved as bottom content inset. */
  readonly contentInsetEndAdjustment?: number;
  readonly onIsAtEndChange?: (isAtEnd: boolean) => void;
  /**
   * Whether the controller's mode is `following-end` right now. Gates
   * LegendList's own `maintainScrollAtEnd` directly: that library behavior is
   * otherwise driven purely by LegendList's OWN internal "was at end"
   * heuristic, independent of the mode machine - a free-scrolling reader
   * parked near the tail (e.g. a suffix removal's remaining-tail anchor,
   * decision #14) would still get auto-followed by the library on the next
   * append without this gate, violating "free-scrolling never moves"
   * (decision #1). `true` by default so ticket-2-era callers are unaffected.
   */
  readonly followEnabled?: boolean;
  /**
   * Ticket 12: gates `maintainVisibleContentPosition.size` - whether
   * LegendList compensates scrollTop when an already-rendered row's
   * estimated height is replaced by its real measured height
   * (`ScrollAdjustHandler`). `true` only in `free-scrolling` (decision:
   * reading stability governs there - a reader scrolling through
   * still-estimated rows must not see the abrupt jump `size:false` produces
   * when a later measurement pass corrects an earlier row's position from
   * under them). `false` in `following-end` (end-stick governs via
   * `maintainScrollAtEnd`) and `anchoring-new-turn` (the anchor engine owns
   * motion; its own drift re-assert - the reveal pass for a `messages`
   * change, ticket 22's coalesced scheduler for a geometry-only change under
   * the same `messages` - already handles above-anchor growth under
   * `size:false`; enabling this too would double-correct the same shift).
   * `false` by default so ticket-2/3-era callers keep today's `size:false`
   * semantics unless they opt in.
   */
  readonly sizePreservationEnabled?: boolean;
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
  /**
   * Ticket 22: the scroll container's own layout (width/height) changing -
   * a divider drag/pane resize. Unlike `onItemSizeChanged`, LegendList never
   * routes this through a data/scroll/item-size callback; it is the ONLY
   * signal for a viewport-length change that leaves every row's own
   * measured size untouched.
   */
  readonly onLayout?: () => void;
}

/**
 * LegendList-owned chat transcript. Renders our existing `ChatMessage` rows
 * unchanged; carries no scroll policy of its own yet - `maintainScrollAtEnd`
 * is a placeholder the scroll-policy ticket replaces with anchored-turn
 * behavior (see decision log #1, #11-16).
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
  anchorMessageId = null,
  anchorOffset = CHAT_LIST_ANCHOR_OFFSET,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment = 0,
  onIsAtEndChange,
  followEnabled = true,
  sizePreservationEnabled,
  navigationHighlightedMessageId,
  onItemSizeChanged,
  onListMetricsChange,
  onLayout,
  ...rest
}: ChatTimelineProps) {
  const rows = useStableChatTimelineRows(listRef, messages);

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

  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady?.(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const handleAnchorSizeChanged = useCallback(
    (size: number) => {
      if (anchorMessageId !== null) {
        onAnchorSizeChanged?.(anchorMessageId, size);
      }
    },
    [anchorMessageId, onAnchorSizeChanged],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(
      rows,
      anchorMessageId,
      (row) => row.id,
      anchorOffset,
    );
    return config
      ? {
          ...config,
          onReady: handleAnchorReady,
          onSizeChanged: handleAnchorSizeChanged,
        }
      : undefined;
  }, [
    anchorMessageId,
    anchorOffset,
    handleAnchorReady,
    handleAnchorSizeChanged,
    rows,
  ]);
  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState();
    const isAtEnd = resolveChatTimelineIsAtEnd(state);
    if (isAtEnd !== undefined) {
      onIsAtEndChange?.(isAtEnd);
    }
    onScroll?.();
  }, [listRef, onIsAtEndChange, onScroll]);

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

  // Round-2 finding 3: built ONCE into a local object and passed BY
  // REFERENCE to both `maintainVisibleContentPosition` below and the
  // `data-size-preservation-enabled` echo - a mutation of `.size` directly
  // (e.g. hardcoding it in an inline object literal) is then structurally
  // impossible to diverge from the attribute, since they read the exact
  // same object's field instead of two independently-computed values.
  const maintainVisibleContentPosition = {
    data: true,
    size: resolveChatTimelineSizePreservationEnabled(sizePreservationEnabled),
  };

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
        {...(initialScrollIndex !== null ? { initialScrollIndex } : {})}
        {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        maintainScrollAtEnd={
          anchoredEndSpace || !followEnabled
            ? false
            : {
                animated: false,
                on: {
                  dataChange: true,
                  itemLayout: true,
                  layout: true,
                },
              }
        }
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        onItemSizeChanged={onItemSizeChanged}
        onScroll={handleScroll}
        onLayout={onLayout}
        {...(onListMetricsChange !== undefined
          ? { onMetricsChange: onListMetricsChange }
          : {})}
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
        // Round-2 finding 3, test-observability only: echoes the SAME
        // `maintainVisibleContentPosition` object's own `.size` field passed
        // to LegendList above (not a separately-computed value) - same "not
        // read by any production code" contract as `data-scroll-mode`.
        // Placed AFTER `{...rest}` is spread (not before) - a caller-
        // supplied `rest` bag winning over an earlier explicit prop with the
        // same key is how JSX prop precedence actually works (last write
        // wins, regardless of what the type system would allow a real
        // caller to pass through `rest`), so this ordering is what makes
        // shadowing structurally impossible, not a claim about `rest`'s
        // contents.
        data-size-preservation-enabled={String(
          maintainVisibleContentPosition.size,
        )}
      />
    </ChatTimelineRowCtx>
  );
});

function chatTimelineKeyExtractor(item: ChatMessageModel): string {
  return item.id;
}

/** Resolves `sizePreservationEnabled`'s default out of the component body -
 *  a second defaulted destructure param (alongside `followEnabled`) pushed
 *  `ChatTimeline`'s own cyclomatic complexity over the lint limit. */
function resolveChatTimelineSizePreservationEnabled(
  sizePreservationEnabled: boolean | undefined,
): boolean {
  return sizePreservationEnabled ?? false;
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
