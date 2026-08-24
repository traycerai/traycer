import type { MinimapListEntry } from "@/components/minimap/minimap-list-card";

/**
 * What a tile publishes for the phone tile bar's minimap button to render.
 *
 * Deliberately a pull-plus-subscribe adapter rather than plain store state:
 * `currentIndex` follows the reader's scroll position, so writing it into the
 * store would re-render every subscriber on each section boundary. The bar
 * holds only the (stable) adapter, and the open drawer is the sole reader.
 */
export interface TileMinimapSnapshot {
  readonly items: ReadonlyArray<MinimapListEntry>;
  /** Entry the content is scrolled to. Out of range means "none resolved". */
  readonly currentIndex: number;
}

/**
 * Arrow-typed properties rather than methods: the button hands `subscribe` and
 * `getSnapshot` straight to `useSyncExternalStore`, detached from the adapter.
 */
export interface TileMinimapAdapter {
  /** Card heading: "Messages" for a chat, "Table of contents" for a document. */
  readonly title: string;
  readonly getSnapshot: () => TileMinimapSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly select: (index: number) => void;
}

export interface TileMinimapTargetRegistration {
  readonly tileInstanceId: string;
  readonly adapter: TileMinimapAdapter;
}

export interface TileMinimapTargetRecord extends TileMinimapTargetRegistration {
  readonly registeredAt: number;
}
