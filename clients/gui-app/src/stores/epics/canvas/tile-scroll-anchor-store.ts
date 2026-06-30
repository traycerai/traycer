/**
 * Session-only per-tile scroll anchors.
 *
 * Holds one `TileScrollAnchor` per canvas tile `instanceId` so a tile's reading
 * position survives both `display:none` keep-alive hiding (which zeroes a
 * container's `scrollTop`) and a full unmount/remount within the session (LRU
 * eviction beyond the keep-alive caps). Intentionally NOT persisted: a fresh
 * app load starts every tile at its natural default. If we ever want scroll to
 * survive a reload, wrap this with `persist` middleware.
 *
 * Read imperatively via `useTileScrollAnchorStore.getState()` inside effects -
 * never subscribe from a tile body, or every tile would re-render whenever any
 * other tile saves its position. Entries are evicted by the canvas store's
 * tile-removal subscriber (see `store.ts`), keyed by the same `instanceId`.
 */
import { create } from "zustand";
import type { StateSnapshot } from "react-virtuoso";

/**
 * Per-tile scroll snapshot. A discriminated union so each tile kind narrows to
 * exactly the fields it can restore from.
 */
export type TileScrollAnchor =
  ChatScrollAnchor | NativeScrollAnchor | BundleDiffScrollAnchor;

/**
 * Chat transcript anchor. `followingBottom` is the reader's pin intent: when
 * true the restore snaps to the newest message (which may have grown while the
 * tile was hidden); when false the saved `scrollTop` offset is restored.
 */
export interface ChatScrollAnchor {
  readonly kind: "chat";
  readonly followingBottom: boolean;
  readonly scrollTop: number;
}

/**
 * Native overflow-scroll container anchor (artifact editors, single-file diffs,
 * file viewers). `scrollHeight`/`scrollWidth` are captured alongside the
 * offsets so restore can fall back to a proportional position when the content
 * reflowed to a different size while the tile was away.
 */
export interface NativeScrollAnchor {
  readonly kind: "native";
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
}

/**
 * Bundle (multi-file) diff anchor. `react-virtuoso` owns the virtualized list,
 * so we keep its opaque `StateSnapshot` (item ranges + scrollTop) and hand it
 * back via the `restoreStateFrom` prop.
 */
export interface BundleDiffScrollAnchor {
  readonly kind: "bundle-diff";
  readonly virtuosoState: StateSnapshot;
}

interface TileScrollAnchorStore {
  readonly anchors: Readonly<Record<string, TileScrollAnchor | undefined>>;
  readonly setAnchor: (instanceId: string, anchor: TileScrollAnchor) => void;
  readonly getAnchor: (instanceId: string) => TileScrollAnchor | undefined;
  readonly clearAnchors: (instanceIds: ReadonlyArray<string>) => void;
}

export const useTileScrollAnchorStore = create<TileScrollAnchorStore>(
  (set, get) => ({
    anchors: {},
    setAnchor: (instanceId, anchor) =>
      set((state) => ({
        anchors: { ...state.anchors, [instanceId]: anchor },
      })),
    getAnchor: (instanceId) => get().anchors[instanceId],
    clearAnchors: (instanceIds) =>
      set((state) => {
        const idsToRemove = new Set(
          instanceIds.filter((id) => state.anchors[id] !== undefined),
        );
        if (idsToRemove.size === 0) return state;
        return {
          anchors: Object.fromEntries(
            Object.entries(state.anchors).filter(
              ([id]) => !idsToRemove.has(id),
            ),
          ),
        };
      }),
  }),
);
