import { useCallback, useMemo, useRef, type UIEvent } from "react";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import type {
  ScrollRestorationAdapter,
  TileScrollAnchor,
} from "@/hooks/scroll/scroll-restoration-adapter";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";
import { readingPositionIdentityForTileInstance } from "@/lib/reading-position";

interface NativeScrollMetrics {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
}

interface NativeDivScrollRestoration {
  readonly scrollContainerRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

/**
 * Native overflow-scroll restore. Callback ref so it can be forwarded without a render-time ref read. `contentReady` false while the body is a skeleton.
 */
export function useNativeDivScrollRestoration(
  instanceId: string,
  contentReady: boolean,
): NativeDivScrollRestoration {
  const visible = useTileBodyVisible();
  const identity = useMemo(
    () => readingPositionIdentityForTileInstance(instanceId),
    [instanceId],
  );

  const elementRef = useRef<HTMLDivElement | null>(null);
  const liveMetricsRef = useRef<NativeScrollMetrics | null>(null);

  const scrollContainerRef = useCallback(
    (element: HTMLDivElement | null): void => {
      elementRef.current = element;
    },
    [],
  );

  const adapter = useMemo<ScrollRestorationAdapter>(
    () => ({
      surfaceKind: "native",
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

  const { commit } = useScrollRestoration(
    identity,
    adapter,
    visible,
    contentReady,
  );

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>): void => {
      const el = event.currentTarget;
      // A concealed container reports a zero-height box; ignore so a
      // hidden-state read never clobbers the saved position.
      if (el.clientHeight === 0) return;
      liveMetricsRef.current = {
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
      };
      commit();
    },
    [commit],
  );

  return { scrollContainerRef, onScroll };
}

/** `currentMax` is the largest valid offset (`scrollHeight - clientHeight`), NOT the full `scrollHeight`: comparing against the full extent would accept an offset the browser then silently clamps to the bottom. */
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
