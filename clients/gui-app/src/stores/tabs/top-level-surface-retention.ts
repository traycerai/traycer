import {
  DESKTOP_RETENTION_PROFILE,
  getRetentionProfile,
} from "@/stores/replica-memory/retention-profile";

/** Desktop cap, kept as a named constant for the suites that count against it. */
export const MAX_RETAINED_TOP_LEVEL_SURFACES =
  DESKTOP_RETENTION_PROFILE.retainedTopLevelSurfaces;

/**
 * Advances the recency order: every currently active key moves to the front, preserving the
 * relative order of everything else.
 */
export function advanceTopLevelSurfaceRecency(
  activeKeys: ReadonlyArray<string>,
  previousRecency: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    ...activeKeys,
    ...previousRecency.filter((key) => !activeKeys.includes(key)),
  ];
}

/**
 * The retained subset of `availableKeys`: every active key, plus enough of
 * `recency` (in order) to fill {@link MAX_RETAINED_TOP_LEVEL_SURFACES}.
 */
export function retainedTopLevelSurfaceKeys(
  availableKeys: ReadonlyArray<string>,
  activeKeys: ReadonlyArray<string>,
  recency: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const available = new Set(availableKeys);
  const availableActiveKeys = activeKeys.filter((key) => available.has(key));
  const ordered = [
    ...availableActiveKeys,
    ...recency.filter((key) => available.has(key) && !activeKeys.includes(key)),
  ];
  const retained = new Set(
    ordered.slice(0, getRetentionProfile().retainedTopLevelSurfaces),
  );
  return availableKeys.filter((key) => retained.has(key));
}
