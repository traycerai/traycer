/**
 * Thanos Traycer product flags (fork-only). Keep small and explicit.
 */

let singleUserChromeOverride: boolean | null = null;

/** First-run cinematic product tour ("ACT 01 – TASKS", Skip intro). */
export function isProductIntroDisabled(): boolean {
  // Keep tour testable in unit/integration suites.
  if (import.meta.env.MODE === "test") {
    return false;
  }
  return true;
}

/**
 * Hide Traycer account/collaboration chrome (billing, sharing, cloud
 * notifications, Sessions/Usage). Login still exists — history lives in
 * Traycer CloudData. False in unit tests so upstream suites keep seeing
 * chrome; override with `__setThanosSingleUserChromeForTests`.
 */
export function isThanosSingleUserChrome(): boolean {
  if (singleUserChromeOverride !== null) return singleUserChromeOverride;
  if (import.meta.env.MODE === "test") return false;
  return true;
}

/** Settings section ids that are account-cloud chrome, not app/host config. */
export function isThanosHiddenSettingsSection(id: string): boolean {
  if (!isThanosSingleUserChrome()) return false;
  return id === "devices" || id === "usage";
}

export function __setThanosSingleUserChromeForTests(
  value: boolean | null,
): void {
  singleUserChromeOverride = value;
}

export function __resetThanosFlagsForTesting(): void {
  singleUserChromeOverride = null;
}
