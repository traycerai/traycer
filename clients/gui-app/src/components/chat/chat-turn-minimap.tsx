import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import {
  CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE,
  CHAT_TURN_MINIMAP_MIN_ITEMS,
  resolveChatTurnMinimapHasPersistentGutter,
  resolveChatTurnMinimapHeightStyle,
  resolveChatTurnMinimapHitStripWidth,
  resolveChatTurnMinimapIndexFromPointer,
  resolveChatTurnMinimapInteractiveWidth,
  resolveChatTurnMinimapRowInView,
  resolveChatTurnMinimapTopPercent,
} from "@/components/chat/chat-turn-minimap-logic";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import { cn } from "@/lib/utils";
import {
  restoreChatTurnMinimapActiveEntry,
  saveChatTurnMinimapActiveEntry,
} from "@/stores/chats/chat-turn-minimap-active-entry-store";
import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";

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
  /** Measures the pane's full width, to size the gutter/hit-strip against
   *  the centered content column (the transcript's clip-region wrapper). */
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
 *  rail's very ends where that would push it off-screen. O3 (T3 parity,
 *  ticket 16): T3 itself inlines this as a nested ternary - this repo's
 *  lint forbids `no-nested-ternary`, so this one stays an extracted
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
  readonly activeTopPercent: number;
}

/** Kept extracted (not inlined like T3) for the same complexity-ceiling
 *  reason as the two functions above. */
function resolveChatTurnMinimapActiveState(
  items: ReadonlyArray<ChatTurnMinimapItem>,
  activeIndex: number | null,
): ChatTurnMinimapActiveState {
  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  if (resolvedActiveIndex === null) {
    return { resolvedActiveIndex: null, activeItem: null, activeTopPercent: 0 };
  }
  return {
    resolvedActiveIndex,
    activeItem: items[resolvedActiveIndex] ?? null,
    activeTopPercent: resolveChatTurnMinimapTopPercent(
      resolvedActiveIndex,
      items.length,
    ),
  };
}

/**
 * Left-rail turn minimap (decision #20).
 * One evenly spaced strip per HUMAN user turn; hover/focus opens a 22rem
 * viewport-capped preview (user text + the turn's last assistant text); a
 * single hit-target button maps pointer Y / arrow keys to the nearest turn.
 * Fine-pointer only; the collapsed strip is capped to the actual side
 * gutter and goes fully inert (not just visually collapsed) at 0px so it
 * never intercepts clicks over the centered content column.
 */
export function ChatTurnMinimap(props: ChatTurnMinimapProps) {
  const {
    bottomInset,
    identity,
    inViewRefreshRef,
    listRef,
    messages,
    onSelect,
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
  const [hasPersistentGutter, setHasPersistentGutter] = useState(false);
  const [hitStripWidth, setHitStripWidth] = useState(0);

  // Gutter/hit-strip geometry and in-view highlighting: recomputed on mount
  // and whenever the pane's own box changes (zoom or split resize). A
  // height-only resize changes LegendList's scrollLength without necessarily
  // producing either a scroll event or a row remeasurement.
  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (viewportElement === null) return;

    const measure = (): void => {
      const viewportWidth = viewportElement.getBoundingClientRect().width;
      setHasPersistentGutter((current) => {
        const next = resolveChatTurnMinimapHasPersistentGutter(viewportWidth);
        return current === next ? current : next;
      });
      setHitStripWidth(resolveChatTurnMinimapHitStripWidth(viewportWidth));
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
  // exactly this). Written directly to each strip's dataset, bypassing React
  // state, so a scroll tick never triggers a re-render of the whole rail. O2
  // (T3 parity, ticket 16): this used to run off a second scroll listener
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
    for (const item of items) {
      const strip = stripMap.get(item.id);
      if (!strip) continue;
      strip.dataset.inView = resolveChatTurnMinimapRowInView(
        state,
        item.rowIndex,
      )
        ? "true"
        : "false";
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

  // O3 (T3 parity, ticket 16): `ChatTurnMinimap` sits at this repo's
  // complexity-16 lint ceiling (T3 has no such limit) - inlining this
  // 3-branch resolution here (as T3 does) pushed it over, so it stays
  // extracted; the true one-liners (aria-label, wrapper opacity) below ARE
  // inlined.
  const { resolvedActiveIndex, activeItem, activeTopPercent } =
    resolveChatTurnMinimapActiveState(items, activeIndex);
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

  const isInert = hitStripWidth <= 0;

  const handleHitStripClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      // Real browsers already refuse focus/pointer/keyboard dispatch into an
      // `inert` subtree; this guard makes that non-negotiable rather than
      // relying solely on the attribute (M3b - the old minimap's hard-won
      // zero-budget fix went the same belt-and-suspenders route).
      if (isInert) return;
      if (chatTurnMinimapEventTargetsPreview(event.target)) return;
      const nextIndex = resolveActiveIndexFromPointer(event);
      const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
      if (nextItem) {
        onSelect(nextItem.id);
      }
      event.currentTarget.blur();
    },
    [isInert, items, onSelect, resolveActiveIndexFromPointer],
  );

  const handleHitStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (isInert) return;
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
    [activeItem, isInert, items.length, moveActiveIndex, onSelect],
  );

  const handleHitStripMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>): void => {
      if (chatTurnMinimapEventTargetsPreview(event.target)) return;
      event.preventDefault();
    },
    [],
  );

  if (items.length < CHAT_TURN_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));

  return (
    <div
      className={cn(
        "group/chat-turn-minimap pointer-events-none absolute top-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="chat-turn-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      style={{ bottom: safeBottomInset }}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-hidden={isInert ? "true" : undefined}
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            // The strip is width-capped to the side gutter so it never
            // overlays the centered content column; with no usable gutter
            // it goes fully inert, not just visually collapsed (M3b - the
            // old minimap's hard-won zero-budget fix).
            isInert ? "pointer-events-none" : "pointer-events-auto",
          )}
          data-testid="chat-turn-minimap-hit-strip"
          {...{ [CHAT_TURN_MINIMAP_KEYBOARD_OWNER_ATTRIBUTE]: "" }}
          inert={isInert}
          onBlur={() => setActiveIndex(null)}
          onClick={handleHitStripClick}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={handleHitStripKeyDown}
          onMouseDown={handleHitStripMouseDown}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          style={{
            height: resolveChatTurnMinimapHeightStyle(items.length),
            width: resolveChatTurnMinimapInteractiveWidth(
              hitStripWidth,
              activeItem !== null,
            ),
          }}
          tabIndex={isInert ? -1 : 0}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveChatTurnMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null
                ? null
                : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  resolveChatTurnMinimapStripWidthClassName(activeDistance),
                )}
                data-chat-turn-minimap-strip=""
                data-in-view="false"
                data-message-id={item.id}
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
          {activeItem === null ? null : (
            <span
              className="pointer-events-auto absolute left-8 w-[min(20rem,calc(100vw-3rem))] cursor-text select-text"
              data-chat-turn-minimap-preview=""
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="block rounded-xl border border-border/60 bg-popover p-3 text-left text-popover-foreground shadow-lg">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-ui-xs font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText === null ? null : (
                  <span className="mt-1 line-clamp-3 text-muted-foreground text-ui-xs leading-5">
                    {activeItem.assistantText}
                  </span>
                )}
              </span>
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
