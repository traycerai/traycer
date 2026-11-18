import { formatClockDuration } from "@traycer/protocol/host/agent/gui/activity-summary";

// Shared with the host, which spells a bot turn's receipt with it.
export { formatClockDuration };

/** A whole-second count as a stopwatch reads it: `0:08`, `3:50`, `1:02:05`. */
export function formatStopwatch(totalSeconds: number): string {
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${Math.floor(totalMinutes / 60)}:${minutes}:${seconds}`;
}

/**
 * Format an elapsed duration for the "Worked for Nm Xs" footer and the
 * background card's "No reply · Ns" line.
 *
 * Named distinctly from the dictation-bar's `formatElapsed` (M:SS stopwatch
 * format) so an unqualified import never picks the wrong formatter.
 *
 * - Non-finite / negative inputs (clock skew, replay anomalies) → "<1s",
 *   visually distinct from a sub-1s real-fast turn (which reads "<1s" too -
 *   acceptable since both convey "negligible duration" without the misleading
 *   "0s" rounding from `Math.round`).
 * - 1ms..999ms → "<1s".
 * - 1s..59s → "Ns".
 * - 1m..59m → "Nm Xs".
 * - 1h+    → "Nh Nm Xs".
 */
export function formatWorkedFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  return formatClockDuration(Math.floor(ms / 1000));
}
