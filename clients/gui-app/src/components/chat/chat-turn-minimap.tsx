import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { FoldVertical, UnfoldVertical } from "lucide-react";
import {
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE,
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_MIN_ITEMS,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapIndexFromPointer,
  resolveChatTurnMinimapInteractiveWidth,
  resolveChatTurnMinimapRowViewportDistance,
  resolveChatTurnMinimapTopStyle,
  type ChatTurnMinimapListState,
} from "@/components/chat/chat-turn-minimap-logic";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { cn } from "@/lib/utils";
import {
  restoreChatTurnMinimapActiveEntry,
  saveChatTurnMinimapActiveEntry,
} from "@/stores/chats/chat-turn-minimap-active-entry-store";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import type { ChatTurnMinimapSide } from "@/stores/settings/settings-store";
import { Button } from "@/components/ui/button";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface ChatTurnMinimapProps {
  /** Same row array LegendList renders - rail indices key directly into it. */
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly listRef: RefObject<LegendListRef | null>;
  /** LegendList's live measured header size (decision #18's
   *  `topOffsetAdjustment`) - `positionAtIndex` is content-relative and
   *  excludes it, while `scroll` includes it; in-view highlighting must
   *  correct for the gap the same way the ticket-5 save path does. A ref
   *  (not a number prop) since it updates via LegendList's own metrics
   *  callback, independent of this component's own render cycle. */
  readonly topOffsetAdjustmentRef: RefObject<number>;
  /** Observes the transcript clip-region wrapper so pane resizes refresh
   *  in-view strip highlighting even when no scroll event fires. */
  readonly viewportRef: RefObject<HTMLElement | null>;
  /** Composer/queue dock height overlaying the bottom of the transcript
   *  (decision #3, #13) - the rail's own box shrinks by this amount rather
   *  than measuring a clipping parent, since it is positioned within the
   *  same relative box the dock overlays. */
  readonly bottomInset: number;
  /** Imperative refresh registered here and invoked by the timeline's own
   *  scroll callback AND its row-remeasurement callback (O2, ticket 16: the
   *  minimap no longer attaches a second scroll listener of its own) without
   *  re-rendering the controller. */
  readonly inViewRefreshRef: RefObject<() => void>;
  /** Cancels manual-nav follow ownership, then animate-scrolls to the
   *  target row through the same suppression-arming wrapper find/deep-link
   *  navigation uses (decision #21). */
  readonly onSelect: (messageId: string) => void;
  /** Dual-key identity (ticket 15) the active entry restores/persists
   *  against - tab-key while switching away and back, chat-key across a
   *  full close/reopen. */
  readonly identity: ChatTabPersistenceIdentity;
  /** Persisted transcript-edge preference. Right is the app default. */
  readonly side: ChatTurnMinimapSide;
}

interface ChatTurnMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

function isHumanUserMessage(message: ChatMessageModel): boolean {
  // A2A responses received from other agents are persisted as `role: "user"`
  // but carry `agentSenderInfo`; they are operational agent traffic, not
  // user-authored prompts, so they must not appear in the rail (mirrors
  // `selectActiveUserMessageId`'s filter in chat-messages-scroll-helpers.ts).
  return message.role === "user" && message.agentSenderInfo === null;
}

function compactMinimapPreview(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

/** Last assistant row's text before the next user row of any kind (A2A rows
 *  still end a turn). */
function resolveFinalAssistantTextForTurn(
  messages: ReadonlyArray<ChatMessageModel>,
  userRowIndex: number,
): string | null {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant") {
      finalAssistantText = message.content;
    }
  }
  return finalAssistantText;
}

function deriveChatTurnMinimapItems(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatTurnMinimapItem> {
  const items: ChatTurnMinimapItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isHumanUserMessage(message)) continue;
    items.push({
      id: message.id,
      rowIndex: index,
      userText: compactMinimapPreview(message.content),
      assistantText: compactMinimapPreview(
        resolveFinalAssistantTextForTurn(messages, index),
      ),
    });
  }
  return items;
}

