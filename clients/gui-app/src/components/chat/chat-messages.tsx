import { ChatEmptyState } from "@/components/chat/chat-empty-state";
import { QuoteSelectionPopover } from "@/components/chat/quote/quote-selection-popover";
import { useQuoteSelection } from "@/components/chat/quote/use-quote-selection";
import { useChatFindController } from "@/components/chat/use-chat-find-controller";
import { ChatMeasuredItemChangeContext } from "@/components/chat/chat-measured-item-change-context";
import {
  ChatMessage,
  type ChatMessageActions,
} from "@/components/chat/chat-message";
import {
  buildMessageIdToIndex,
  chatScrollLocationForMessage,
  chatComputeItemKey,
  chatItemIdentity,
  classifyChatScrollPolicy,
  isNearChatBottom,
  measuredItemChangeScrollModifier,
  selectActiveUserMessageId,
  viewportActiveUserMessageId,
} from "@/components/chat/chat-messages-virtuoso-helpers";
import {
  restoreChatScrollState,
  saveChatScrollState,
  type SavedChatScrollState,
} from "@/components/chat/chat-scroll-state-cache";
import { ChatUserMessageMinimap } from "@/components/chat/chat-user-message-minimap";
import { buildChatActivityTimeline } from "@/components/chat/chat-activity-groups";
import {
  chatMinimapClipRegionProps,
  type ChatUserMinimapItem,
} from "@/components/chat/chat-user-message-minimap-items";
import { ScrollToBottomChip } from "@/components/chat/scroll-to-bottom-chip";
import type { NextStepActionHandler } from "@/components/chat/segments/next-steps-action-group";
import { useAnimationFrameThrottle } from "@/hooks/use-animation-frame-throttle";
import { cn } from "@/lib/utils";
import { VIRTUOSO_MESSAGE_LIST_LICENSE_KEY } from "@/lib/virtuoso-license";
import type { ScrollRestorationAdapter } from "@/hooks/scroll/scroll-restoration-adapter";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";
import { ActivityGroupOpenStoreProvider } from "@/stores/chats/activity-group-open-store";
import { A2AOpenStoreProvider } from "@/stores/chats/a2a-open-store";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import { createActivityGroupOpenStore } from "@/stores/chats/activity-group-open-store-core";
import { ChatOpenStoreScopeProvider } from "@/stores/chats/open-store-scope";
import { useSubagentOpenStore } from "@/stores/chats/subagent-open-store";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  VirtuosoMessageList,
  VirtuosoMessageListLicense,
  type DataWithScrollModifier,
  type ItemLocation,
  type ListScrollLocation,
  type ScrollModifier,
  type VirtuosoMessageListMethods,
  type VirtuosoMessageListProps,
} from "@virtuoso.dev/message-list";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";

interface ChatMessagesProps {
  taskTitle: string;
  /** Chat tab identity; keys the composer draft the quote affordance appends to. */
  taskId: string;
  /** The full derived, pinned-todo-stripped row history to hand to Virtuoso. */
  messages: ReadonlyArray<ChatMessageModel>;
  /** Live host-owned background items; undefined means the connected host lacks support. */
  backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  /** User rows for the minimap rail, derived from the same rendered rows. */
  minimapItems: ReadonlyArray<ChatUserMinimapItem>;
  /** Stable per-tile key used to restore reading position across layout remounts. */
  scrollStateKey: string;
  getMessageActions: (message: ChatMessageModel) => ChatMessageActions | null;
  nextStepActions: NextStepActionHandler | null;
  /** Per-tab identity; keys this transcript's saved scroll anchor. */
  instanceId: string;
  /** paneVisible ∧ tab selected: drives the hide/re-show scroll restore. */
  visible: boolean;
  scrollRequest: ChatMessageScrollRequest | null;
}

export interface ChatMessageScrollRequest {
  readonly messageId: string;
  readonly blockId: string;
  readonly requestId: number;
}

interface ChatListContext {
  readonly taskTitle: string;
  readonly hasContent: boolean;
  readonly backgroundToolBlockIds: ReadonlySet<string>;
  readonly getMessageActions: (
    message: ChatMessageModel,
  ) => ChatMessageActions | null;
  readonly nextStepActions: NextStepActionHandler | null;
}

