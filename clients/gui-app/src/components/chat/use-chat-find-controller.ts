import {
  buildChatFindRows,
  createChatFindAdapter,
  queryMountedChatFindUnit,
  type ChatFindAdapter,
  type ChatFindReconcileTarget,
  type ChatFindRevealTarget,
} from "@/components/chat/chat-find";
import {
  serializeChatCollapsibleKey,
  type ChatCollapsibleKey,
} from "@/components/chat/chat-collapsible-key";
import {
  chatTimelineLocationForMessage,
  chatViewportAnchorRowIndex,
  selectActiveUserMessageId,
  type ChatTimelineNavigationLocation,
  type ChatViewportAnchorListState,
} from "@/components/chat/chat-messages-scroll-helpers";
import type { RequestChatMeasuredItemChange } from "@/components/chat/chat-measured-item-change-context";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { useSetChatFindForcedOpen } from "@/stores/chats/chat-find-force-store-context";
import { arrayShallowEq } from "@/stores/epics/open-epic/projection-helpers";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  use,
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

const FIND_REVEAL_ANCHOR_RETRY_LIMIT = 3;

interface FindOpenedTargetState {
  readonly messageId: string;
  readonly unitId: string;
  readonly chainKeyIds: ReadonlyArray<string>;
}

interface ChatFindControllerArgs {
  readonly instanceId: string;
  /** Live transcript; drives the notify-rows-changed lifecycle. */
  readonly messages: ReadonlyArray<ChatMessageModel>;
  /** Latest transcript, read lazily by the adapter's getRows supplier. */
  readonly messagesRef: RefObject<ReadonlyArray<ChatMessageModel>>;
  readonly messageIndexByIdRef: RefObject<ReadonlyMap<string, number>>;
  readonly getScroller: () => HTMLElement | null;
  /** LegendList's own measured positions (no DOM rect probing - jsdom
   *  reports unreliable, non-scroll-relative rects for virtualized rows),
   *  for resolving the row at the viewport's reading line. */
  readonly getViewportAnchorListState: () => ChatViewportAnchorListState | null;
  readonly scrollToLocation: (location: ChatTimelineNavigationLocation) => void;
  /** Manual-navigation cancel (decision #21: find performs it first). */
  readonly cancelManualNavigation: () => void;
  readonly setScrolledActiveUserMessageIdIfChanged: (
    next: string | null,
  ) => void;
  /** Disclosure-preserving flushSync helper (chat-scroll-disclosure.ts),
   *  shared with segment toggles - see `requestFindReveal`'s use below. */
  readonly requestMeasuredItemChange: RequestChatMeasuredItemChange;
}

interface ChatFindController {
  /** Repaint the mounted highlight after a measured-item layout change. */
  readonly scheduleMountedHighlightSync: () => void;
  /** Find-side follow-up to the timeline's rendered-data change. */
  readonly onRenderedDataChange: () => void;
}

/**
 * Owns chat find registration, active-match reveal/reconcile orchestration, and
 * the mounted-highlight resync loop. Lifted out of `chat-messages.tsx` so the
 * renderer returns to message-list orchestration and the find machinery has a
 * single home. The adapter pulls rows lazily via a `getRows()` supplier, so a
 * closed find bar pays no transcript-projection cost on streaming updates.
 */
