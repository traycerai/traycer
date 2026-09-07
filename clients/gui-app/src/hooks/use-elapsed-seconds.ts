import { useEffect, useState } from "react";

/** Returns whole seconds, clamped at 0 so a small clock skew never shows a negative count. */
export function useElapsedSeconds(
  startMs: number,
  pausedDurationMs: number,
  pausedSinceMs: number | null,
): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);
  const activePausedMs =
    pausedSinceMs === null ? 0 : Math.max(0, nowMs - pausedSinceMs);
  return Math.max(
    0,
    Math.floor((nowMs - startMs - pausedDurationMs - activePausedMs) / 1000),
  );
}
