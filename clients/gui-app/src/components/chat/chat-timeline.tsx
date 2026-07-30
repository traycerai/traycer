import {
  createContext,
  memo,
  use,
  useCallback,
  useMemo,
  useState,
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
import {
  computeStableChatTimelineRows,
  EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
} from "./chat-stable-rows";

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

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
  readonly navigationHighlightedMessageId: string | null | undefined;
}

const ChatTimelineRowCtx = createContext<ChatTimelineRowSharedState | null>(
  null,
);

/** decision #5: "isNearEnd (library default 10% threshold)". */
const CHAT_TIMELINE_NEAR_END_THRESHOLD = 0.1;

const CHAT_TIMELINE_LIST_HEADER = <div aria-hidden="true" className="h-10" />;
const CHAT_TIMELINE_LIST_FADE_HEADER = (
  <div aria-hidden="true" className="h-16 sm:h-20" />
);
const CHAT_TIMELINE_LIST_FOOTER = <div aria-hidden="true" className="h-10" />;

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
  readonly topFadeEnabled?: boolean;
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
   * Ticket 5: exact restored free-scrolling position (the saved anchor row +
   * pixel offset), passed straight through as LegendList's own
   * `initialScrollIndex` bootstrap - the same measurement-aware convergence
   * path `initialScrollAtEnd` uses, so a deep anchor past variable-height rows
   * still lands correctly once real heights replace the `estimatedItemSize`
   * guess (verified against the installed @legendapp/list 3.2.0 source, not
   * just its type declarations). `null` for the ordinary fresh-open/no-restore
   * case - `initialScrollAtEnd` or the anchor engine own the DOM position then.
   */
  readonly initialScrollIndex?: ChatTimelineInitialScrollAnchor | null;
  /**
   * Message id the anchor engine is actively tracking (a sent/steered/queued
   * turn's user row), or `null` when no turn is anchored - the ordinary
   * follow/free-scroll case. Reserves trailing space so the anchored row can
   * sit `anchorOffset` px from the viewport top while its reply streams in.
   */
  readonly anchorMessageId?: string | null;
  /** Pixel offset from the viewport top for the anchored row (decision #12-13:
   *  flat 16px + the controller's live pinned-stack height). */
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
   * motion; its own reveal-pass drift re-assert already handles above-anchor
   * growth under `size:false` - enabling this too would double-correct the
   * same shift). `false` by default so ticket-2/3-era callers keep today's
   * `size:false` semantics unless they opt in.
   */
  readonly sizePreservationEnabled?: boolean;
  /** Message row receiving the temporary external-navigation highlight. */
  readonly navigationHighlightedMessageId?: string | null;
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
  topFadeEnabled = false,
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
  onListMetricsChange,
  ...rest
}: ChatTimelineProps) {
  const rows = useStableChatTimelineRows(messages);

  const sharedState = useMemo<ChatTimelineRowSharedState>(
    () => ({
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      navigationHighlightedMessageId,
    }),
    [
      taskTitle,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
      navigationHighlightedMessageId,
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
        // `isNearEnd` (read via resolveChatTimelineIsAtEnd) is computed by
        // LegendList from `onEndReachedThreshold`, NOT `maintainScrollAtEndThreshold`
        // - the installed 3.2.0 defaults `onEndReachedThreshold` to 0.5 (50% of
        // scroll length), not the 10% decision #5 assumes. Set it explicitly;
        // verified against the installed package source, not its type doc.
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
        onScroll={handleScroll}
        {...(onListMetricsChange !== undefined
          ? { onMetricsChange: onListMetricsChange }
          : {})}
        className={cn(
          "chat-scrollbar-native-thin mr-1 h-full overflow-x-hidden overscroll-y-contain [overflow-anchor:none]",
          topFadeEnabled && "chat-timeline-scroll-fade",
          className,
        )}
        ListHeaderComponent={
          topFadeEnabled
            ? CHAT_TIMELINE_LIST_FADE_HEADER
            : CHAT_TIMELINE_LIST_HEADER
        }
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

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused.
 *  Guarded adjust-state-during-render (same idiom as
 *  `use-mounted-pane-tabs.ts`'s LRU derivation) - a ref would need mutating
 *  mid-render, which the React Compiler forbids. */
function useStableChatTimelineRows(
  rows: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatMessageModel> {
  const [state, setState] = useState(EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE);
  const nextState = computeStableChatTimelineRows(rows, state);
  if (nextState !== state) {
    setState(nextState);
  }
  return nextState.result;
}

/**
 * One transcript row. During a panel-resize drag (`traycer-panel-resizing`
 * on `<html>`) every row flips to `content-visibility: hidden`: each
 * pointermove reflows all visible panes, and live rows would re-wrap and
 * re-rasterize every transcript at every intermediate width - a
 * multi-hundred-MB transient spike in the GPU process's tile pool. Hidden
 * rows keep their remembered size (the `auto` intrinsic-size keyword), so
 * LegendList's measurement sees stable heights for the whole drag; one
 * reflow on pointer-up restores content at the final width.
 */
const ChatTimelineRow = memo(function ChatTimelineRow({
  message,
}: {
  message: ChatMessageModel;
}) {
  const ctx = use(ChatTimelineRowCtx);

  return (
    <div
      data-message-id={message.id}
      data-navigation-highlighted={
        ctx?.navigationHighlightedMessageId === message.id ? "true" : undefined
      }
      className={cn(
        "mx-auto w-full max-w-3xl rounded-lg px-6 pb-6 transition-[background-color,box-shadow] duration-300 [contain:layout_paint_style]",
        ctx?.navigationHighlightedMessageId === message.id &&
          "bg-primary/15 ring-2 ring-inset ring-primary/80 motion-safe:animate-pulse",
        message.role === "user"
          ? "[contain-intrinsic-size:auto_8rem]"
          : "[contain-intrinsic-size:auto_14rem]",
      )}
    >
      <ChatMessage
        message={message}
        actions={ctx?.getMessageActions(message) ?? null}
        backgroundToolBlockIds={
          ctx?.backgroundToolBlockIds ?? EMPTY_BACKGROUND_TOOL_BLOCK_IDS
        }
        nextStepActions={ctx?.nextStepActions ?? null}
      />
    </div>
  );
});
