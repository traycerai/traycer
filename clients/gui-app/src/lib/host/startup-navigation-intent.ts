/**
 * Marks a navigation as an EXPLICIT user escape made from a boot surface, so the desktop's restored-route replay can tell it apart from the routing traffic a launch generates on its own.
 */
export const STARTUP_NAVIGATION_INTENT_KEY = "__traycerStartupNavigationIntent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether a history entry's state carries the escape-hatch marker. */
export function isStartupNavigationIntent(state: unknown): boolean {
  return isRecord(state) && state[STARTUP_NAVIGATION_INTENT_KEY] === true;
}
