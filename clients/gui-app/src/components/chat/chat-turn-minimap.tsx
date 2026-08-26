import type { LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE,
  compactChatTurnMinimapPreview,
  resolveChatTurnMinimapCurrentIndex,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapHitStripWidth,
  resolveChatTurnMinimapTopStyle,
  shouldRunChatTurnMinimapRail,
} from "@/components/chat/chat-turn-minimap-logic";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import { useRegisterTileMinimap } from "@/components/epic-canvas/tile-minimap/tile-minimap-context";
import {
  MinimapListCard,
  type MinimapListEntry,
} from "@/components/minimap/minimap-list-card";
import { resolveMinimapRailMaskClassName } from "@/components/minimap/minimap-rail-mask";
import { MinimapRailTick } from "@/components/minimap/minimap-rail-tick";
import {
  resolveMinimapVisibleItemCapacity,
  resolveMinimapWindow,
} from "@/components/minimap/minimap-track-geometry";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { cn } from "@/lib/utils";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  useSettingsStore,
  type MinimapPlacement,
} from "@/stores/settings/settings-store";

export interface ChatTurnMinimapProps {
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly topOffsetAdjustmentRef: RefObject<number>;
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly bottomInset: number;
  readonly inViewRefreshRef: RefObject<() => void>;
  readonly onSelect: (messageId: string) => void;
  /** `hide` keeps the turn model published for the tile bar, rail and all. */
  readonly side: MinimapPlacement;
}

interface ChatTurnMinimapItem extends MinimapListEntry {
  readonly endRowIndex: number;
  readonly messageId: string;
  readonly rowIndex: number;
}

function isHumanUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user" && message.agentSenderInfo === null;
}

function deriveChatTurnMinimapItems(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatTurnMinimapItem> {
  const humanRows: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isHumanUserMessage(messages[index])) humanRows.push(index);
  }

  return humanRows.map((rowIndex, index) => {
    const message = messages[rowIndex];
    return {
      key: message.id,
      label:
        compactChatTurnMinimapPreview(message.content) ?? "Untitled message",
      level: 1,
      messageId: message.id,
      rowIndex,
      endRowIndex: (humanRows[index + 1] ?? messages.length) - 1,
    };
  });
}

function clampIndex(index: number, itemCount: number): number {
  return Math.max(0, Math.min(index, itemCount - 1));
}