function chatTurnMinimapEventTargetsPreview(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-chat-turn-minimap-preview]") !== null
  );
}

/** The preview anchors to the active strip's own top edge, except at the
 *  rail's very ends where that would push it off-screen. O3 (ticket 16):
 *  this repo's lint forbids `no-nested-ternary`, so this stays an extracted
 *  if-chain rather than the true one-liners (aria-label, wrapper opacity,
 *  active-state resolution) that ARE inlined below. */
function resolveChatTurnMinimapTooltipTranslate(
  resolvedActiveIndex: number | null,
  itemCount: number,
): string {
  if (resolvedActiveIndex === null) return "-50%";
  if (resolvedActiveIndex === 0) return "0%";
  if (resolvedActiveIndex === itemCount - 1) return "-100%";
  return "-50%";
}

/** Strip width scales down with distance from the active strip. Same
 *  no-nested-ternary reasoning as `resolveChatTurnMinimapTooltipTranslate`
 *  above - stays extracted. */
function resolveChatTurnMinimapStripWidthClassName(
  activeDistance: number | null,
): string {
  if (activeDistance === 0) return "w-6 bg-muted-foreground/75";
  if (activeDistance === 1) return "w-4";
  if (activeDistance === 2) return "w-2.5";
  return "w-2";
}

interface ChatTurnMinimapActiveState {
  readonly resolvedActiveIndex: number | null;
  readonly activeItem: ChatTurnMinimapItem | null;
}

/** Kept extracted for the same complexity-ceiling reason as the two
 *  functions above. */
function resolveChatTurnMinimapActiveState(
  items: ReadonlyArray<ChatTurnMinimapItem>,
  activeIndex: number | null,
): ChatTurnMinimapActiveState {
  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  if (resolvedActiveIndex === null) {
    return { resolvedActiveIndex: null, activeItem: null };
  }
  return {
    resolvedActiveIndex,
    activeItem: items[resolvedActiveIndex] ?? null,
  };
}

interface ChatTurnMinimapViewportHighlightResolution {
  readonly closestMessageId: string | null;
  readonly hasInViewItem: boolean;
}

function updateChatTurnMinimapStripDataset(
  strip: HTMLSpanElement,
  key: "inView" | "proximity",
  enabled: boolean,
): void {
  const nextValue = enabled ? "true" : "false";
  if (strip.dataset[key] !== nextValue) {
    strip.dataset[key] = nextValue;
  }
}

function refreshChatTurnMinimapViewportHighlights(
  state: ChatTurnMinimapListState,
  items: ReadonlyArray<ChatTurnMinimapItem>,
  stripMap: ReadonlyMap<string, HTMLSpanElement>,
): ChatTurnMinimapViewportHighlightResolution {
  let hasInViewItem = false;
  let closestMessageId: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const strip = stripMap.get(item.id);
    if (!strip) continue;
    const distance = resolveChatTurnMinimapRowViewportDistance(
      state,
      item.rowIndex,
    );
    const inView = distance !== null && distance < 0;
    updateChatTurnMinimapStripDataset(strip, "inView", inView);
    if (inView) {
      hasInViewItem = true;
      continue;
    }
    if (distance === null || distance >= closestDistance) continue;
    closestDistance = distance;
    closestMessageId = item.id;
  }
  return { closestMessageId, hasInViewItem };
}

function syncChatTurnMinimapProximityHighlight(
  stripMap: ReadonlyMap<string, HTMLSpanElement>,
  previousMessageId: string | null,
  nextMessageId: string | null,
): void {
  if (previousMessageId !== nextMessageId && previousMessageId !== null) {
    const previousStrip = stripMap.get(previousMessageId);
    if (previousStrip) {
      updateChatTurnMinimapStripDataset(previousStrip, "proximity", false);
    }
  }
  if (nextMessageId === null) return;
  const nextStrip = stripMap.get(nextMessageId);
  if (nextStrip) {
    updateChatTurnMinimapStripDataset(nextStrip, "proximity", true);
  }
}

