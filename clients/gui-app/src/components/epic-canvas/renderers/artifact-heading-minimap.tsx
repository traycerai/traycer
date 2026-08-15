import type { Editor } from "@tiptap/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import {
  resolveMinimapTrackHeightStyle,
  resolveMinimapTrackTopStyle,
} from "@/components/minimap/minimap-track-geometry";
import { cn } from "@/lib/utils";
import {
  ARTIFACT_HEADING_MIN_ITEMS,
  type ArtifactHeadingOutlineEntry,
} from "./artifact-heading-items";
import { useArtifactHeadingMetrics } from "./use-artifact-heading-metrics";

const ARTIFACT_HEADING_ITEM_SPACING = 8;
const ARTIFACT_HEADING_END_HIT_PADDING = 12;
/** The rail lives in a `container-type: size` box spanning the tile body. */
const ARTIFACT_HEADING_TRACK_MAX_HEIGHT_CSS = "max(1px, calc(100cqh - 2rem))";

export interface ArtifactHeadingMinimapProps {
  readonly editor: Editor;
  /** The tile's scroll container. `null` until the tile's ref callback runs. */
  readonly scroller: HTMLElement | null;
  /** Filled by the rail, invoked from the tile's existing `onScroll`. */
  readonly refreshRef: RefObject<() => void>;
}

/**
 * DeepResearch-style heading rail for the artifact editor: one tick per
 * `h1`/`h2`, hover or focus opens the table of contents, and either surface
 * scrolls the document to a section.
 *
 * Deliberately not built on `ChatTurnMinimap`. That component's card, passive
 * pointer path, active-entry persistence and LegendList measurement lifecycle
 * are chat's, and its marker width already encodes distance-to-hover where
 * this rail needs hierarchy. Only the evenly-spaced-track math is shared
 * (`@/components/minimap/minimap-track-geometry`); see the epic's
 * `artifact-heading-minimap-review` artifact.
 *
 * Fine-pointer only - the rail is a hover affordance, and the table of contents
 * is reachable by keyboard through the same control.
 */
export function ArtifactHeadingMinimap(props: ArtifactHeadingMinimapProps) {
  const { outline, activeIndex, hitStripWidth, scrollToIndex } =
    useArtifactHeadingMetrics({
      editor: props.editor,
      scroller: props.scroller,
      refreshRef: props.refreshRef,
    });
  const [open, setOpen] = useState(false);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const hitStripRef = useRef<HTMLButtonElement | null>(null);

  const isInert = hitStripWidth <= 0;

  const jumpTo = useCallback(
    (index: number): number => {
      const clamped = Math.max(0, Math.min(index, outline.length - 1));
      scrollToIndex(clamped);
      return clamped;
    },
    [outline.length, scrollToIndex],
  );

  /**
   * Opening the outline is all this button does.
   *
   * It used to map the pointer's Y to the nearest tick and jump there, which
   * was unreachable by the time it could fire: entering the rail opens the
   * index, and the index covers the strip (it replaces the rail in place), so
   * the click always landed on the card. Keyboard activation is the path that
   * still reaches this handler, and for that "open the outline" is the honest
   * behaviour - the rows below are what navigate.
   */
  const handleHitStripClick = useCallback((): void => {
    setOpen(true);
  }, []);

  // Arrows advance an explicit cursor rather than re-reading the current
  // section. Reading it back would stall under repeat presses: the jump scrolls
  // smoothly, so the second press lands before the first has moved the document
  // and resolves the same index again. The cursor is seeded from the current
  // section on focus and released on blur, so it never drifts from where the
  // reader actually is.
  const cursorRef = useRef<number | null>(null);

  const handleHitStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
      const cursor = cursorRef.current ?? activeIndex ?? 0;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        cursorRef.current = jumpTo(cursor + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        cursorRef.current = jumpTo(cursor - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        cursorRef.current = jumpTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        cursorRef.current = jumpTo(outline.length - 1);
      }
    },
    [activeIndex, jumpTo, outline.length],
  );

  const visible = outline.length >= ARTIFACT_HEADING_MIN_ITEMS;

  // Region-level hover/focus/Escape are attached imperatively rather than as
  // JSX props: the region is a grouping box, and hanging pointer and keyboard
  // handlers off a non-interactive element is exactly what
  // `jsx-a11y/no-noninteractive-element-interactions` forbids. The interactive
  // affordances (the hit strip, the rows) keep their own React handlers.
  //
  // Focus moving between the rail and a row inside the card is movement WITHIN
  // the control, so the outline must survive it - only focus leaving the whole
  // region closes. Escape is handled here for the same reason: it has to work
  // from a focused row as well as from the rail.
  useEffect(() => {
    const region = regionRef.current;
    if (region === null || !visible) return;

    const handleMouseEnter = (): void => {
      if (!isInert) setOpen(true);
    };
    const handleMouseLeave = (): void => {
      setOpen(false);
    };
    const handleFocusOut = (event: FocusEvent): void => {
      if (
        event.relatedTarget instanceof Node &&
        region.contains(event.relatedTarget)
      ) {
        return;
      }
      cursorRef.current = null;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      hitStripRef.current?.blur();
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
  }, [isInert, visible]);

  if (!visible) {
    return null;
  }

  return (
    <div
      // Spans the whole tile so `cq` units below resolve against the PANE, not
      // against the rail's own strip. A canvas pane can shrink to
      // `MIN_PANE_PX` (240px, `tile-tree-constants.ts`) and clips its overflow,
      // so a card sized from the viewport would hang off the edge with its
      // labels cut off. Inert: `pointer-events-none` here, re-enabled only on
      // the control itself.
      className="pointer-events-none absolute inset-0 z-30 hidden [container-type:size] [@media(pointer:fine)]:block"
      data-testid="artifact-heading-minimap"
    >
      <div
        className={cn(
          "absolute top-1/2 left-3 -translate-y-1/2 select-none",
          isInert ? "pointer-events-none" : "pointer-events-auto",
        )}
        aria-hidden={isInert}
        aria-label="Document outline controls"
        {...paneActivationDeferProps}
        inert={isInert}
        ref={regionRef}
        role="group"
        style={{
          height: resolveMinimapTrackHeightStyle(
            {
              itemCount: outline.length,
              itemSpacing: ARTIFACT_HEADING_ITEM_SPACING,
              endHitPadding: ARTIFACT_HEADING_END_HIT_PADDING,
            },
            [ARTIFACT_HEADING_TRACK_MAX_HEIGHT_CSS],
          ),
        }}
      >
        <button
          aria-label="Document outline"
          className={cn(
            "relative block h-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            isInert ? "pointer-events-none" : "pointer-events-auto",
          )}
          data-rail-hidden={open ? "true" : "false"}
          data-testid="artifact-heading-minimap-hit-strip"
          inert={isInert}
          onClick={handleHitStripClick}
          onFocus={() => {
            if (isInert) return;
            cursorRef.current = activeIndex;
            setOpen(true);
          }}
          onKeyDown={handleHitStripKeyDown}
          ref={hitStripRef}
          style={{ width: hitStripWidth }}
          tabIndex={isInert ? -1 : 0}
          type="button"
        >
          {outline.map((entry, index) => (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute left-0 -translate-y-1/2 rounded-full transition-[background-color,height,opacity] duration-150",
                entry.level === 1 ? "w-6" : "w-3",
                index === activeIndex
                  ? "h-[3px] bg-foreground/90"
                  : "h-0.5 bg-muted-foreground/35",
                // The index REPLACES the rail rather than sitting beside it -
                // the ticks are the collapsed form of the same control, so both
                // on screen at once reads as two widgets.
                open ? "opacity-0" : "opacity-100",
              )}
              data-active={index === activeIndex ? "true" : "false"}
              data-level={entry.level}
              data-testid="artifact-heading-minimap-tick"
              key={entry.key}
              style={{
                top: resolveMinimapTrackTopStyle(
                  index,
                  outline.length,
                  ARTIFACT_HEADING_END_HIT_PADDING,
                ),
              }}
            />
          ))}
        </button>
        {open ? (
          <ArtifactHeadingMinimapCard
            activeIndex={activeIndex}
            onSelect={jumpTo}
            outline={outline}
          />
        ) : null}
      </div>
    </div>
  );
}

