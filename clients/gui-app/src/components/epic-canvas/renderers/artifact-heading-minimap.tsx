import type { Editor } from "@tiptap/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import { MinimapListCard } from "@/components/minimap/minimap-list-card";
import { resolveMinimapRailMaskClassName } from "@/components/minimap/minimap-rail-mask";
import { MinimapRailTick } from "@/components/minimap/minimap-rail-tick";
import {
  MINIMAP_TRACK_END_HIT_PADDING,
  MINIMAP_TRACK_ITEM_SPACING,
  resolveMinimapTrackHeightStyle,
  resolveMinimapTrackTopStyle,
  resolveMinimapWindow,
} from "@/components/minimap/minimap-track-geometry";
import { cn } from "@/lib/utils";
import type { MinimapSide } from "@/stores/settings/settings-store";
import { useArtifactHeadingMetrics } from "./use-artifact-heading-metrics";

const ARTIFACT_HEADING_TRACK_MAX_HEIGHT_CSS = "max(1px, calc(100cqh - 2rem))";

export interface ArtifactHeadingMinimapProps {
  readonly editor: Editor;
  readonly scroller: HTMLElement | null;
  readonly refreshRef: RefObject<() => void>;
  readonly side: MinimapSide;
}

function clampIndex(index: number, itemCount: number): number {
  return Math.max(0, Math.min(index, itemCount - 1));
}

/** A document outline with the same open, select, and keyboard model as chat. */
export function ArtifactHeadingMinimap(props: ArtifactHeadingMinimapProps) {
  const {
    outline,
    activeIndex,
    hitStripWidth,
    maxVisibleItems,
    scrollToIndex,
  } = useArtifactHeadingMetrics({
    editor: props.editor,
    scroller: props.scroller,
    refreshRef: props.refreshRef,
    side: props.side,
  });
  const [open, setOpen] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const hitStripRef = useRef<HTMLButtonElement | null>(null);
  const visible = outline.length > 0;
  const isInert = hitStripWidth <= 0;
  const currentIndex = clampIndex(activeIndex ?? 0, outline.length);
  const resolvedCursorIndex = clampIndex(cursorIndex, outline.length);

  useEffect(() => {
    const region = regionRef.current;
    if (region === null || !visible) return;
    const handleMouseEnter = (): void => {
      if (isInert) return;
      setCursorIndex(currentIndex);
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
  }, [currentIndex, isInert, visible]);

  const openAtCurrent = useCallback((): void => {
    if (isInert) return;
    setCursorIndex(currentIndex);
    setOpen(true);
  }, [currentIndex, isInert]);

  const moveCursor = useCallback(
    (index: number): void => {
      setCursorIndex(clampIndex(index, outline.length));
      setOpen(true);
    },
    [outline.length],
  );

  const select = useCallback(
    (index: number): void => {
      const next = clampIndex(index, outline.length);
      setCursorIndex(next);
      scrollToIndex(next);
    },
    [outline.length, scrollToIndex],
  );

  const handleHitStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveCursor((open ? resolvedCursorIndex : currentIndex) + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveCursor((open ? resolvedCursorIndex : currentIndex) - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        moveCursor(0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveCursor(outline.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(open ? resolvedCursorIndex : currentIndex);
        setOpen(true);
      }
    },
    [
      currentIndex,
      moveCursor,
      open,
      outline.length,
      resolvedCursorIndex,
      select,
    ],
  );

  if (!visible || isInert) return null;

  const window = resolveMinimapWindow({
    currentIndex,
    itemCount: outline.length,
    maxItems: maxVisibleItems,
  });
  const railItems = outline.slice(window.startIndex, window.endIndex);
  const continuationMaskClassName = resolveMinimapRailMaskClassName(
    window.hasBefore,
    window.hasAfter,
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30 hidden [container-type:size] [@media(pointer:fine)]:block"
      data-side={props.side}
      data-testid="artifact-heading-minimap"
    >
      <div
        aria-label="Document outline controls"
        className={cn(
          "pointer-events-auto absolute top-1/2 -translate-y-1/2 select-none",
          props.side === "left" ? "left-3" : "right-3",
        )}
        {...paneActivationDeferProps}
        ref={regionRef}
        role="group"
        style={{
          height: resolveMinimapTrackHeightStyle(
            {
              itemCount: railItems.length,
              itemSpacing: MINIMAP_TRACK_ITEM_SPACING,
              endHitPadding: MINIMAP_TRACK_END_HIT_PADDING,
            },
            [ARTIFACT_HEADING_TRACK_MAX_HEIGHT_CSS],
          ),
        }}
      >
        <button
          aria-label="Document outline"
          aria-expanded={open}
          className={cn(
            "relative block h-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            continuationMaskClassName,
          )}
          data-testid="artifact-heading-minimap-hit-strip"
          onClick={() => setOpen(true)}
          onFocus={openAtCurrent}
          onKeyDown={handleHitStripKeyDown}
          ref={hitStripRef}
          style={{ width: hitStripWidth }}
          type="button"
        >
          {railItems.map((entry, localIndex) => {
            const index = window.startIndex + localIndex;
            return (
              <MinimapRailTick
                active={index === currentIndex}
                availableWidth={hitStripWidth}
                data-testid="artifact-heading-minimap-tick"
                hierarchical
                key={entry.key}
                level={entry.level}
                open={open}
                side={props.side}
                top={resolveMinimapTrackTopStyle(
                  localIndex,
                  railItems.length,
                  MINIMAP_TRACK_END_HIT_PADDING,
                )}
              />
            );
          })}
        </button>
        {open ? (
          <div
            className={cn(
              "absolute top-1/2 w-[min(20rem,calc(100cqw-1.5rem))] -translate-y-1/2",
              props.side === "left" ? "left-0" : "right-0",
            )}
            data-testid="artifact-heading-minimap-card"
          >
            <MinimapListCard
              currentIndex={currentIndex}
              cursorIndex={resolvedCursorIndex}
              items={outline}
              onCursorIndexChange={setCursorIndex}
              onSelect={select}
              side={props.side}
              title="Table of contents"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