interface ChatTurnMinimapPreviewProps {
  readonly activeItem: ChatTurnMinimapItem;
  readonly activeItemIndex: number;
  readonly activeTooltipTranslate: string;
  readonly expanded: boolean;
  readonly items: ReadonlyArray<ChatTurnMinimapItem>;
  readonly onSelect: (messageId: string) => void;
  readonly onToggleExpanded: () => void;
  readonly side: ChatTurnMinimapSide;
}

function ChatTurnMinimapItemText(props: {
  readonly item: ChatTurnMinimapItem;
  readonly mode: "list" | "preview";
}) {
  const { item, mode } = props;
  return (
    <>
      <span
        className={cn(
          "block max-w-full text-ui-xs font-medium leading-5",
          mode === "list"
            ? "line-clamp-3 whitespace-normal break-words"
            : "overflow-hidden text-ellipsis whitespace-nowrap",
        )}
        data-chat-turn-minimap-user-text=""
      >
        {item.userText ?? "User message"}
      </span>
      {mode === "preview" && item.assistantText !== null ? (
        <span
          className="mt-1 line-clamp-3 text-muted-foreground text-ui-xs leading-5"
          data-chat-turn-minimap-assistant=""
        >
          {item.assistantText}
        </span>
      ) : null}
    </>
  );
}

