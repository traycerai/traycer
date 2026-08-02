/**
 * The global top-level-surface MRU/retention policy, shared by
 * `TopLevelTabHost`'s keep-alive layer and Ticket 21 slice 2's stable
 * tile-surface-host membership mirror (`tile-surface-membership.ts`).
 *
 * Pure recency + cap algorithm over kind-qualified `TabRef` keys (the
 * `"<kind>:<id>"` format shared with `tabRefKey` in `stores/tabs/layout.ts`),
 * applying ONE global cap across every top-level tab kind (epic, draft,
 * history, settings) - never a per-kind cap. Callers own deriving
 * `availableKeys`/`activeKeys` from their own reactive inputs and persisting
 * `recency` between calls.
 */
export const MAX_RETAINED_TOP_LEVEL_SURFACES = 5;

/**
 * Advances the recency order: every currently active key moves to the
 * front, preserving the relative order of everything else. Idempotent for
 * repeated calls with the same `activeKeys` against its own prior output -
 * callers may call this unconditionally on every recompute rather than
 * gating on an active-set-changed comparison.
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
  const retained = new Set(ordered.slice(0, MAX_RETAINED_TOP_LEVEL_SURFACES));
  return availableKeys.filter((key) => retained.has(key));
}
