/**
 * Session-only per-PR view state for the full-view tile: which tab is open and
 * which chat its `⌁` affordances send to.
 *
 * Keyed by the PR's own GitHub coordinates, NOT by tile `instanceId`. The tile
 * ref is a pure coordinate identity that dedupes and reopens the same tile
 * (see `PrDetailTileRef`), so closing and reopening a PR should land back on
 * the tab you were reading rather than resetting to Overview. Coordinate keying
 * also means there is nothing to evict when a tile is removed.
 *
 * Not persisted, matching `tile-scroll-anchor-store`: a fresh app load starts
 * every PR on Overview. Wrap with `persist` if that ever needs to survive a
 * reload - the shape is already serialisable.
 */
import { create } from "zustand";

export const PR_DETAIL_TABS = [
  "overview",
  "feedback",
  "files",
  "checks",
  "commits",
] as const;

export type PrDetailTabId = (typeof PR_DETAIL_TABS)[number];

export function prDetailViewKey(coordinates: {
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): string {
  return `${coordinates.githubHost}/${coordinates.owner}/${coordinates.repo}#${coordinates.prNumber}`;
}

interface PrDetailViewEntry {
  readonly tab: PrDetailTabId;
  /**
   * The chosen quote target's id, or `null` while the user has not picked one.
   * Stored as a bare id rather than the resolved target so a deleted chat
   * simply stops resolving instead of pinning a stale title forever.
   */
  readonly targetId: string | null;
}

const DEFAULT_ENTRY: PrDetailViewEntry = { tab: "overview", targetId: null };

interface PrDetailViewStore {
  // Explicitly `| undefined`: most keys are absent, and the default-applying
  // reads below depend on that being visible in the type.
  readonly byKey: Readonly<Record<string, PrDetailViewEntry | undefined>>;
  readonly setTab: (key: string, tab: PrDetailTabId) => void;
  readonly setTargetId: (key: string, targetId: string) => void;
}

export const usePrDetailViewStore = create<PrDetailViewStore>((set) => ({
  byKey: {},
  setTab: (key, tab) =>
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: { ...(state.byKey[key] ?? DEFAULT_ENTRY), tab },
      },
    })),
  setTargetId: (key, targetId) =>
    set((state) => ({
      byKey: {
        ...state.byKey,
        [key]: { ...(state.byKey[key] ?? DEFAULT_ENTRY), targetId },
      },
    })),
}));

export function usePrDetailTab(key: string): PrDetailTabId {
  return usePrDetailViewStore((state) => state.byKey[key]?.tab ?? "overview");
}

export function usePrDetailTargetId(key: string): string | null {
  return usePrDetailViewStore((state) => state.byKey[key]?.targetId ?? null);
}