function ChatTurnMinimapPreview(props: ChatTurnMinimapPreviewProps) {
  const {
    activeItem,
    activeItemIndex,
    activeTooltipTranslate,
    expanded,
    items,
    onSelect,
    onToggleExpanded,
    side,
  } = props;
  return (
    <div
      className={cn(
        "pointer-events-auto absolute w-[min(20rem,calc(100vw-3rem))] select-none text-left text-popover-foreground",
        side === "left" ? "left-8" : "right-8",
      )}
      data-chat-turn-minimap-preview=""
      onMouseMove={(event) => event.stopPropagation()}
      style={{
        top: expanded
          ? "50%"
          : resolveChatTurnMinimapTopStyle(activeItemIndex, items.length),
        transform: `translateY(${expanded ? "-50%" : activeTooltipTranslate})`,
      }}
    >
      {expanded ? (
        <div className="relative flex max-h-[min(60vh,calc(100cqh_-_1rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-popover shadow-lg">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Collapse message list"
                className="absolute top-2 right-2 z-10 text-muted-foreground/60 hover:text-foreground active:bg-muted/80 active:text-foreground"
                onClick={() => {
                  onToggleExpanded();
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <FoldVertical aria-hidden="true" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Collapse message list
            </TooltipContent>
          </Tooltip>
          <div
            className="min-h-0 overflow-y-auto p-2"
            data-chat-turn-minimap-list-scroll=""
          >
            <div className="flex flex-col gap-0.5">
              {items.map((item, index) => (
                <button
                  aria-label={`Jump to message: ${item.userText ?? "User message"}`}
                  aria-current={index === activeItemIndex ? "true" : undefined}
                  className={cn(
                    "w-full cursor-pointer rounded-lg px-3 py-2.5 text-left transition-[background-color,color,box-shadow] duration-100 first:pr-11 hover:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                    index === activeItemIndex
                      ? "bg-foreground/[0.13] text-foreground ring-1 ring-inset ring-foreground/[0.08] hover:bg-foreground/[0.16]"
                      : "bg-transparent text-popover-foreground",
                  )}
                  data-active={index === activeItemIndex ? "true" : "false"}
                  data-chat-turn-minimap-list-item=""
                  data-message-id={item.id}
                  key={item.id}
                  onClick={() => {
                    onSelect(item.id);
                  }}
                  type="button"
                >
                  <ChatTurnMinimapItemText item={item} mode="list" />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-xl border border-border/60 bg-popover shadow-lg">
          <button
            aria-label={`Jump to message: ${activeItem.userText ?? "User message"}`}
            className="block w-full cursor-pointer select-none p-3 pr-11 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            data-chat-turn-minimap-card=""
            onClick={() => {
              onSelect(activeItem.id);
            }}
            type="button"
          >
            <ChatTurnMinimapItemText item={activeItem} mode="preview" />
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Expand all messages"
                className="absolute top-2 right-2 text-muted-foreground/60 hover:text-foreground active:bg-muted/80 active:text-foreground"
                onClick={() => {
                  onToggleExpanded();
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <UnfoldVertical aria-hidden="true" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Expand all messages
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/**
 * Configurable transcript-edge turn minimap (decision #20).
 * One evenly spaced strip per HUMAN user turn; hover/focus opens a 20rem
 * viewport-capped preview (user text + the turn's last assistant text); a
 * single hit-target control maps pointer Y / arrow keys to the nearest turn.
 * Fine-pointer only; the compact edge target stays visible and interactive
 * at every pane width, including tiled epic-canvas layouts.
 */
export function ChatTurnMinimap(props: ChatTurnMinimapProps) {
  const {
    bottomInset,
    identity,
    inViewRefreshRef,
    listRef,
    messages,
    onSelect,
    side,
    topOffsetAdjustmentRef,
    viewportRef,
  } = props;
  const items = useMemo(() => deriveChatTurnMinimapItems(messages), [messages]);
  const [stripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [activeIndex, setActiveIndex] = useState<number | null>(() => {
    const savedActiveMessageId = restoreChatTurnMinimapActiveEntry(identity);
    if (savedActiveMessageId === null) return null;
    const index = items.findIndex((item) => item.id === savedActiveMessageId);
    return index === -1 ? null : index;
  });
  const [expanded, setExpanded] = useState(false);
  const [interactionStarted, setInteractionStarted] = useState(false);
  const interactionRegionRef = useRef<HTMLDivElement | null>(null);
  const hitStripRef = useRef<HTMLButtonElement | null>(null);
  const proximityMessageIdRef = useRef<string | null>(null);

  // In-view highlighting is refreshed on mount and whenever the pane's own
  // box changes (zoom or split resize). A
  // height-only resize changes LegendList's scrollLength without necessarily
  // producing either a scroll event or a row remeasurement.
  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (viewportElement === null) return;

    const measure = (): void => {
      inViewRefreshRef.current();
    };

    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(viewportElement);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [inViewRefreshRef, viewportRef]);

  // In-view strip highlighting from LegendList's own measured positions - no
  // DOM rect probing (jsdom/perf lesson; the old reading-line probe died on
  // exactly this). One O(items) geometry pass with no per-item allocation
  // handles both visibility and proximity. Dataset writes are diffed and
  // bypass React state, so a scroll tick never re-renders the rail or repeats
  // style work for unchanged markers. O2
  // (ticket 16 listener consolidation): this used to run off a second scroll listener
  // this component attached to the scrollable node itself (rAF-polling
  // attach + native listener + detach, duplicating a lifecycle ChatTimeline
  // already runs) - it now runs only via `inViewRefreshRef`, invoked from
  // ChatTimeline's own `onScroll` (chat-messages.tsx's `handleScroll`) and
  // from `onItemSizeChanged` (non-scroll remeasurement, e.g. a disclosure
  // toggling with no scroll of its own).
  const updateInView = useCallback((): void => {
    const rawState = listRef.current?.getState();
    if (rawState === undefined) return;
    // LegendList's own getState() does not expose headerSize/topOffsetAdjustment
    // (chat-messages.tsx's onListMetricsChange is the only source for it) -
    // fold in the live measured value so the band matches LegendList's own
    // content-relative comparison (decision #18).
    const state = {
      ...rawState,
      // The composer and queued-message dock overlay the list viewport. Keep
      // rows hidden behind that first-class end inset out of the visible band,
      // matching the shortened minimap rail and the transcript's usable
      // viewport contract.
      scrollLength: Math.max(
        0,
        rawState.scrollLength - Math.max(0, bottomInset),
      ),
      topOffsetAdjustment: topOffsetAdjustmentRef.current,
    };
    const resolution = refreshChatTurnMinimapViewportHighlights(
      state,
      items,
      stripMap,
    );
    const fallbackMessageId = items.length === 0 ? null : items[0].id;
    const nextProximityMessageId = resolution.hasInViewItem
      ? null
      : (resolution.closestMessageId ??
        proximityMessageIdRef.current ??
        fallbackMessageId);
    const previousProximityMessageId = proximityMessageIdRef.current;
    syncChatTurnMinimapProximityHighlight(
      stripMap,
      previousProximityMessageId,
      nextProximityMessageId,
    );
    if (previousProximityMessageId !== nextProximityMessageId) {
      proximityMessageIdRef.current = nextProximityMessageId;
    }
  }, [bottomInset, items, listRef, stripMap, topOffsetAdjustmentRef]);

  useEffect(() => {
    inViewRefreshRef.current = updateInView;
    return () => {
      if (inViewRefreshRef.current === updateInView) {
        inViewRefreshRef.current = () => undefined;
      }
    };
  }, [inViewRefreshRef, updateInView]);

  useEffect(() => {
    const frame = requestAnimationFrame(updateInView);
    return () => cancelAnimationFrame(frame);
  }, [updateInView]);

  // O3 (ticket 16): `ChatTurnMinimap` sits at this repo's complexity-16 lint
  // ceiling. Inlining this 3-branch resolution pushed it over, so it stays
  // extracted; the true one-liners (aria-label, wrapper opacity) below ARE
  // inlined.
  const { resolvedActiveIndex, activeItem } = resolveChatTurnMinimapActiveState(
    items,
    activeIndex,
  );
  const activeTooltipTranslate = resolveChatTurnMinimapTooltipTranslate(
    resolvedActiveIndex,
    items.length,
  );

  // Ticket 15 (decision #29): mirror the active entry into the tab-key
  // registry on every genuine change - keyed off the resolved item's id
  // (not `activeItem` itself, a fresh object each render) so this does not
  // re-fire every render. Survives a switch-away-then-back remount (same
  // tileInstanceId).
  //
  // Ticket 15 review round 3 (mandated simplification): the durable
  // chat-key half no longer commits from this component at all - the
  // canvas close sweep's promotion choke point (store.ts) reads the
  // tab-key registry directly before eviction, covering both an active
  // AND an inactive (never-mounted) view's close.
  const activeItemId = activeItem?.id ?? null;
  useEffect(() => {
    saveChatTurnMinimapActiveEntry(identity, activeItemId);
  }, [identity, activeItemId]);

  const resolveActiveIndexFromPointer = useCallback(
    (event: ReactMouseEvent<HTMLElement>): number | null => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveChatTurnMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      setInteractionStarted(true);
      setActiveIndex(resolveActiveIndexFromPointer(event));
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number): void => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  const handleHitStripClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      if (chatTurnMinimapEventTargetsPreview(event.target)) return;
      setInteractionStarted(true);
      const nextIndex = resolveActiveIndexFromPointer(event);
      const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
      if (nextItem) {
        onSelect(nextItem.id);
      }
      event.currentTarget.blur();
    },
    [items, onSelect, resolveActiveIndexFromPointer],
  );

  const handleHitStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (chatTurnMinimapEventTargetsPreview(event.target)) return;
      setInteractionStarted(true);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveActiveIndex(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveActiveIndex(-1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(items.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (activeItem) {
          onSelect(activeItem.id);
        }
      }
    },
    [activeItem, items.length, moveActiveIndex, onSelect],
  );

  const handleHitStripMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      if (chatTurnMinimapEventTargetsPreview(event.target)) return;
      event.preventDefault();
    },
    [],
  );

  const closeInteraction = useCallback((): void => {
    setExpanded(false);
    setInteractionStarted(false);
    setActiveIndex(null);
  }, []);

  const handleInteractionBlur = useCallback(
    (event: FocusEvent): void => {
      if (
        event.relatedTarget instanceof Node &&
        interactionRegionRef.current?.contains(event.relatedTarget) === true
      ) {
        return;
      }
      closeInteraction();
    },
    [closeInteraction],
  );

  const handleInteractionKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (expanded) {
        setExpanded(false);
        hitStripRef.current?.focus();
        return;
      }
      closeInteraction();
      hitStripRef.current?.blur();
    },
    [closeInteraction, expanded],
  );

  useEffect(() => {
    const interactionRegion = interactionRegionRef.current;
    if (interactionRegion === null) return;
    interactionRegion.addEventListener("focusout", handleInteractionBlur);
    interactionRegion.addEventListener("keydown", handleInteractionKeyDown);
    interactionRegion.addEventListener("mouseleave", closeInteraction);
    return () => {
      interactionRegion.removeEventListener("focusout", handleInteractionBlur);
      interactionRegion.removeEventListener(
        "keydown",
        handleInteractionKeyDown,
      );
      interactionRegion.removeEventListener("mouseleave", closeInteraction);
    };
  }, [closeInteraction, handleInteractionBlur, handleInteractionKeyDown]);

  const handlePreviewSelect = useCallback(
    (messageId: string): void => {
      const index = items.findIndex((item) => item.id === messageId);
      if (index !== -1) setActiveIndex(index);
      onSelect(messageId);
    },
    [items, onSelect],
  );

  const toggleExpanded = useCallback((): void => {
    setInteractionStarted(true);
    setExpanded((current) => !current);
  }, []);

  if (items.length < CHAT_TURN_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));
  const previewVisible = interactionStarted && activeItem !== null;
  const interactiveWidth = resolveChatTurnMinimapInteractiveWidth(
    CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
    previewVisible || expanded,
  );

  return (
    <div
      className={cn(
        "group/chat-turn-minimap pointer-events-none absolute top-0 z-40 hidden w-18 opacity-100 [container-type:size] [@media(pointer:fine)]:block",
        side === "left" ? "left-0" : "right-0",
      )}
      data-side={side}
      data-testid="chat-turn-minimap"
      style={{ bottom: safeBottomInset }}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "pointer-events-auto absolute top-1/2 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            side === "left" ? "left-3" : "right-3",
          )}
          aria-label="Message minimap controls"
          data-chat-turn-minimap-interaction-region=""
          {...paneActivationDeferProps}
          ref={interactionRegionRef}
          role="group"
          style={{ height: resolveChatTurnMinimapHeightStyle(items.length) }}
        >
          <button
            aria-label="Message minimap"
            className="pointer-events-auto relative block h-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            data-chat-turn-minimap-interactive-width={interactiveWidth}
            data-testid="chat-turn-minimap-hit-strip"
            {...{ [CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE]: "" }}
            onClick={handleHitStripClick}
            onFocus={() => {
              setInteractionStarted(true);
              setActiveIndex((current) => current ?? 0);
            }}
            onKeyDown={handleHitStripKeyDown}
            onMouseDown={handleHitStripMouseDown}
            onMouseMove={(event) => {
              if (!expanded) updateActiveIndexFromPointer(event);
            }}
            ref={hitStripRef}
            style={{
              width: interactiveWidth,
            }}
            type="button"
          >
            {items.map((item, index) => {
              const top = resolveChatTurnMinimapTopStyle(index, items.length);
              const activeDistance =
                resolvedActiveIndex === null
                  ? null
                  : Math.abs(index - resolvedActiveIndex);
              return (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90 data-[proximity=true]:bg-foreground/90",
                    side === "left" ? "left-0" : "right-0",
                    resolveChatTurnMinimapStripWidthClassName(activeDistance),
                  )}
                  data-chat-turn-minimap-strip=""
                  data-in-view="false"
                  data-message-id={item.id}
                  data-proximity="false"
                  key={item.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(item.id, node);
                    } else {
                      stripMap.delete(item.id);
                    }
                  }}
                  style={{ top }}
                />
              );
            })}
          </button>
          {!previewVisible ? null : (
            <ChatTurnMinimapPreview
              activeItem={activeItem}
              activeItemIndex={resolvedActiveIndex ?? 0}
              activeTooltipTranslate={activeTooltipTranslate}
              expanded={expanded}
              items={items}
              onSelect={handlePreviewSelect}
              onToggleExpanded={toggleExpanded}
              side={side}
            />
          )}
        </div>
      </div>
    </div>
  );
}