function ArtifactHeadingMinimapCard(props: {
  readonly activeIndex: number | null;
  readonly onSelect: (index: number) => void;
  readonly outline: ReadonlyArray<ArtifactHeadingOutlineEntry>;
}) {
  const { activeIndex, onSelect, outline } = props;
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reveal the current section before paint, adjusting only this overflow
  // container - a native `scrollIntoView` would also move the document behind
  // it, which merely opening the outline must never do.
  useLayoutEffect(() => {
    const row = activeRowRef.current;
    const list = listRef.current;
    if (row === null || list === null) return;
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const above = rowRect.top - listRect.top;
    const below = rowRect.bottom - listRect.bottom;
    if (above >= 0 && below <= 0) return;
    list.scrollTop = Math.max(0, list.scrollTop + (above < 0 ? above : below));
  }, [activeIndex]);

  return (
    // `left-0` puts the index where the ticks were, so opening it reads as the
    // rail expanding in place rather than a popover appearing next to it.
    <div
      className="pointer-events-auto absolute top-1/2 left-0 w-[min(20rem,calc(100cqw-1.5rem))] -translate-y-1/2 overflow-hidden rounded-xl border border-border/60 bg-popover text-left text-popover-foreground shadow-lg"
      data-testid="artifact-heading-minimap-card"
    >
      <div className="px-3 pt-3 pb-1 text-ui-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
        Table of contents
      </div>
      <div
        className="max-h-[min(60vh,calc(100cqh_-_1rem))] overflow-y-auto p-2 pt-1"
        ref={listRef}
      >
        <div className="flex flex-col gap-0.5">
          {outline.map((entry, index) => (
            <button
              aria-current={index === activeIndex ? "true" : undefined}
              className={cn(
                "w-full cursor-pointer rounded-lg py-1.5 pr-3 text-left text-ui-xs leading-5 transition-colors duration-100 hover:bg-foreground/[0.08] focus-visible:bg-foreground/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                entry.level === 1 ? "pl-3" : "pl-7",
                index === activeIndex
                  ? "bg-foreground/[0.10] font-semibold text-foreground"
                  : "text-muted-foreground",
              )}
              data-active={index === activeIndex ? "true" : "false"}
              data-level={entry.level}
              data-testid="artifact-heading-minimap-row"
              key={entry.key}
              onClick={() => {
                onSelect(index);
              }}
              ref={index === activeIndex ? activeRowRef : null}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
