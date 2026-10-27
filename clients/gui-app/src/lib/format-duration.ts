/** A whole-second count as a stopwatch reads it: `0:08`, `3:50`, `1:02:05`. */
export function formatStopwatch(totalSeconds: number): string {
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${Math.floor(totalMinutes / 60)}:${minutes}:${seconds}`;
}

/**
 * Formats a whole-second count as a compact clock duration: "Ns" under a
 * minute, "Nm Xs" under an hour, then "Nh Nm Xs". Shared by the run indicator,
 * the completed-turn footer, and the reasoning "Thought for Xs" label so the
 * format stays in lockstep across the chat surface.
 */
export function formatClockDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m ${seconds}s`;
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