export function useChatFindController(
  args: ChatFindControllerArgs,
): ChatFindController {
  const {
    instanceId,
    messages,
    messagesRef,
    messageIndexByIdRef,
    getScroller,
    getViewportAnchorListState,
    scrollToLocation,
    cancelManualNavigation,
    setScrolledActiveUserMessageIdIfChanged,
    requestMeasuredItemChange,
  } = args;

  const setFindForcedOpen = useSetChatFindForcedOpen();
  const tileFindContext = use(TileFindContext);

  const chatFindAdapterRef = useRef<ChatFindAdapter | null>(null);
  const activeFindRevealRef = useRef<ChatFindRevealTarget | null>(null);
  const findRevealGenerationRef = useRef(0);
  const findRevealFrameRef = useRef<number | null>(null);
  const findRevealAnchorMissCountRef = useRef(0);
  const findRevealSkipUnitScrollRef = useRef(false);
  const findOpenedChainRef = useRef<ReadonlyArray<ChatCollapsibleKey>>([]);
  const findOpenedTargetRef = useRef<FindOpenedTargetState | null>(null);
  const mountedHighlightSyncFrameRef = useRef<number | null>(null);

  const scrollToMessageForFindRef = useRef<(messageId: string) => void>(
    () => undefined,
  );
  const getMountedFindUnitRootRef = useRef<
    (messageId: string, unitId: string) => HTMLElement | null
  >(() => null);
  const getMountedMessageRootRef = useRef<
    (messageId: string) => HTMLElement | null
  >(() => null);
  const scheduleFindRevealStepRef = useRef<
    (generation: number, skipUnitScroll: boolean) => void
  >(() => undefined);

  const cancelFindRevealFrame = useCallback((): void => {
    if (findRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(findRevealFrameRef.current);
      findRevealFrameRef.current = null;
    }
  }, []);

  const cancelMountedHighlightSyncFrame = useCallback((): void => {
    if (mountedHighlightSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(mountedHighlightSyncFrameRef.current);
      mountedHighlightSyncFrameRef.current = null;
    }
  }, []);

  const scheduleMountedHighlightSync = useCallback((): void => {
    cancelMountedHighlightSyncFrame();
    mountedHighlightSyncFrameRef.current = window.requestAnimationFrame(() => {
      mountedHighlightSyncFrameRef.current = null;
      if (activeFindRevealRef.current !== null) return;
      chatFindAdapterRef.current?.syncMountedHighlight();
    });
  }, [cancelMountedHighlightSyncFrame]);

  useLayoutEffect(
    () => () => {
      cancelFindRevealFrame();
      cancelMountedHighlightSyncFrame();
    },
    [cancelFindRevealFrame, cancelMountedHighlightSyncFrame],
  );

  const scrollToMessageForFind = useCallback(
    (messageId: string): void => {
      cancelManualNavigation();
      setScrolledActiveUserMessageIdIfChanged(
        selectActiveUserMessageId(messagesRef.current, messageId, false),
      );
      const location = chatTimelineLocationForMessage(
        messageId,
        messageIndexByIdRef.current,
        false,
      );
      if (location === null) return;
      scrollToLocation(location);
    },
    [
      cancelManualNavigation,
      messageIndexByIdRef,
      messagesRef,
      scrollToLocation,
      setScrolledActiveUserMessageIdIfChanged,
    ],
  );

  const getMountedMessageRoot = useCallback(
    (messageId: string): HTMLElement | null => {
      const scroller = getScroller();
      if (scroller === null) return null;
      for (const row of scroller.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      )) {
        if (row.dataset.messageId === messageId) return row;
      }
      return null;
    },
    [getScroller],
  );

  const getMountedFindUnitRoot = useCallback(
    (messageId: string, unitId: string): HTMLElement | null => {
      const messageRoot = getMountedMessageRoot(messageId);
      if (messageRoot === null) return null;
      return queryMountedChatFindUnit(messageRoot, unitId);
    },
    [getMountedMessageRoot],
  );

  useLayoutEffect(() => {
    scrollToMessageForFindRef.current = scrollToMessageForFind;
  }, [scrollToMessageForFind]);

  useLayoutEffect(() => {
    getMountedMessageRootRef.current = getMountedMessageRoot;
  }, [getMountedMessageRoot]);

  useLayoutEffect(() => {
    getMountedFindUnitRootRef.current = getMountedFindUnitRoot;
  }, [getMountedFindUnitRoot]);

  const applyFindOpenedChain = useCallback(
    (nextChain: ReadonlyArray<ChatCollapsibleKey>): void => {
      const nextKeyIds = new Set(nextChain.map(serializeChatCollapsibleKey));
      findOpenedChainRef.current.forEach((key) => {
        if (!nextKeyIds.has(serializeChatCollapsibleKey(key))) {
          setFindForcedOpen(key, false);
        }
      });
      nextChain.forEach((key) => {
        setFindForcedOpen(key, true);
      });
      findOpenedChainRef.current = nextChain.slice();
    },
    [setFindForcedOpen],
  );

  // Anchors a find chain-open on the row currently at the viewport's own top
  // edge (not the reveal target - the target is scrolled to separately right
  // after) - see requestMeasuredItemChange's caller below and
  // chat-scroll-disclosure.ts's doc comment for why the top edge specifically.
  // Resolved from LegendList's own measured positions (no DOM rect probing -
  // jsdom reports unreliable, non-scroll-relative rects for virtualized rows),
  // matching viewportActiveUserMessageId's approach; only the final anchor
  // element itself needs a real DOM node, since
  // preserveChatScrollAcrossDisclosureChange measures its live rect.
  const getViewportTopAnchorElement = useCallback((): HTMLElement | null => {
    const state = getViewportAnchorListState();
    if (state === null) return null;
    const rowIndex = chatViewportAnchorRowIndex(
      state,
      messagesRef.current.length,
      0,
    );
    if (rowIndex === null) return null;
    // chatViewportAnchorRowIndex clamps its result to [0, rowCount - 1] - a
    // non-null return is always a valid index into messagesRef.current.
    return getMountedMessageRoot(messagesRef.current[rowIndex].id);
  }, [getMountedMessageRoot, getViewportAnchorListState, messagesRef]);

  const applyFindOpenedTarget = useCallback(
    (
      target: ChatFindReconcileTarget,
      forceApply: boolean,
      preserveScrollAcrossOpen: boolean,
    ): boolean => {
      const chainKeyIds = target.owningChain.map(serializeChatCollapsibleKey);
      const previousTarget = findOpenedTargetRef.current;
      const targetChanged =
        previousTarget === null ||
        previousTarget.messageId !== target.messageId ||
        previousTarget.unitId !== target.unitId ||
        !arrayShallowEq(previousTarget.chainKeyIds, chainKeyIds);
      if (!forceApply && !targetChanged) return false;
      if (preserveScrollAcrossOpen) {
        requestMeasuredItemChange(getViewportTopAnchorElement(), () =>
          applyFindOpenedChain(target.owningChain),
        );
      } else {
        applyFindOpenedChain(target.owningChain);
      }
      findOpenedTargetRef.current = {
        messageId: target.messageId,
        unitId: target.unitId,
        chainKeyIds,
      };
      return true;
    },
    [
      applyFindOpenedChain,
      getViewportTopAnchorElement,
      requestMeasuredItemChange,
    ],
  );

  const releaseFindOpenedChain = useCallback((): void => {
    findOpenedChainRef.current.forEach((key) => {
      setFindForcedOpen(key, false);
    });
    findOpenedChainRef.current = [];
    findOpenedTargetRef.current = null;
  }, [setFindForcedOpen]);

  const clearFindReveal = useCallback((): void => {
    findRevealGenerationRef.current += 1;
    activeFindRevealRef.current = null;
    findRevealAnchorMissCountRef.current = 0;
    cancelFindRevealFrame();
    releaseFindOpenedChain();
  }, [cancelFindRevealFrame, releaseFindOpenedChain]);

  const scheduleFindRevealStep = useCallback(
    (generation: number, skipUnitScroll: boolean): void => {
      cancelFindRevealFrame();
      findRevealFrameRef.current = window.requestAnimationFrame(() => {
        findRevealFrameRef.current = null;
        if (findRevealGenerationRef.current !== generation) return;
        const target = activeFindRevealRef.current;
        if (target === null) return;
        const unitRoot = getMountedFindUnitRootRef.current(
          target.messageId,
          target.unitId,
        );
        if (unitRoot === null) {
          scrollToMessageForFindRef.current(target.messageId);
          const messageRoot = getMountedMessageRootRef.current(
            target.messageId,
          );
          if (messageRoot === null) return;
          if (
            findRevealAnchorMissCountRef.current <
            FIND_REVEAL_ANCHOR_RETRY_LIMIT
          ) {
            findRevealAnchorMissCountRef.current += 1;
            scheduleFindRevealStepRef.current(generation, skipUnitScroll);
            return;
          }
          target.paintFallback();
          if (activeFindRevealRef.current?.matchKey === target.matchKey) {
            activeFindRevealRef.current = null;
          }
          return;
        }
        findRevealAnchorMissCountRef.current = 0;
        // An in-place hop stays in the same already-open unit, so re-centering
        // the row would churn the layout (flicker) for no reason. Skip the
        // unit re-center and let the active-match paint scroll only the inner
        // scroll container to the next occurrence.
        if (!skipUnitScroll) {
          unitRoot.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "auto",
          });
        }
        findRevealFrameRef.current = window.requestAnimationFrame(() => {
          findRevealFrameRef.current = null;
          if (findRevealGenerationRef.current !== generation) return;
          if (activeFindRevealRef.current?.matchKey !== target.matchKey) return;
          target.paint();
          if (activeFindRevealRef.current.matchKey === target.matchKey) {
            activeFindRevealRef.current = null;
          }
        });
      });
    },
    [cancelFindRevealFrame],
  );

  useLayoutEffect(() => {
    scheduleFindRevealStepRef.current = scheduleFindRevealStep;
  }, [scheduleFindRevealStep]);

  const requestFindReveal = useCallback(
    (target: ChatFindRevealTarget): void => {
      // Consecutive matches inside the same already-revealed unit are an
      // in-place hop: the row is mounted and positioned, so scrolling the row
      // and re-centering the unit would visibly flicker. Detect it against the
      // previous reveal target before applyFindOpenedTarget overwrites it.
      const previousTarget = findOpenedTargetRef.current;
      const sameUnit =
        previousTarget !== null &&
        previousTarget.messageId === target.messageId &&
        previousTarget.unitId === target.unitId;
      const generation = findRevealGenerationRef.current + 1;
      findRevealGenerationRef.current = generation;
      activeFindRevealRef.current = target;
      findRevealAnchorMissCountRef.current = 0;
      findRevealSkipUnitScrollRef.current = sameUnit;
      // LegendList remeasures a row's height via its own per-row
      // ResizeObserver, so the chain-open below picks up the target row's OWN
      // layout change without an explicit nudge. What LegendList does not do
      // is correct the scroll offset for content ABOVE the viewport changing
      // size (`maintainVisibleContentPosition.size` is off), so an
      // uncorrected chain-open revealing a deeply nested match can shift the
      // reader's current view before the deliberate scroll below catches up.
      // `preserveScrollAcrossOpen: true` closes that gap: the chain-open runs
      // through the same flushSync + geometric-delta helper segment toggles
      // use (chat-scroll-disclosure.ts), anchored on the row at the
      // viewport's own top edge, so the reader's view stays pixel-stable
      // across the open and this frame's scroll lands cleanly on top of it.
      // This is safe here because a live find navigation (search/next/
      // previous) always originates from a real DOM event handler - the one
      // reachable exception is the tile-find store's registration-time
      // search REPLAY (an open session restored across a chat tile's
      // whole-tile remount on tab switch), which runs synchronously inside
      // this controller's own adapter-registration layout effect; flushSync
      // there degrades to a warned no-op (see chat-messages.tsx's
      // scroll-request effect comment for why), so that one path keeps the
      // pre-ticket-6 jump risk. Not fixed here: doing so would mean deferring
      // this call (e.g. a microtask) uniformly, which risks the delicate
      // generation/rAF sequencing above for a narrow, low-stakes case (a
      // tile that's remounting has no settled reading position to protect
      // yet).
      applyFindOpenedTarget(target, true, true);
      cancelFindRevealFrame();
      findRevealFrameRef.current = window.requestAnimationFrame(() => {
        findRevealFrameRef.current = null;
        if (findRevealGenerationRef.current !== generation) return;
        if (!sameUnit) scrollToMessageForFind(target.messageId);
        scheduleFindRevealStep(generation, sameUnit);
      });
    },
    [
      applyFindOpenedTarget,
      cancelFindRevealFrame,
      scheduleFindRevealStep,
      scrollToMessageForFind,
    ],
  );

  const requestFindReconcile = useCallback(
    (target: ChatFindReconcileTarget): void => {
      // Passive streaming resync of an already-active target, not a user-
      // driven reveal - no scroll-preservation wrapping needed here.
      applyFindOpenedTarget(target, false, false);
    },
    [applyFindOpenedTarget],
  );

  useLayoutEffect(() => {
    chatFindAdapterRef.current?.notifyRowsChanged();
  }, [messages]);

  useLayoutEffect(() => {
    if (tileFindContext === null) return undefined;

    const adapter = createChatFindAdapter({
      tileInstanceId: instanceId,
      getRows: () => buildChatFindRows(messagesRef.current, instanceId),
      revealMatch: requestFindReveal,
      reconcileMatch: requestFindReconcile,
      clearReveal: clearFindReveal,
      getMountedMessageRoot: (messageId) => getMountedMessageRoot(messageId),
      getMountedUnitRoot: (messageId, unitId) =>
        getMountedFindUnitRootRef.current(messageId, unitId),
    });
    chatFindAdapterRef.current = adapter;
    const unregisterAdapter = tileFindContext.registerAdapter(adapter);

    return () => {
      unregisterAdapter();
      if (chatFindAdapterRef.current === adapter) {
        chatFindAdapterRef.current = null;
      }
      adapter.dispose();
    };
  }, [
    clearFindReveal,
    getMountedMessageRoot,
    instanceId,
    messagesRef,
    requestFindReconcile,
    requestFindReveal,
    tileFindContext,
  ]);

  const onRenderedDataChange = useCallback((): void => {
    const activeReveal = activeFindRevealRef.current;
    if (activeReveal !== null) {
      scheduleFindRevealStep(
        findRevealGenerationRef.current,
        findRevealSkipUnitScrollRef.current,
      );
      return;
    }
    chatFindAdapterRef.current?.syncMountedHighlight();
  }, [scheduleFindRevealStep]);

  return {
    scheduleMountedHighlightSync,
    onRenderedDataChange,
  };
}