// Keep the overscan conservative: every mounted row is ResizeObserver-measured
// by Virtuoso, and panel resizing can otherwise force too many chat rows to
// remeasure on each drag frame.
const INCREASE_VIEWPORT_BY_PX = 320;
const SCROLLBAR_POINTER_HIT_SLOP_PX = 24;
const TOUCH_SCROLL_DIRECTION_THRESHOLD_PX = 4;
const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

function segmentContainsBlockId(
  segment: MessageSegment,
  blockId: string,
): boolean {
  if (segment.id === blockId) return true;
  if (segment.kind === "subagent") {
    return segment.children.some((child) => child.id === blockId);
  }
  if (segment.kind === "file_change_group") {
    return segment.files.some((file) => file.id === blockId);
  }
  return false;
}

function activityGroupIdForBlock(
  messages: ReadonlyArray<ChatMessageModel>,
  messageId: string,
  blockId: string,
  promotedToolBlockIds: ReadonlySet<string>,
): string | null {
  const message = messages.find((candidate) => candidate.id === messageId);
  if (message === undefined) return null;
  const timeline = buildChatActivityTimeline(message.segments, {
    turnState: message.completedAt === null ? "active" : "complete",
    promotedToolBlockIds,
  });
  for (const item of timeline) {
    if (item.kind !== "activity_group") continue;
    if (
      item.group.segments.some((segment) =>
        segmentContainsBlockId(segment, blockId),
      )
    ) {
      return item.group.id;
    }
  }
  return null;
}

type ChatVirtuosoProps = VirtuosoMessageListProps<
  ChatVirtuosoItem,
  ChatListContext
>;

type ChatVirtuosoItem = ChatMessageModel | undefined;

interface ChatListDataState {
  readonly sourceMessages: ReadonlyArray<ChatMessageModel>;
  readonly value: DataWithScrollModifier<ChatMessageModel>;
  readonly bottomFollowIntent: boolean | null;
}

interface TouchClientYList {
  readonly length: number;
  readonly [index: number]: {
    readonly clientY: number;
  };
}

/**
 * One transcript row. During a panel-resize drag (`traycer-panel-resizing` on
 * `<html>`) every row flips to `content-visibility: hidden`: each pointermove
 * reflows all visible panes, and live rows would re-wrap and re-rasterize
 * every transcript at every intermediate width - a multi-hundred-MB transient
 * spike in the GPU process's tile pool. Hidden rows keep their remembered
 * size (the `auto` intrinsic-size keyword), so Virtuoso's ResizeObserver sees
 * stable heights for the whole drag; one reflow on pointer-up restores
 * content at the final width.
 */
const ChatItemContent: ChatVirtuosoProps["ItemContent"] = ({
  context,
  data: message,
}) => {
  if (message === undefined) return null;

  return (
    <div
      data-message-id={message.id}
      className={cn(
        "mx-auto w-full max-w-3xl px-6 pb-6 [contain:layout_paint_style]",
        message.role === "user"
          ? "[contain-intrinsic-size:auto_8rem]"
          : "[contain-intrinsic-size:auto_14rem]",
      )}
    >
      <ChatMessage
        message={message}
        actions={context.getMessageActions(message)}
        backgroundToolBlockIds={context.backgroundToolBlockIds}
        nextStepActions={context.nextStepActions}
      />
    </div>
  );
};

const ChatListHeader: ChatVirtuosoProps["Header"] = () => (
  <div aria-hidden="true" className="h-10" />
);

const ChatListFooter: ChatVirtuosoProps["Footer"] = () => (
  <div aria-hidden="true" className="h-10" />
);

const ChatListEmptyPlaceholder: ChatVirtuosoProps["EmptyPlaceholder"] = ({
  context,
}) => (context.hasContent ? null : <ChatEmptyState />);

/**
 * Virtualized chat transcript. The full derived row history is handed to
 * Virtuoso, which windows the mounted DOM to the viewport (plus overscan) and
 * owns stick-to-bottom/anchoring through the scroll modifiers from
 * `chat-messages-virtuoso-helpers.ts`.
 */
