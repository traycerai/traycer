import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

/**
 * Rows a virtual list must keep mounted although they are outside its window.
 *
 * A windowed list unmounts a row the moment it scrolls out of range, and with
 * it everything the row holds: an open delete dialog, a rename in progress, the
 * focused button, the drag source dnd-kit is measuring. Each of those pins the
 * row by key for as long as it lasts; the list adds the pinned rows to its
 * rendered range, at their true offsets.
 *
 * Pins are counted, so two holders of one key release it independently.
 */
export interface VirtualRowPinStore {
  readonly subscribe: (listener: () => void) => () => void;
  /** The pinned keys. Same identity until a pin is added or released. */
  readonly getSnapshot: () => ReadonlySet<string>;
  /** Pins `key` until the returned release runs. */
  readonly pin: (key: string) => () => void;
}

const NO_PINS: ReadonlySet<string> = new Set();

export function createVirtualRowPinStore(): VirtualRowPinStore {
  const counts = new Map<string, number>();
  let snapshot: ReadonlySet<string> = NO_PINS;
  const listeners = new Set<() => void>();
  const publish = (): void => {
    snapshot = new Set(counts.keys());
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    pin: (key) => {
      const before = counts.get(key) ?? 0;
      counts.set(key, before + 1);
      if (before === 0) publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = counts.get(key) ?? 0;
        if (count <= 1) {
          counts.delete(key);
          publish();
        } else {
          counts.set(key, count - 1);
        }
      };
    },
  };
}

export const VirtualRowPinContext = createContext<VirtualRowPinStore | null>(
  null,
);

/**
 * Keeps the row `key` mounted while `active`. A `null` key or an inactive
 * pin holds nothing, so a caller can pass what it has unconditionally.
 */
export function useVirtualRowPin(key: string | null, active: boolean): void {
  const store = useContext(VirtualRowPinContext);
  useEffect(() => {
    if (store === null || key === null || !active) return;
    return store.pin(key);
  }, [store, key, active]);
}

/** The pinned keys of `store`, re-rendering when the set changes. */
export function usePinnedRowKeys(
  store: VirtualRowPinStore,
): ReadonlySet<string> {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/**
 * The indexes to render: the window's, plus every pinned row the list still
 * holds, ascending and without repeats - the list renders them in this order,
 * which keeps DOM order equal to row order.
 */
export function withPinnedIndexes(
  rangeIndexes: readonly number[],
  pinnedKeys: ReadonlySet<string>,
  indexByKey: ReadonlyMap<string, number>,
): number[] {
  if (pinnedKeys.size === 0) return [...rangeIndexes];
  const indexes = new Set(rangeIndexes);
  for (const key of pinnedKeys) {
    const index = indexByKey.get(key);
    if (index !== undefined) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}
