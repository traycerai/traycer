import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import * as m from "motion/react-m";
import { ChatUserMessageContent } from "@/components/chat/chat-user-message-content";
import { ComposerContentRenderer } from "@/components/chat/composer/content-renderer";
import {
  CHAT_MINIMAP_CLIP_REGION_SELECTOR,
  type ChatUserMinimapItem,
} from "@/components/chat/chat-user-message-minimap-items";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import { cn } from "@/lib/utils";

const MAX_RAIL_MARKERS = 120;
const MINIMAP_EDGE_INSET_PX = 12;
const MINIMAP_OVERLAY_MAX_HEIGHT_VAR = "--chat-minimap-overlay-max-height";
const MINIMAP_OVERLAY_WIDTH_VAR = "--chat-minimap-overlay-width";

interface ChatUserMessageMinimapProps {
  readonly items: ReadonlyArray<ChatUserMinimapItem>;
  readonly activeMessageId: string | null;
  readonly onItemClick: (messageId: string) => void;
}

/**
 * Compact bar rail (top-right of chat) that expands into a floating
 * overlay listbox on hover/focus. Active item reflects the user message
 * currently being viewed in the scroll container - owned by `ChatMessages`.
 */
export function ChatUserMessageMinimap(props: ChatUserMessageMinimapProps) {
  const [overlayOpen, setOverlayOpen] = useState(false);

  if (props.items.length === 0) return null;

  const closeOverlayIfFocusLeft = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOverlayOpen(false);
  };

  return (
    <div
      {...paneActivationDeferProps}
      className="pointer-events-auto absolute right-3 top-3 z-20 flex flex-col items-end [.traycer-panel-resizing_&]:pointer-events-none [.traycer-panel-resizing_&]:opacity-0"
      onPointerEnter={() => setOverlayOpen(true)}
      onPointerLeave={() => setOverlayOpen(false)}
      onFocusCapture={() => setOverlayOpen(true)}
      onBlurCapture={closeOverlayIfFocusLeft}
      data-testid="chat-user-message-minimap"
    >
      {overlayOpen ? (
        <ChatUserMessageMinimapOverlay
          {...props}
          onItemClick={(id) => {
            props.onItemClick(id);
            setOverlayOpen(false);
          }}
        />
      ) : (
        <ChatUserMessageMinimapRail {...props} />
      )}
    </div>
  );
}

const ChatUserMessageMinimapRail = memo(ChatUserMessageMinimapRailImpl);

function ChatUserMessageMinimapRailImpl(props: ChatUserMessageMinimapProps) {
  const railItems = useMemo(
    () => sampleRailItems(props.items, props.activeMessageId),
    [props.activeMessageId, props.items],
  );

  return (
    <div
      className="flex max-h-[calc(100vh-12rem)] flex-col items-end gap-1.5 overflow-hidden rounded-md bg-canvas/90 px-px py-1"
      data-testid="chat-user-message-minimap-rail"
    >
      {railItems.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-label={minimapItemAriaLabel(item)}
          onClick={() => props.onItemClick(item.id)}
          className={cn(
            "h-[2px] w-5 shrink-0 cursor-pointer rounded-full border-0 p-0 transition-colors",
            item.id === props.activeMessageId
              ? "bg-foreground/80"
              : "bg-foreground/25 hover:bg-foreground/50",
          )}
        />
      ))}
    </div>
  );
}

function ChatUserMessageMinimapOverlay(props: ChatUserMessageMinimapProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const activeOptionRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const clippingParent = minimapOverlayClippingParent(overlay);
    if (clippingParent === null) return;
    let updateFrame: number | null = null;

    const updateBoundsAndReveal = (): void => {
      updateFrame = null;
      applyMinimapOverlayBounds(overlay);
      revealActiveMinimapOption(overlay, activeOptionRef.current);
    };
    const scheduleBoundsUpdate = (): void => {
      if (updateFrame !== null) return;
      updateFrame = window.requestAnimationFrame(updateBoundsAndReveal);
    };

    applyMinimapOverlayBounds(overlay);
    const observer = new ResizeObserver(scheduleBoundsUpdate);
    observer.observe(clippingParent);
    window.addEventListener("resize", scheduleBoundsUpdate);
    return () => {
      if (updateFrame !== null) window.cancelAnimationFrame(updateFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleBoundsUpdate);
    };
  }, []);

  useLayoutEffect(() => {
    if (props.activeMessageId === null) return;
    const overlay = overlayRef.current;
    const activeOption = activeOptionRef.current;
    if (overlay === null) return;
    revealActiveMinimapOption(overlay, activeOption);
  }, [props.activeMessageId]);

  return (
    <m.div
      ref={overlayRef}
      role="listbox"
      aria-label="Jump to user message"
      initial={{ opacity: 0, scale: 0.96, y: -8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{
        opacity: { duration: 0.22, ease: [0.4, 0, 0.2, 1] },
        scale: { type: "spring", stiffness: 280, damping: 28, mass: 0.7 },
        y: { type: "spring", stiffness: 280, damping: 28, mass: 0.7 },
      }}
      style={{ transformOrigin: "top right" }}
      // The design caps (min(...)) own the clamp; the CSS vars contribute only
      // the measured ceiling from `applyMinimapOverlayBounds`. Until that runs
      // (and when it cannot measure) the vars fall back to a no-op viewport
      // value, leaving just the design caps - one source for the base clamp,
      // no first-paint flash, and Tailwind still extracts the static class.
      className="flex w-[min(22rem,40vw,var(--chat-minimap-overlay-width,100vw))] max-h-[min(60vh,32rem,var(--chat-minimap-overlay-max-height,100vh))] flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-lg"
      data-testid="chat-user-message-minimap-overlay"
    >
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          ref={item.id === props.activeMessageId ? activeOptionRef : undefined}
          aria-selected={item.id === props.activeMessageId}
          onClick={() => props.onItemClick(item.id)}
          className={cn(
            "block h-[3.25rem] w-full shrink-0 cursor-pointer overflow-hidden rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-ui-xs leading-5 transition-colors",
            item.id === props.activeMessageId
              ? "bg-primary/10 text-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <ChatUserMessageMinimapItemContent item={item} />
        </button>
      ))}
    </m.div>
  );
}