/** One compact window of turns. Hover or focus opens the full turn list. */
export function ChatTurnMinimap(props: ChatTurnMinimapProps) {
  const {
    bottomInset,
    inViewRefreshRef,
    listRef,
    messages,
    onSelect,
    side,
    topOffsetAdjustmentRef,
    viewportRef,
  } = props;
  // A streaming reply replaces `messages` per token, so this array is new per
  // token even when the turns are not. What is keyed on its identity must
  // survive that: the tile bar's notify compares the outline it publishes
  // (`useRegisterTileMinimap`), and the rail's geometry effect below reads
  // `refreshCurrent` through a ref instead of depending on it.
  const items = useMemo(() => deriveChatTurnMinimapItems(messages), [messages]);
  const uiFontSize = useSettingsStore((state) => state.uiFontSize);
  const coarsePointer = useCoarsePointer();
  const mobileViewport = useIsMobileViewport();
  const railActive = shouldRunChatTurnMinimapRail({
    coarsePointer,
    mobileViewport,
    side,
  });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [hitStripWidth, setHitStripWidth] = useState<number | null>(null);
  const [maxVisibleItems, setMaxVisibleItems] = useState(2);
  const [open, setOpen] = useState(false);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const hitStripRef = useRef<HTMLButtonElement | null>(null);

  const refreshCurrent = useCallback((): void => {
    const rawState = listRef.current?.getState();
    if (rawState === undefined) return;
    const next = resolveChatTurnMinimapCurrentIndex(
      {
        ...rawState,
        scrollLength: Math.max(
          0,
          rawState.scrollLength - Math.max(0, bottomInset),
        ),
        topOffsetAdjustment: topOffsetAdjustmentRef.current,
      },
      items,
    );
    if (next !== null)
      setCurrentIndex((current) => (current === next ? current : next));
  }, [bottomInset, items, listRef, topOffsetAdjustmentRef]);

  useEffect(() => {
    inViewRefreshRef.current = refreshCurrent;
    return () => {
      if (inViewRefreshRef.current === refreshCurrent) {
        inViewRefreshRef.current = () => undefined;
      }
    };
  }, [inViewRefreshRef, refreshCurrent]);

  useEffect(() => {
    const frame = requestAnimationFrame(refreshCurrent);
    return () => cancelAnimationFrame(frame);
  }, [refreshCurrent]);

  // Read through a ref so the observer below is not torn down and rebuilt
  // whenever the callback's identity moves.
  const refreshCurrentRef = useRef(refreshCurrent);
  useLayoutEffect(() => {
    refreshCurrentRef.current = refreshCurrent;
  }, [refreshCurrent]);

  // Only the rail consumes this geometry, so it runs only where the rail
  // paints: `getBoundingClientRect` on the transcript container forces a
  // layout of the virtualized rows inside it, and on a phone that buys
  // nothing.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!railActive || viewport === null) return;
    const measure = (): void => {
      const viewportRect = viewport.getBoundingClientRect();
      const width = resolveChatTurnMinimapHitStripWidth({
        rootFontSize: uiFontSize,
        viewportWidth: viewportRect.width,
      });
      setHitStripWidth(width);
      setMaxVisibleItems(
        resolveMinimapVisibleItemCapacity(
          Math.max(0, viewportRect.height - bottomInset),
        ),
      );
      if (width === 0) {
        setOpen(false);
        hitStripRef.current?.blur();
      }
      refreshCurrentRef.current();
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [bottomInset, railActive, uiFontSize, viewportRef]);

  const visible = items.length > 0;
  // Subsumed by `railActive`; kept as its own condition so the early return
  // below narrows the placement the rail renders with.
  const railHidden = side === "hide";
  const isInert = hitStripWidth === null || hitStripWidth <= 0;
  const resolvedCurrentIndex = clampIndex(currentIndex, items.length);
  const resolvedCursorIndex = clampIndex(cursorIndex, items.length);

  const selectByIndex = useCallback(
    (index: number): void => {
      if (index < 0 || index >= items.length) return;
      onSelect(items[index].messageId);
    },
    [items, onSelect],
  );

  // Published even when the rail is hidden or inert: the phone tile bar's
  // button is an explicit affordance and is the only way in on a touch device.
  useRegisterTileMinimap({
    title: "Messages",
    items,
    currentIndex: resolvedCurrentIndex,
    onSelect: selectByIndex,
  });

  useEffect(() => {
    const region = regionRef.current;
    if (region === null || !visible) return;
    const handleMouseEnter = (): void => {
      if (isInert) return;
      setCursorIndex(resolvedCurrentIndex);
      setOpen(true);
    };
    const handleMouseLeave = (): void => setOpen(false);
    const handleFocusOut = (event: FocusEvent): void => {
      if (
        event.relatedTarget instanceof Node &&
        region.contains(event.relatedTarget)
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      hitStripRef.current?.focus();
      setOpen(false);
    };
    region.addEventListener("mouseenter", handleMouseEnter);
    region.addEventListener("mouseleave", handleMouseLeave);
    region.addEventListener("focusout", handleFocusOut);
    region.addEventListener("keydown", handleKeyDown);
    return () => {
      region.removeEventListener("mouseenter", handleMouseEnter);
      region.removeEventListener("mouseleave", handleMouseLeave);
      region.removeEventListener("focusout", handleFocusOut);
      region.removeEventListener("keydown", handleKeyDown);
    };
  }, [isInert, resolvedCurrentIndex, visible]);

  const openAtCurrent = useCallback((): void => {
    if (isInert) return;
    setCursorIndex(resolvedCurrentIndex);
    setOpen(true);
  }, [isInert, resolvedCurrentIndex]);

  const moveCursor = useCallback(
    (index: number): void => {
      setCursorIndex(clampIndex(index, items.length));
      setOpen(true);
    },
    [items.length],
  );

  const handleHitStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveCursor((open ? resolvedCursorIndex : resolvedCurrentIndex) + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveCursor((open ? resolvedCursorIndex : resolvedCurrentIndex) - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        moveCursor(0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveCursor(items.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const index = open ? resolvedCursorIndex : resolvedCurrentIndex;
        onSelect(items[index].messageId);
        setOpen(true);
      }
    },
    [
      items,
      moveCursor,
      onSelect,
      open,
      resolvedCurrentIndex,
      resolvedCursorIndex,
    ],
  );

  if (railHidden || !railActive || !visible || isInert) return null;

  const window = resolveMinimapWindow({
    currentIndex: resolvedCurrentIndex,
    itemCount: items.length,
    maxItems: maxVisibleItems,
  });
  const railItems = items.slice(window.startIndex, window.endIndex);
  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));
  const continuationMaskClassName = resolveMinimapRailMaskClassName(
    window.hasBefore,
    window.hasAfter,
  );

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-40 hidden [container-type:size] [@media(pointer:fine)]:block"
      data-side={side}
      data-testid="chat-turn-minimap"
      style={{ bottom: safeBottomInset }}
    >
      <div
        aria-label="Message minimap controls"
        className={cn(
          "pointer-events-auto absolute top-1/2 -translate-y-1/2 select-none",
          side === "left" ? "left-3" : "right-3",
        )}
        {...paneActivationDeferProps}
        ref={regionRef}
        role="group"
        style={{ height: resolveChatTurnMinimapHeightStyle(railItems.length) }}
      >
        <button
          aria-label="Message minimap"
          aria-expanded={open}
          className={cn(
            "relative block h-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            continuationMaskClassName,
          )}
          data-testid="chat-turn-minimap-hit-strip"
          {...{ [CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE]: "" }}
          onClick={() => setOpen(true)}
          onFocus={openAtCurrent}
          onKeyDown={handleHitStripKeyDown}
          ref={hitStripRef}
          style={{ width: hitStripWidth }}
          type="button"
        >
          {railItems.map((item, localIndex) => {
            const index = window.startIndex + localIndex;
            const active = index === resolvedCurrentIndex;
            return (
              <MinimapRailTick
                active={active}
                availableWidth={hitStripWidth}
                data-message-id={item.messageId}
                data-testid="chat-turn-minimap-tick"
                hierarchical={false}
                key={item.key}
                level={item.level}
                open={open}
                side={side}
                top={resolveChatTurnMinimapTopStyle(
                  localIndex,
                  railItems.length,
                )}
              />
            );
          })}
        </button>
        {open ? (
          <div
            className={cn(
              "absolute top-1/2 w-[min(20rem,calc(100cqw-1.5rem))] -translate-y-1/2",
              side === "left" ? "left-0" : "right-0",
            )}
            data-testid="chat-turn-minimap-card"
          >
            <MinimapListCard
              currentIndex={resolvedCurrentIndex}
              cursorIndex={resolvedCursorIndex}
              items={items}
              onCursorIndexChange={setCursorIndex}
              onSelect={(index) => onSelect(items[index].messageId)}
              side={side}
              title="Messages"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