export function ChatMessages(props: ChatMessagesProps) {
  return (
    <A2AOpenStoreProvider>
      <ChatFindForceStoreProvider tileInstanceId={props.instanceId}>
        <ChatMessagesInner {...props} />
      </ChatFindForceStoreProvider>
    </A2AOpenStoreProvider>
  );
}

function ChatMessagesInner(props: ChatMessagesProps) {
  const {
    getMessageActions,
    backgroundItems,
    instanceId,
    messages,
    minimapItems,
    nextStepActions,
    scrollRequest,
    scrollStateKey,
    taskId,
    taskTitle,
    visible,
  } = props;
  // Restore the persisted reading position once, on mount. The cache key is
  // the stable tile instance id, so re-reading per render would only repeat an
  // O(n) message scan whose result the initializers below already captured.
  const [restoredScrollState] = useState<SavedChatScrollState>(() =>
    restoreChatScrollState(scrollStateKey, messages),
  );
  const virtuosoRef =
    useRef<VirtuosoMessageListMethods<ChatVirtuosoItem, ChatListContext>>(null);
  // The find controller triggers a measured-item change on reveal/reconcile;
  // the concrete callback lives in this component, so the hook reads it lazily
  // through this ref (set in a layout effect below).
  const requestMeasuredItemChangeRef = useRef<() => void>(() => undefined);

  // "Following latest" is user intent. Virtuoso's `isAtBottom` is only a
  // strict measurement signal, so streaming markdown height drift must not be
  // able to unpin the reader by itself. Intent transitions are gesture-driven:
  // position alone never flips it (programmatic streaming scrolls park the
  // viewport near the bottom constantly, and treating that as intent would
  // revert a wheel-up unpin within the same frame).
  const bottomFollowRef = useRef(restoredScrollState.bottomFollowing);
  const scrollbarPointerDragRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const messagesRef = useRef(messages);
  const scrolledActiveUserMessageIdRef = useRef(
    restoredScrollState.activeUserMessageId,
  );
  // Live scroll offset, updated on every scroll. The scroll-restoration chat
  // adapter reads this to snapshot the position on hide/unmount - a direct DOM
  // read at hide time would see the already-`display:none` zero box.
  const savedScrollTopRef = useRef<number | null>(null);
  // Direction of the most recent USER scroll gesture (wheel, scroll keys,
  // touch drag). Programmatic scrolls never write it, which is what lets
  // `handleScroll` tell "the user came back to the bottom" apart from "the
  // stream parked us at the bottom".
  const lastScrollGestureRef = useRef<"up" | "down" | null>(null);
  const [bottomFollowing, setBottomFollowing] = useState(
    restoredScrollState.bottomFollowing,
  );
  const [scrolledActiveUserMessageId, setScrolledActiveUserMessageId] =
    useState<string | null>(restoredScrollState.activeUserMessageId);

  const hasContent = messages.length > 0;
  const backgroundToolBlockIds = useMemo<ReadonlySet<string>>(() => {
    if (backgroundItems === undefined || backgroundItems.length === 0) {
      return EMPTY_BACKGROUND_TOOL_BLOCK_IDS;
    }
    return new Set(
      backgroundItems
        .filter((item) => item.kind !== "subagent")
        .map((item) => item.blockId),
    );
  }, [backgroundItems]);
  const messageIndexById = useMemo(
    () => buildMessageIdToIndex(messages),
    [messages],
  );
  const messageIndexByIdRef = useRef(messageIndexById);
  const scrollRequestRef = useRef(scrollRequest);
  const handledScrollRequestIdRef = useRef<number | null>(null);
  const backgroundToolBlockIdsRef = useRef(backgroundToolBlockIds);
  const [activityGroupOpenStore] = useState(createActivityGroupOpenStore);

  // Quote-to-composer: track selections inside the transcript wrapper below and
  // surface the floating quote button. The hook attaches no listeners while the
  // setting is off, so a disabled affordance costs nothing. `visible` gates
  // too: chat surfaces are keep-alive hidden (display:none) while the popover
  // portals to document.body, so a hidden chat must not keep tracking
  // selections or leave a quote button floating over whichever surface
  // replaced it.
  const quoteReplyEnabled = useSettingsStore(
    (state) => state.quoteReplyEnabled,
  );
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const quoteSelection = useQuoteSelection({
    containerRef: transcriptContainerRef,
    enabled: quoteReplyEnabled && visible,
  });

  const [listDataState, setListDataState] = useState<ChatListDataState>(() =>
    createInitialChatListDataState(messages, restoredScrollState),
  );

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useLayoutEffect(() => {
    messageIndexByIdRef.current = messageIndexById;
  }, [messageIndexById]);

  useLayoutEffect(() => {
    scrollRequestRef.current = scrollRequest;
  }, [scrollRequest]);

  useLayoutEffect(() => {
    backgroundToolBlockIdsRef.current = backgroundToolBlockIds;
  }, [backgroundToolBlockIds]);

  useLayoutEffect(() => {
    useToolOpenStore.getState().reset(instanceId);
    useSubagentOpenStore.getState().reset(instanceId);
  }, [instanceId]);

  let effectiveBottomFollowing = bottomFollowing;
  let listData = listDataState.value;
  if (listDataState.sourceMessages !== messages) {
    const nextListDataState = createChatListDataState(
      listDataState.sourceMessages,
      messages,
      bottomFollowing,
    );
    if (nextListDataState.bottomFollowIntent !== null) {
      effectiveBottomFollowing = nextListDataState.bottomFollowIntent;
      if (bottomFollowing !== nextListDataState.bottomFollowIntent) {
        setBottomFollowing(nextListDataState.bottomFollowIntent);
      }
    }
    setListDataState(nextListDataState);
    listData = nextListDataState.value;
  }

  const setBottomFollowingIfChanged = useCallback((next: boolean): void => {
    if (bottomFollowRef.current === next) return;
    bottomFollowRef.current = next;
    setBottomFollowing(next);
  }, []);

  // The render-adjust above may flip the follow intent via plain setState
  // (writing the ref there would be a render-phase ref mutation); converge
  // the ref pre-paint instead.
  useLayoutEffect(() => {
    bottomFollowRef.current = bottomFollowing;
  }, [bottomFollowing]);

  const setScrolledActiveUserMessageIdIfChanged = useCallback(
    (next: string | null): void => {
      scrolledActiveUserMessageIdRef.current = next;
      setScrolledActiveUserMessageId((current) =>
        current === next ? current : next,
      );
    },
    [],
  );

  // Recompute the active rail entry from the live viewport, coalesced to one
  // layout read per frame. When tailing the latest message the reading line is
  // irrelevant (the active entry is always the newest), so that case skips the
  // DOM probe entirely.
  const scheduleActiveViewportUpdate = useAnimationFrameThrottle(
    useCallback(
      (atBottom: boolean): void => {
        if (atBottom && bottomFollowRef.current) {
          setScrolledActiveUserMessageIdIfChanged(
            selectActiveUserMessageId(messages, null, true),
          );
          return;
        }
        const scroller = virtuosoRef.current?.scrollerElement() ?? null;
        const activeUserMessageId = viewportActiveUserMessageId(
          scroller,
          messages,
        );
        if (activeUserMessageId === null) return;
        setScrolledActiveUserMessageIdIfChanged(activeUserMessageId);
      },
      [messages, setScrolledActiveUserMessageIdIfChanged],
    ),
  );

  // display:none keep-alive only suspends a tile; moving it between panes or
  // dropping it past the mounted-tab LRU cap unmounts it. Persist the reading
  // position on unmount so the next mount restores it.
  useLayoutEffect(
    () => () => {
      saveChatScrollState({
        key: scrollStateKey,
        bottomFollowing: bottomFollowRef.current,
        messages: messagesRef.current,
        scroller: virtuosoRef.current?.scrollerElement() ?? null,
        activeUserMessageId: scrolledActiveUserMessageIdRef.current,
      });
    },
    [scrollStateKey],
  );

  const activeUserMessageId = effectiveBottomFollowing
    ? (minimapItems.at(-1)?.id ?? null)
    : scrolledActiveUserMessageId;

  const context = useMemo<ChatListContext>(
    () => ({
      taskTitle,
      hasContent,
      backgroundToolBlockIds,
      getMessageActions,
      nextStepActions,
    }),
    [
      backgroundToolBlockIds,
      getMessageActions,
      hasContent,
      nextStepActions,
      taskTitle,
    ],
  );

  // Preserve/restore the reading position across keep-alive hiding and full
  // remount. Pinned readers snap back to the latest message; unpinned readers
  // return to their saved offset (and stay unpinned so a post-remount stream
  // doesn't yank them to the bottom). Capture reads the live refs above, since
  // `display:none` has already zeroed the scroller by commit time.
  const scrollRestorationAdapter = useMemo<ScrollRestorationAdapter>(
    () => ({
      captureAnchor: () => {
        if (bottomFollowRef.current) {
          return { kind: "chat", followingBottom: true, scrollTop: 0 };
        }
        const savedScrollTop = savedScrollTopRef.current;
        if (savedScrollTop === null) return null;
        return {
          kind: "chat",
          followingBottom: false,
          scrollTop: savedScrollTop,
        };
      },
      applyAnchor: (anchor) => {
        if (anchor.kind !== "chat") return "gave-up";
        if (anchor.followingBottom) {
          virtuosoRef.current?.scrollToItem({
            index: "LAST",
            align: "end",
            behavior: "auto",
          });
          return "applied";
        }
        const scroller = virtuosoRef.current?.scrollerElement();
        if (scroller === null || scroller === undefined) return "retry";
        if (scroller.scrollHeight === 0) return "retry";
        setBottomFollowingIfChanged(false);
        // While `display:none` the message list measures a 0x0 box and latches
        // its internal `atBottom = true`; on re-show the scrollHeight grows
        // 0 -> full, which it reads as "content grew while at the bottom" and
        // fires a stick-to-bottom autoscroll (ResizeObserver-driven, so it
        // lands AFTER this layout-effect restore). Cancel that autoscroll and
        // re-assert our offset. Returning "defend" (not "applied") makes the
        // orchestrator's rAF loop keep countering across the post-resize frames
        // - whenever the autoscroll fires within the retry window - instead of
        // losing a single race. We do NOT early-exit on a position match: a
        // reader saved at the very top (offset 0) matches the display:none-reset
        // scroller before the stick fires, so stopping there would still let it
        // yank to the bottom.
        virtuosoRef.current?.cancelSmoothScroll();
        if (Math.abs(scroller.scrollTop - anchor.scrollTop) > 1) {
          scroller.scrollTop = anchor.scrollTop;
        }
        return "defend";
      },
    }),
    [setBottomFollowingIfChanged],
  );
  const cancelScrollRestorationRetry = useScrollRestoration(
    instanceId,
    scrollRestorationAdapter,
    visible,
    hasContent,
  );

  // Unpin gestures also cancel any in-flight programmatic smooth scroll:
  // Virtuoso's animation re-writes scrollTop every frame for up to ~50 frames,
  // so without the cancel the list physically fights the user's input.
  const unpinFromUserGesture = useCallback((): void => {
    cancelScrollRestorationRetry();
    lastScrollGestureRef.current = "up";
    virtuosoRef.current?.cancelSmoothScroll();
    setBottomFollowingIfChanged(false);
  }, [cancelScrollRestorationRetry, setBottomFollowingIfChanged]);

  // A downward user gesture (wheel/keys/touch toward the tail) also takes over
  // from an in-flight restore: cancel the defend loop so it can't re-assert the
  // saved offset against the user's own scroll during the post-show window.
  // No-op outside that window (no retry in flight).
  const markDownwardUserGesture = useCallback((): void => {
    cancelScrollRestorationRetry();
    lastScrollGestureRef.current = "down";
  }, [cancelScrollRestorationRetry]);

  const handleScroll = useCallback(
    (location: ListScrollLocation): void => {
      // Concealed surfaces report zero-size locations; those must not clobber
      // the saved position, the follow intent, or the window size.
      if (!visible) return;
      if (location.visibleListHeight <= 0) return;
      const scroller = virtuosoRef.current?.scrollerElement();
      if (scroller !== null && scroller !== undefined) {
        savedScrollTopRef.current = scroller.scrollTop;
      }
      const nearBottom = isNearChatBottom(location);
      scheduleActiveViewportUpdate(nearBottom);
      if (nearBottom) {
        // Near the bottom. Re-pin only when the USER drove the viewport here -
        // streaming-driven scrolls land in this band constantly, and an
        // unconditional re-pin would revert a wheel-up unpin via the very
        // scroll event that wheel produced.
        if (
          lastScrollGestureRef.current === "down" ||
          scrollbarPointerDragRef.current
        ) {
          scrollbarPointerDragRef.current = false;
          setBottomFollowingIfChanged(true);
        }
      } else if (scrollbarPointerDragRef.current) {
        setBottomFollowingIfChanged(false);
      }
    },
    [scheduleActiveViewportUpdate, setBottomFollowingIfChanged, visible],
  );

  const handleWheelCapture = useCallback<WheelEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.deltaY < 0) {
        unpinFromUserGesture();
        return;
      }
      if (event.deltaY > 0) {
        markDownwardUserGesture();
      }
    },
    [markDownwardUserGesture, unpinFromUserGesture],
  );

  const handleKeyDownCapture = useCallback<
    KeyboardEventHandler<HTMLDivElement>
  >(
    (event) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home"
      ) {
        unpinFromUserGesture();
        return;
      }
      if (
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        event.key === "End"
      ) {
        markDownwardUserGesture();
      }
    },
    [markDownwardUserGesture, unpinFromUserGesture],
  );

  const handlePointerDownCapture = useCallback<
    PointerEventHandler<HTMLDivElement>
  >((event) => {
    const distanceFromRightEdge =
      event.currentTarget.clientWidth - event.clientX;
    scrollbarPointerDragRef.current =
      distanceFromRightEdge <= SCROLLBAR_POINTER_HIT_SLOP_PX;
  }, []);

  const handlePointerUpCapture = useCallback<
    PointerEventHandler<HTMLDivElement>
  >(() => {
    scrollbarPointerDragRef.current = false;
  }, []);

  const handleTouchStartCapture = useCallback<
    TouchEventHandler<HTMLDivElement>
  >((event) => {
    lastTouchClientYRef.current = firstTouchClientY(event.touches);
  }, []);

  const handleTouchMoveCapture = useCallback<TouchEventHandler<HTMLDivElement>>(
    (event) => {
      const previousClientY = lastTouchClientYRef.current;
      const nextClientY = firstTouchClientY(event.touches);
      lastTouchClientYRef.current = nextClientY;
      if (previousClientY === null || nextClientY === null) return;
      const deltaY = nextClientY - previousClientY;
      // Finger moving down drags the content up (away from the tail).
      if (deltaY > TOUCH_SCROLL_DIRECTION_THRESHOLD_PX) {
        unpinFromUserGesture();
        return;
      }
      if (deltaY < -TOUCH_SCROLL_DIRECTION_THRESHOLD_PX) {
        markDownwardUserGesture();
      }
    },
    [markDownwardUserGesture, unpinFromUserGesture],
  );

  const handleTouchEndCapture = useCallback<
    TouchEventHandler<HTMLDivElement>
  >(() => {
    lastTouchClientYRef.current = null;
  }, []);

  const handleRenderedDataChange = useCallback((): void => {
    scheduleActiveViewportUpdate(bottomFollowRef.current);
  }, [scheduleActiveViewportUpdate]);

  const jumpToBottom = useCallback((): void => {
    // Optimistically reflect the impending state so the chip hides
    // immediately. The follow intent keeps subsequent streamed updates pinned
    // while Virtuoso completes the smooth scroll. Cancel any in-flight restore
    // so the defend loop can't fight this smooth scroll to the tail.
    cancelScrollRestorationRetry();
    setBottomFollowingIfChanged(true);
    virtuosoRef.current?.scrollToItem({
      index: "LAST",
      align: "end",
      behavior: "smooth",
    });
  }, [cancelScrollRestorationRetry, setBottomFollowingIfChanged]);

  const getScroller = useCallback(
    (): HTMLElement | null => virtuosoRef.current?.scrollerElement() ?? null,
    [],
  );

  const scrollToItem = useCallback((location: ItemLocation): void => {
    virtuosoRef.current?.scrollToItem(location);
  }, []);

  const resetScrollGesture = useCallback((): void => {
    lastScrollGestureRef.current = null;
  }, []);

  const {
    scheduleMountedHighlightSync: scheduleChatFindHighlightSync,
    onRenderedDataChange: onChatFindRenderedDataChange,
  } = useChatFindController({
    instanceId,
    messages,
    messagesRef,
    messageIndexByIdRef,
    getScroller,
    scrollToItem,
    requestMeasuredItemChangeRef,
    setBottomFollowingIfChanged,
    setScrolledActiveUserMessageIdIfChanged,
    cancelScrollRestorationRetry,
    resetScrollGesture,
  });

  const requestMeasuredItemChange = useCallback((): void => {
    const shouldFollowOutput = bottomFollowRef.current;
    setListDataState((current) => ({
      sourceMessages: current.sourceMessages,
      bottomFollowIntent: null,
      value: {
        data: current.sourceMessages.slice(),
        scrollModifier: measuredItemChangeScrollModifier(shouldFollowOutput),
      },
    }));
    scheduleChatFindHighlightSync();
  }, [scheduleChatFindHighlightSync]);

  useLayoutEffect(() => {
    requestMeasuredItemChangeRef.current = requestMeasuredItemChange;
  }, [requestMeasuredItemChange]);

  const navigateToMessage = useCallback(
    (messageId: string): void => {
      // This navigation is programmatic. If it parks inside the bottom
      // tolerance band, emitted scroll events must not read as user intent to
      // tail the latest message.
      lastScrollGestureRef.current = null;
      setBottomFollowingIfChanged(false);
      setScrolledActiveUserMessageIdIfChanged(messageId);
      // The full row history is mounted in Virtuoso, so every persisted
      // minimap target resolves; pending/live rows may briefly miss.
      const location = chatScrollLocationForMessage(
        messageId,
        messageIndexByIdRef.current,
        "smooth",
      );
      if (location === null) return;
      virtuosoRef.current?.scrollToItem(location);
    },
    [setBottomFollowingIfChanged, setScrolledActiveUserMessageIdIfChanged],
  );

  const handleRenderedDataChangeWithFind = useCallback((): void => {
    handleRenderedDataChange();
    onChatFindRenderedDataChange();
  }, [handleRenderedDataChange, onChatFindRenderedDataChange]);

  const onMinimapItemClick = useCallback(
    (messageId: string): void => navigateToMessage(messageId),
    [navigateToMessage],
  );

  useLayoutEffect(() => {
    const request = scrollRequestRef.current;
    if (request === null) return;
    if (handledScrollRequestIdRef.current === request.requestId) return;
    handledScrollRequestIdRef.current = request.requestId;
    const activityGroupId = activityGroupIdForBlock(
      messagesRef.current,
      request.messageId,
      request.blockId,
      backgroundToolBlockIdsRef.current,
    );
    if (activityGroupId !== null) {
      activityGroupOpenStore.getState().setOpen(activityGroupId, true);
    }
    navigateToMessage(request.messageId);
    scrollRequestRef.current = null;
  }, [activityGroupOpenStore, navigateToMessage, scrollRequest?.requestId]);

  return (
    <ChatOpenStoreScopeProvider value={instanceId}>
      <ActivityGroupOpenStoreProvider store={activityGroupOpenStore}>
        <ChatMeasuredItemChangeContext.Provider
          value={requestMeasuredItemChange}
        >
          <div
            {...chatMinimapClipRegionProps}
            ref={transcriptContainerRef}
            className="relative flex-1 overflow-hidden"
          >
            <VirtuosoMessageListLicense
              licenseKey={VIRTUOSO_MESSAGE_LIST_LICENSE_KEY}
            >
              <VirtuosoMessageList<ChatVirtuosoItem, ChatListContext>
                ref={virtuosoRef}
                data={listData}
                context={context}
                computeItemKey={chatComputeItemKey}
                itemIdentity={chatItemIdentity}
                shortSizeAlign="top"
                increaseViewportBy={INCREASE_VIEWPORT_BY_PX}
                ItemContent={ChatItemContent}
                Header={ChatListHeader}
                Footer={ChatListFooter}
                EmptyPlaceholder={ChatListEmptyPlaceholder}
                className="chat-scrollbar-native-thin mr-1 h-full overflow-y-auto"
                data-testid="chat-messages-scroll"
                onScroll={handleScroll}
                onWheelCapture={handleWheelCapture}
                onKeyDownCapture={handleKeyDownCapture}
                onPointerDownCapture={handlePointerDownCapture}
                onPointerUpCapture={handlePointerUpCapture}
                onPointerCancelCapture={handlePointerUpCapture}
                onTouchStartCapture={handleTouchStartCapture}
                onTouchMoveCapture={handleTouchMoveCapture}
                onTouchEndCapture={handleTouchEndCapture}
                onTouchCancelCapture={handleTouchEndCapture}
                onRenderedDataChange={handleRenderedDataChangeWithFind}
              />
            </VirtuosoMessageListLicense>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-background to-transparent"
            />
            {hasContent ? (
              <ChatUserMessageMinimap
                items={minimapItems}
                activeMessageId={activeUserMessageId}
                onItemClick={onMinimapItemClick}
              />
            ) : null}
            {hasContent ? (
              <ScrollToBottomChip
                visible={!effectiveBottomFollowing}
                onClick={jumpToBottom}
              />
            ) : null}
            {quoteSelection.snapshot !== null ? (
              <QuoteSelectionPopover
                taskId={taskId}
                snapshot={quoteSelection.snapshot}
                onDismiss={quoteSelection.dismiss}
                boundaryRef={transcriptContainerRef}
              />
            ) : null}
          </div>
        </ChatMeasuredItemChangeContext.Provider>
      </ActivityGroupOpenStoreProvider>
    </ChatOpenStoreScopeProvider>
  );
}