const ChatUserMessageMinimapItemContent = memo(
  function ChatUserMessageMinimapItemContent({
    item,
  }: {
    readonly item: ChatUserMinimapItem;
  }) {
    const className =
      "line-clamp-2 h-full break-words whitespace-normal [content-visibility:auto] [contain-intrinsic-size:2.5rem]";
    if (item.structuredContent !== null) {
      return (
        <ComposerContentRenderer
          content={item.structuredContent}
          variant="minimap"
          className={className}
          testId={undefined}
        />
      );
    }
    return (
      <span className={className}>
        <ChatUserMessageContent
          content={item.content}
          attachments={item.attachments}
        />
      </span>
    );
  },
);

function revealActiveMinimapOption(
  overlay: HTMLElement,
  activeOption: HTMLElement | null,
): void {
  if (activeOption === null) return;
  const centeredTop =
    activeOption.offsetTop -
    (overlay.clientHeight - activeOption.offsetHeight) / 2;
  const maxScrollTop = overlay.scrollHeight - overlay.clientHeight;
  overlay.scrollTop = Math.max(0, Math.min(centeredTop, maxScrollTop));
}

function minimapOverlayClippingParent(
  overlay: HTMLElement,
): HTMLElement | null {
  const clippingParent = overlay.closest(CHAT_MINIMAP_CLIP_REGION_SELECTOR);
  return clippingParent instanceof HTMLElement ? clippingParent : null;
}

function applyMinimapOverlayBounds(overlay: HTMLElement): void {
  const root = overlay.parentElement;
  const clippingParent = minimapOverlayClippingParent(overlay);
  if (root === null || clippingParent === null) return;

  const rootRect = root.getBoundingClientRect();
  const clippingRect = clippingParent.getBoundingClientRect();
  const maxHeightPx = Math.floor(
    clippingRect.bottom - rootRect.top - MINIMAP_EDGE_INSET_PX,
  );
  const maxWidthPx = Math.floor(
    rootRect.right - clippingRect.left - MINIMAP_EDGE_INSET_PX,
  );

  if (maxHeightPx > 0) {
    overlay.style.setProperty(
      MINIMAP_OVERLAY_MAX_HEIGHT_VAR,
      `${maxHeightPx}px`,
    );
  } else {
    overlay.style.removeProperty(MINIMAP_OVERLAY_MAX_HEIGHT_VAR);
  }
  if (maxWidthPx > 0) {
    overlay.style.setProperty(MINIMAP_OVERLAY_WIDTH_VAR, `${maxWidthPx}px`);
  } else {
    overlay.style.removeProperty(MINIMAP_OVERLAY_WIDTH_VAR);
  }
}

function sampleRailItems(
  items: ReadonlyArray<ChatUserMinimapItem>,
  activeMessageId: string | null,
): ReadonlyArray<ChatUserMinimapItem> {
  if (items.length <= MAX_RAIL_MARKERS) return items;

  const selectedIndexes = new Set<number>([0, items.length - 1]);
  const activeIndex =
    activeMessageId === null
      ? -1
      : items.findIndex((item) => item.id === activeMessageId);
  if (activeIndex >= 0) selectedIndexes.add(activeIndex);

  const slots = MAX_RAIL_MARKERS - selectedIndexes.size;
  const lastIndex = items.length - 1;
  for (let slot = 1; slot <= slots; slot += 1) {
    selectedIndexes.add(Math.round((slot * lastIndex) / (slots + 1)));
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => items[index]);
}

function minimapItemAriaLabel(item: ChatUserMinimapItem): string {
  const trimmed = item.content.trim();
  if (trimmed.length === 0) return "Jump to user message";
  const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  return `Jump to user message: ${preview}`;
}
