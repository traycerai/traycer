import type { Editor } from "@tiptap/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  deriveArtifactHeadingItems,
  measureArtifactHeadingTops,
  resolveArtifactHeadingActiveIndex,
  resolveArtifactHeadingHitStripWidth,
  sameArtifactHeadingOutline,
  toArtifactHeadingOutline,
  ARTIFACT_HEADING_SCROLL_PADDING,
  type ArtifactHeadingOutlineEntry,
} from "./artifact-heading-items";

export interface ArtifactHeadingMetrics {
  /** Level + label only. Identity is deliberately independent of document
   *  positions so typing does not re-render the rail (see below). */
  readonly outline: ReadonlyArray<ArtifactHeadingOutlineEntry>;
  readonly activeIndex: number | null;
  /** Measured safe gutter; `0` makes the pointer target inert. */
  readonly hitStripWidth: number;
  readonly scrollToIndex: (index: number) => void;
}

function resolveScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/**
 * Owns everything the artifact heading rail needs to measure, and nothing it
 * needs to render.
 *
 * Two split representations, on purpose:
 *
 * - `outline` (level + label) is React state, and only replaced when the
 *   document's heading skeleton actually changes. Typing shifts every
 *   ProseMirror position after the caret, so an outline keyed on positions
 *   would hand the rail a new array on each keystroke and re-render it into
 *   the editor's hottest path.
 * - `positionsRef` holds those positions, refreshed on every doc change,
 *   because resolving a heading's DOM node needs the current position.
 *
 * The two are always written together from the same walk, so their indices
 * line up.
 */
export function useArtifactHeadingMetrics(input: {
  readonly editor: Editor;
  readonly scroller: HTMLElement | null;
  /** Invoked by the tile's own scroll handler - no second scroll listener. */
  readonly refreshRef: RefObject<() => void>;
}): ArtifactHeadingMetrics {
  const { editor, scroller, refreshRef } = input;
  const [outline, setOutline] = useState<
    ReadonlyArray<ArtifactHeadingOutlineEntry>
  >(() =>
    toArtifactHeadingOutline(deriveArtifactHeadingItems(editor.state.doc)),
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hitStripWidth, setHitStripWidth] = useState(0);
  const positionsRef = useRef<ReadonlyArray<number>>([]);
  const topsRef = useRef<ReadonlyArray<number>>([]);
  const frameRef = useRef<number | null>(null);

  // Pure arithmetic against the cached tops - no rect reads, so the tile's
  // scroll handler stays free of forced layout. State is written only when the
  // section actually changes, which is once per section boundary rather than
  // once per scroll tick.
  const refreshActive = useCallback((): void => {
    if (scroller === null) return;
    const next = resolveArtifactHeadingActiveIndex({
      tops: topsRef.current,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    });
    setActiveIndex((current) => (current === next ? current : next));
  }, [scroller]);

  const measure = useCallback((): void => {
    if (scroller === null || editor.isDestroyed) return;
    topsRef.current = measureArtifactHeadingTops({
      view: editor.view,
      scroller,
      positions: positionsRef.current,
    });
    setHitStripWidth(
      resolveArtifactHeadingHitStripWidth({
        contentLeft: editor.view.dom.getBoundingClientRect().left,
        scrollerLeft: scroller.getBoundingClientRect().left,
      }),
    );
    refreshActive();
  }, [editor, refreshActive, scroller]);

  /**
   * The queued frame must run the LATEST measure, not the one that happened to
   * be current when it was scheduled.
   *
   * The tile passes its scroller down through `useState` set from a ref
   * callback, so the rail's first render always sees `null` and the element
   * arrives on the very next render - before the first frame fires. With the
   * closure captured at schedule time, that first frame ran a `measure` still
   * bound to `scroller === null` and returned immediately, while the
   * coalescing guard below silently dropped the re-scheduled call that had the
   * real element. Nothing measured, `hitStripWidth` stayed 0, and the rail
   * rendered its ticks over a 0px `inert` hit target: visible, unhoverable,
   * unclickable. Reading through a ref makes the frame's work independent of
   * when it was queued.
   */
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  }, [measure]);

  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measureRef.current();
    });
  }, []);

  // Doc changes: refresh positions every time (they shift under any edit),
  // but replace the rendered outline only when the skeleton differs.
  useEffect(() => {
    const syncFromDoc = (): void => {
      const items = deriveArtifactHeadingItems(editor.state.doc);
      positionsRef.current = items.map((item) => item.id);
      const next = toArtifactHeadingOutline(items);
      setOutline((current) =>
        sameArtifactHeadingOutline(current, next) ? current : next,
      );
      scheduleMeasure();
    };

    syncFromDoc();
    editor.on("update", syncFromDoc);
    return () => {
      editor.off("update", syncFromDoc);
    };
  }, [editor, scheduleMeasure]);

  // Re-measure on layout change. Observing the scroller alone is not enough:
  // content-only reflow (an image loading, a mermaid block rendering, a
  // collaborator's edit above the fold) leaves the scroller's border box
  // untouched while every heading below moves.
  useEffect(() => {
    if (scroller === null) return;
    // Measure as soon as the scroller exists. `ResizeObserver` does fire an
    // initial callback on observe, but relying on it would make the rail's
    // first measurement depend on that callback winning a race with an
    // already-queued frame - and jsdom's stub never fires at all.
    scheduleMeasure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(scroller);
    observer.observe(editor.view.dom);
    return () => {
      observer.disconnect();
    };
  }, [editor, scheduleMeasure, scroller]);

  useEffect(() => {
    refreshRef.current = refreshActive;
    return () => {
      if (refreshRef.current === refreshActive) {
        refreshRef.current = () => undefined;
      }
    };
  }, [refreshActive, refreshRef]);

  // Cancelling and clearing the sentinel must be atomic. Leaving a cancelled
  // frame id behind poisons `scheduleMeasure` permanently: the frame it names
  // will never fire, so nothing ever resets the guard, and every later call
  // returns early. StrictMode makes that certain rather than unlikely - it
  // replays mount effects, so this cleanup runs once on the very first mount,
  // and the replayed setup then finds a non-null id pointing at a frame that
  // was already cancelled. The rail measured nothing, kept `hitStripWidth` at
  // 0, and rendered visible ticks over a 0px `inert` target.
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, []);

  const scrollToIndex = useCallback(
    (index: number): void => {
      if (scroller === null) return;
      if (index < 0 || index >= topsRef.current.length) return;
      scroller.scrollTo({
        top: Math.max(
          0,
          topsRef.current[index] - ARTIFACT_HEADING_SCROLL_PADDING,
        ),
        behavior: resolveScrollBehavior(),
      });
    },
    [scroller],
  );

  return { outline, activeIndex, hitStripWidth, scrollToIndex };
}