function createChatListDataState(
  previousMessages: ReadonlyArray<ChatMessageModel> | null,
  messages: ReadonlyArray<ChatMessageModel>,
  shouldFollowOutput: boolean,
): ChatListDataState {
  const policy = classifyChatScrollPolicy({
    previousMessages,
    nextMessages: messages,
    shouldFollowOutput,
  });
  return {
    sourceMessages: messages,
    bottomFollowIntent: policy.bottomFollowIntent,
    value: {
      data: messages.slice(),
      scrollModifier: policy.scrollModifier,
    },
  };
}

function createInitialChatListDataState(
  messages: ReadonlyArray<ChatMessageModel>,
  restoredScrollState: SavedChatScrollState,
): ChatListDataState {
  const scrollModifier = initialRestoredScrollModifier(
    messages,
    restoredScrollState,
  );
  if (scrollModifier === null) {
    return createChatListDataState(
      null,
      messages,
      restoredScrollState.bottomFollowing,
    );
  }
  return {
    sourceMessages: messages,
    bottomFollowIntent: false,
    value: {
      data: messages.slice(),
      scrollModifier,
    },
  };
}

function initialRestoredScrollModifier(
  messages: ReadonlyArray<ChatMessageModel>,
  restoredScrollState: SavedChatScrollState,
): ScrollModifier | null {
  if (restoredScrollState.bottomFollowing) return null;
  const activeUserMessageId = restoredScrollState.activeUserMessageId;
  if (activeUserMessageId === null) return null;
  const location = chatScrollLocationForMessage(
    activeUserMessageId,
    buildMessageIdToIndex(messages),
    "auto",
  );
  if (location === null) return null;
  return {
    type: "item-location",
    location,
    purgeItemSizes: false,
  };
}

function firstTouchClientY(touches: TouchClientYList): number | null {
  if (touches.length === 0) return null;
  return touches[0].clientY;
}
