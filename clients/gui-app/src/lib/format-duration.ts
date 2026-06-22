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
