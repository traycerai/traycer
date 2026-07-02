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
  chatScrollLocationForMessage,
  selectActiveUserMessageId,
} from "@/components/chat/chat-messages-virtuoso-helpers";
import { TileFindContext } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { useSetChatFindForcedOpen } from "@/stores/chats/chat-find-force-store-context";
import { arrayShallowEq } from "@/stores/epics/open-epic/projection-helpers";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { ItemLocation } from "@virtuoso.dev/message-list";
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
  readonly scrollToItem: (location: ItemLocation) => void;
  /** Component-owned measured-item-change trigger, read through a ref. */
  readonly requestMeasuredItemChangeRef: RefObject<() => void>;
  readonly setBottomFollowingIfChanged: (next: boolean) => void;
  readonly setScrolledActiveUserMessageIdIfChanged: (
    next: string | null,
  ) => void;
  readonly cancelScrollRestorationRetry: () => void;
  /** Clears the last user scroll-gesture direction before a programmatic move. */
  readonly resetScrollGesture: () => void;
}

interface ChatFindController {
  /** Repaint the mounted highlight after a measured-item layout change. */
  readonly scheduleMountedHighlightSync: () => void;
  /** Find-side follow-up to Virtuoso's onRenderedDataChange. */
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
    scrollToItem,
    requestMeasuredItemChangeRef,
    setBottomFollowingIfChanged,
    setScrolledActiveUserMessageIdIfChanged,
    cancelScrollRestorationRetry,
    resetScrollGesture,
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
      resetScrollGesture();
      cancelScrollRestorationRetry();
      setBottomFollowingIfChanged(false);
      setScrolledActiveUserMessageIdIfChanged(
        selectActiveUserMessageId(messagesRef.current, messageId, false),
      );
      const location = chatScrollLocationForMessage(
        messageId,
        messageIndexByIdRef.current,
        "auto",
      );
      if (location === null) return;
      scrollToItem(location);
    },
    [
      cancelScrollRestorationRetry,
      messageIndexByIdRef,
      messagesRef,
      resetScrollGesture,
      scrollToItem,
      setBottomFollowingIfChanged,
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

  const applyFindOpenedTarget = useCallback(
    (target: ChatFindReconcileTarget, forceApply: boolean): boolean => {
      const chainKeyIds = target.owningChain.map(serializeChatCollapsibleKey);
      const previousTarget = findOpenedTargetRef.current;
      const targetChanged =
        previousTarget === null ||
        previousTarget.messageId !== target.messageId ||
        previousTarget.unitId !== target.unitId ||
        !arrayShallowEq(previousTarget.chainKeyIds, chainKeyIds);
      if (!forceApply && !targetChanged) return false;
      applyFindOpenedChain(target.owningChain);
      findOpenedTargetRef.current = {
        messageId: target.messageId,
        unitId: target.unitId,
        chainKeyIds,
      };
      return true;
    },
    [applyFindOpenedChain],
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
      applyFindOpenedTarget(target, true);
      cancelFindRevealFrame();
      findRevealFrameRef.current = window.requestAnimationFrame(() => {
        findRevealFrameRef.current = null;
        if (findRevealGenerationRef.current !== generation) return;
        // Always remeasure: it is position-maintaining, and a manual collapse
        // followed by next() re-opens the same unit (a real height change).
        requestMeasuredItemChangeRef.current();
        if (!sameUnit) scrollToMessageForFind(target.messageId);
        scheduleFindRevealStep(generation, sameUnit);
      });
    },
    [
      applyFindOpenedTarget,
      cancelFindRevealFrame,
      requestMeasuredItemChangeRef,
      scheduleFindRevealStep,
      scrollToMessageForFind,
    ],
  );

  const requestFindReconcile = useCallback(
    (target: ChatFindReconcileTarget): void => {
      const applied = applyFindOpenedTarget(target, false);
      if (!applied) return;
      requestMeasuredItemChangeRef.current();
    },
    [applyFindOpenedTarget, requestMeasuredItemChangeRef],
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
