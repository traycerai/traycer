import { createContext } from "react";
import type { MobileTileSlot } from "./intent";

/** The slot an open lands in, and the task's canvas the slot belongs to. */
export interface MobileTileOpenTarget {
  readonly tabId: string;
  readonly slot: MobileTileSlot;
}

/**
 * Where an open from this subtree lands in the phone shell. A tile's body names
 * the OTHER slot, because what it opens is read beside it; a slot's own list
 * names that slot, because the person is choosing what it shows. `null` outside
 * the two tiles (a column, a palette, the desktop), where the open takes the
 * current tile.
 *
 * Intents carry no such thing: an intent's `source` is an analytics label.
 * Component-free module per the repo's `*-context.ts` convention.
 */
export const MobileTileOpenTargetContext =
  createContext<MobileTileOpenTarget | null>(null);
