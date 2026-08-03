/**
 * Shared mutable test-state referenced BOTH by the per-file `vi.mock`
 * factories (via `await import(...)` inside the factory, which sidesteps
 * hoisting TDZ) and by the tests/harness directly. Deliberately has ZERO
 * imports so a factory's dynamic import can never hit a partially-evaluated
 * module cycle.
 *
 * Split from chat-messages.test.tsx's `vi.hoisted` block when that suite was
 * split into per-area files; the per-ref notes below carry the original
 * rationale comments.
 */

export const platformMock = { isMac: true };

/**
 * Default false matches an empty canvas store (existing tests never seed live
 * tiles). Ticket 5 remount-save tests flip this true so unmount commits to
 * the cache; permanent-close tests keep it false so the save-side guard can
 * be asserted. Mirrors use-scroll-restoration.test.tsx.
 */
export const tileLiveness = { live: false };

export const activityGroupOpenIds = {
  lastOpenIds: new Set<string>(),
  setOpenCalls: [] as Array<{ groupId: string; open: boolean }>,
};

/**
 * Ticket 17 (review round 2, finding 2 residual): tee target for the thin
 * pass-through around the REAL `LegendList` component (see the
 * `@legendapp/list/react` mock in each chat-messages-*.test.tsx). Exists
 * purely so tests can drive `setItemSize` directly - the only way to fire a
 * genuine, no-scroll `onItemSizeChanged` in this jsdom harness.
 */
export const legendListRefHolder = {
  current: null as import("@legendapp/list/react").LegendListRef | null,
};

/**
 * Ticket 22 (review round 1, finding 4): call counter for the thin
 * pass-through around the REAL `applyChatAnchorDriftRepair` (see the
 * `chat-messages-scroll-helpers` mock in each chat-messages-*.test.tsx).
 * Counting actual invocations of the shared repair function is deterministic
 * (no rAF-timing noise), unlike spying on `window.requestAnimationFrame`.
 */
export const applyChatAnchorDriftRepairCallCountRef = { current: 0 };
