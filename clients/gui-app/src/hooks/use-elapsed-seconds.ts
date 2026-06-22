import { useEffect, useState } from "react";

/**
 * Ticks once per second while mounted so a caller can show a constantly
 * updating elapsed counter (the run indicator, a streaming tool/command's
 * heartbeat, …). Anchored on `startMs` (a wall-clock epoch ms, typically the
 * block/turn start); the interval lives only while the consuming row is
 * mounted, which is exactly the in-progress window. Returns whole seconds,
 * clamped at 0 so a small clock skew never shows a negative count.
 */
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
