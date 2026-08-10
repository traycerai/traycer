/**
 * Thanos Traycer product flags (fork-only). Keep small and explicit.
 */

/** First-run cinematic product tour ("ACT 01 – TASKS", Skip intro). */
export function isProductIntroDisabled(): boolean {
  // Keep tour testable in unit/integration suites.
  if (import.meta.env.MODE === "test") {
    return false;
  }
  return true;
}
