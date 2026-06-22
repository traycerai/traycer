import { useCallback, useMemo, useRef, type UIEvent } from "react";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import type {
  ScrollRestorationAdapter,
  TileScrollAnchor,
} from "@/hooks/scroll/scroll-restoration-adapter";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";

interface NativeScrollMetrics {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
}

interface NativeDivScrollRestoration {
  /** Callback ref - attach to the scrolling element's `ref`. */
  readonly scrollContainerRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

/**
 * Scroll preservation for a native overflow-scroll `<div>` tile body (artifact
 * editors, single-file diffs, file viewers). Spread the returned `ref` and
 * `onScroll` onto the scrolling element. `contentReady` should be false while
 * the body shows a loading/skeleton state so restore waits for real content.
 *
 * Captures both axes; vertical-only surfaces simply restore `scrollLeft` 0.
 * Exposes a callback ref (not a ref object) so it can be forwarded into shared
 * primitives without tripping the "no refs during render" rule.
 */
export function useNativeDivScrollRestoration(
  instanceId: string,
  contentReady: boolean,
): NativeDivScrollRestoration {
  const visible = useTileBodyVisible();

  const elementRef = useRef<HTMLDivElement | null>(null);
  const liveMetricsRef = useRef<NativeScrollMetrics | null>(null);

  const scrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      elementRef.current = element;
    },
    [],
  );

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    // A concealed container reports a zero-height box; ignore so a hidden-state
    // read never clobbers the saved position.
    if (el.clientHeight === 0) return;
    liveMetricsRef.current = {
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      scrollWidth: el.scrollWidth,
    };
  }, []);

  const adapter = useMemo<ScrollRestorationAdapter>(
    () => ({
      captureAnchor: () => {
        const metrics = liveMetricsRef.current;
        if (metrics === null) return null;
        return { kind: "native", ...metrics };
      },
      applyAnchor: (anchor: TileScrollAnchor) => {
        if (anchor.kind !== "native") return "gave-up";
        const el = elementRef.current;
        // `clientHeight === 0` is the not-laid-out / concealed signal;
        // `scrollHeight` is always >= `clientHeight`, so a separate
        // `scrollHeight === 0` check would be unreachable here.
        if (el === null || el.clientHeight === 0) return "retry";
        el.scrollTop = resolveOffset(
          anchor.scrollTop,
          anchor.scrollHeight,
          el.scrollHeight,
          el.scrollHeight - el.clientHeight,
        );
        el.scrollLeft = resolveOffset(
          anchor.scrollLeft,
          anchor.scrollWidth,
          el.scrollWidth,
          el.scrollWidth - el.clientWidth,
        );
        return "applied";
      },
    }),
    [],
  );

  useScrollRestoration(instanceId, adapter, visible, contentReady);

  return { scrollContainerRef, onScroll };
}

/**
 * Clamp a saved offset to the current scroll extent. `currentMax` is the largest
 * valid offset (`scrollHeight - clientHeight`), NOT the full `scrollHeight`:
 * comparing against the full extent would accept an offset the browser then
 * silently clamps to the bottom. When the content reflowed shorter/narrower than
 * when captured, fall back to the same proportional depth (clamped to the new
 * max) instead of pinning to the new end.
 */
function resolveOffset(
  savedOffset: number,
  savedExtent: number,
  currentExtent: number,
  currentMax: number,
): number {
  if (savedOffset <= currentMax) return savedOffset;
  if (savedExtent <= 0) return 0;
  const proportional = Math.round((savedOffset / savedExtent) * currentExtent);
  return Math.min(proportional, currentMax);
}
