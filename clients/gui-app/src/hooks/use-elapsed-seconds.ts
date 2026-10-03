import { useEffect, useLayoutEffect, useState } from "react";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import { startVisibleInterval } from "@/lib/dom/visible-interval";

/**
 * Ticks once per second while visible and running so a caller can show a constantly
 * updating elapsed counter (the run indicator, a streaming tool/command's
 * heartbeat, …). Anchored on `startMs` (a wall-clock epoch ms, typically the
 * block/turn start); revealing or resuming the row samples wall time again.
 * Returns whole seconds,
 * clamped at 0 so a small clock skew never shows a negative count.
 */
export function useElapsedSeconds(
  startMs: number,
  pausedDurationMs: number,
  pausedSinceMs: number | null,
): number {
  const visible = useTileBodyVisible();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useLayoutEffect(() => {
    if (!visible) return;
    setNowMs(Date.now());
  }, [visible, pausedSinceMs]);
  useEffect(() => {
    if (!visible || pausedSinceMs !== null) return;
    return startVisibleInterval({
      tick: () => setNowMs(Date.now()),
      intervalMs: 1000,
      fireOnShow: true,
    });
  }, [visible, pausedSinceMs]);
  const activePausedMs =
    pausedSinceMs === null ? 0 : Math.max(0, nowMs - pausedSinceMs);
  return Math.max(
    0,
    Math.floor((nowMs - startMs - pausedDurationMs - activePausedMs) / 1000),
  );
}
