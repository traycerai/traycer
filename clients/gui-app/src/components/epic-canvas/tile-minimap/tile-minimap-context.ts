import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { MinimapListEntry } from "@/components/minimap/minimap-list-card";
import {
  useTileMinimapStore,
  type TileMinimapAdapter,
  type TileMinimapSnapshot,
} from "@/stores/tile-minimap";

/** The canvas tile instance a render subtree belongs to. */
export const TileMinimapContext = createContext<string | null>(null);

function sameOutline(
  current: ReadonlyArray<MinimapListEntry>,
  next: ReadonlyArray<MinimapListEntry>,
): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const a = current[index];
    const b = next[index];
    if (a.key !== b.key || a.label !== b.label || a.level !== b.level) {
      return false;
    }
  }
  return true;
}

export interface RegisterTileMinimapInput {
  readonly title: string;
  readonly items: ReadonlyArray<MinimapListEntry>;
  readonly currentIndex: number;
  readonly onSelect: (index: number) => void;
}

/**
 * The bar is a sibling of the tile body, not an ancestor, so the outline travels through the store rather than down through props - the shape `TileFindScope` already uses for the find bar.
 * The snapshot lives in a ref rather than store state on purpose; see `TileMinimapSnapshot`.
 */
export function useRegisterTileMinimap(input: RegisterTileMinimapInput): void {
  const { title, items, currentIndex, onSelect } = input;
  const tileInstanceId = useContext(TileMinimapContext);
  const registerTarget = useTileMinimapStore((state) => state.registerTarget);
  const snapshotRef = useRef<TileMinimapSnapshot>({ items, currentIndex });
  const listenersRef = useRef(new Set<() => void>());
  const onSelectRef = useRef(onSelect);

  useLayoutEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // It costs a section boundary, never a stream token - and a publisher above a streaming transcript derives `items` from an array that IS replaced per token.
  useEffect(() => {
    const previous = snapshotRef.current;
    if (
      previous.currentIndex === currentIndex &&
      sameOutline(previous.items, items)
    ) {
      return;
    }
    snapshotRef.current = { items, currentIndex };
    for (const listener of listenersRef.current) listener();
  }, [currentIndex, items]);

  const adapter = useMemo<TileMinimapAdapter>(
    () => ({
      title,
      getSnapshot: () => snapshotRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
      select: (index) => onSelectRef.current(index),
    }),
    [title],
  );

  useEffect(() => {
    if (tileInstanceId === null) return;
    return registerTarget({ tileInstanceId, adapter });
  }, [adapter, registerTarget, tileInstanceId]);
}
