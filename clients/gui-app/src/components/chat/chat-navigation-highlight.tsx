/* oxlint-disable react/only-export-components -- store, hooks, and the anchor share one module */
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  queryMountedChatBlock,
  queryMountedChatMessageRoot,
} from "@/components/chat/chat-find-highlighter";
import { cn } from "@/lib/utils";

export { queryMountedChatBlock };

/**
 * Temporary flash painted on an external-navigation landing: a whole transcript
 * row when the jump names a message, or a single card when it names a block.
 * Find uses a different highlighter; the minimap does not flash.
 */
export const CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME =
  "bg-primary/15 ring-2 ring-inset ring-primary/80 motion-safe:animate-pulse";

export const CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS = 3_000;

export interface ChatNavigationHighlightTarget {
  readonly messageId: string;
  readonly blockId: string | null;
}

export interface NavigationHighlightStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ChatNavigationHighlightTarget | null;
  readonly setHighlightedTarget: (
    next: ChatNavigationHighlightTarget | null,
  ) => void;
}

function highlightTargetsEqual(
  left: ChatNavigationHighlightTarget | null,
  right: ChatNavigationHighlightTarget | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.messageId === right.messageId && left.blockId === right.blockId;
}

export function createNavigationHighlightStore(
  initialTarget: ChatNavigationHighlightTarget | null,
): NavigationHighlightStore {
  let highlightedTarget = initialTarget;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return highlightedTarget;
    },
    setHighlightedTarget(next) {
      if (highlightTargetsEqual(next, highlightedTarget)) return;
      highlightedTarget = next;
      for (const listener of listeners) listener();
    },
  };
}

const EMPTY_NAVIGATION_HIGHLIGHT_STORE = createNavigationHighlightStore(null);

export const NavigationHighlightStoreContext =
  createContext<NavigationHighlightStore>(EMPTY_NAVIGATION_HIGHLIGHT_STORE);

export type ChatRowNavigationHighlight = "none" | "row" | "block";

export function useRowNavigationHighlight(
  store: NavigationHighlightStore,
  messageId: string,
): ChatRowNavigationHighlight {
  return useSyncExternalStore(store.subscribe, () => {
    const snapshot = store.getSnapshot();
    if (snapshot === null || snapshot.messageId !== messageId) return "none";
    return snapshot.blockId === null ? "row" : "block";
  });
}

function useIsNavigationHighlightedBlock(blockId: string): boolean {
  const store = use(NavigationHighlightStoreContext);
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot()?.blockId === blockId,
  );
}

export type ChatBlockScrollAttempt = "scrolled" | "row-absent" | "block-absent";

export function scrollChatBlockIntoView(
  scroller: HTMLElement,
  messageId: string,
  blockId: string,
): ChatBlockScrollAttempt {
  const messageRoot = queryMountedChatMessageRoot(scroller, messageId);
  if (messageRoot === null) return "row-absent";
  const blockRoot = queryMountedChatBlock(messageRoot, blockId);
  if (blockRoot === null) return "block-absent";
  blockRoot.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "auto",
  });
  return "scrolled";
}

/**
 * After a row-level `scrollToIndex` has settled, the named card may still be
 * off-screen inside a tall assistant turn, or not mounted until an activity
 * group opens. If the scroller or row is absent, stop and wait for
 * `onRowMount` (Find's rule). While the row is mounted, retry until the flash
 * deadline — a late `setOpen` must still be able to center the card.
 */
export function useChatNavigationBlockReveal(args: {
  readonly getScroller: () => HTMLElement | null;
}): {
  readonly requestReveal: (messageId: string, blockId: string) => void;
  readonly clearReveal: () => void;
  readonly onRowMount: (messageId: string) => void;
} {
  const { getScroller } = args;
  const pendingRef = useRef<{
    readonly messageId: string;
    readonly blockId: string;
    readonly generation: number;
    readonly expiresAt: number;
  } | null>(null);
  const frameRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const getScrollerRef = useRef(getScroller);

  useLayoutEffect(() => {
    getScrollerRef.current = getScroller;
  }, [getScroller]);

  const cancelFrame = useCallback((): void => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const attemptRef = useRef<(generation: number) => void>(() => undefined);

  const attempt = useCallback((generation: number): void => {
    const pending = pendingRef.current;
    if (pending === null || pending.generation !== generation) return;
    if (Date.now() >= pending.expiresAt) {
      pendingRef.current = null;
      return;
    }
    const scroller = getScrollerRef.current();
    if (scroller === null) {
      // Keep `pending` so `onRowMount` can revive; do not spin.
      return;
    }
    const result = scrollChatBlockIntoView(
      scroller,
      pending.messageId,
      pending.blockId,
    );
    if (result === "scrolled") {
      if (pendingRef.current?.generation === generation) {
        pendingRef.current = null;
      }
      return;
    }
    // Row not mounted: leave pending for `onRowMount`. Do not reschedule —
    // Find returns the same way.
    if (result === "row-absent") {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      attemptRef.current(generation);
    });
  }, []);

  useLayoutEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);

  const requestReveal = useCallback(
    (messageId: string, blockId: string): void => {
      cancelFrame();
      generationRef.current += 1;
      const generation = generationRef.current;
      pendingRef.current = {
        messageId,
        blockId,
        generation,
        expiresAt: Date.now() + CHAT_NAVIGATION_HIGHLIGHT_DURATION_MS,
      };
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        attempt(generation);
      });
    },
    [attempt, cancelFrame],
  );

  const clearReveal = useCallback((): void => {
    cancelFrame();
    pendingRef.current = null;
  }, [cancelFrame]);

  const onRowMount = useCallback(
    (messageId: string): void => {
      const pending = pendingRef.current;
      if (pending === null || pending.messageId !== messageId) return;
      cancelFrame();
      const generation = pending.generation;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        attempt(generation);
      });
    },
    [attempt, cancelFrame],
  );

  useLayoutEffect(
    () => () => {
      cancelFrame();
    },
    [cancelFrame],
  );

  return useMemo(
    () => ({ requestReveal, clearReveal, onRowMount }),
    [clearReveal, onRowMount, requestReveal],
  );
}

/**
 * Marks a transcript card as a navigation-flash target. Subscribes to the
 * timeline highlight store so only the matching block re-renders. Isolated
 * renders (no provider) never flash.
 */
export function ChatBlockNavigationAnchor(props: {
  readonly blockId: string;
  readonly children: ReactNode;
}): ReactElement {
  const highlighted = useIsNavigationHighlightedBlock(props.blockId);
  return (
    <div
      data-block-id={props.blockId}
      data-navigation-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "rounded-md transition-[background-color,box-shadow] duration-300",
        highlighted && CHAT_NAVIGATION_HIGHLIGHT_CLASSNAME,
      )}
    >
      {props.children}
    </div>
  );
}

/** Owns the store's lifetime and publishes the latest target before paint. */
export function useNavigationHighlightStore(
  messageId: string | null | undefined,
  blockId: string | null | undefined,
): NavigationHighlightStore {
  const [store] = useState<NavigationHighlightStore>(() =>
    createNavigationHighlightStore(
      messageId === undefined || messageId === null
        ? null
        : { messageId, blockId: blockId ?? null },
    ),
  );

  useLayoutEffect(() => {
    store.setHighlightedTarget(
      messageId === undefined || messageId === null
        ? null
        : { messageId, blockId: blockId ?? null },
    );
  }, [blockId, messageId, store]);

  return store;
}

export function resolvedScrollBlockId(blockId: string | null): string | null {
  if (blockId === null || blockId.length === 0) return null;
  return blockId;
}
