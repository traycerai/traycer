import { useLayoutEffect } from "react";
import { create } from "zustand";

/**
 * The hosts whose door cover this window has on screen now, each with how
 * many covers draw it.
 *
 * Written only by a cover while it is drawn: the window's narrator for its
 * own computer, and a tile's cover for another computer. A blocking state can
 * be stored for a host no cover is drawn for (a computer no tile shows, or one
 * already serving), and the narrator can stand aside for another card. The
 * toast reads this, so a refusal it keeps quiet about is always one the person
 * can see. Counted, because several tiles can show the same computer.
 */
const useDrawnDoorCoverStore = create<{
  readonly drawn: ReadonlyMap<string, number>;
}>(() => ({ drawn: new Map() }));

export function isDoorCoverDrawn(hostId: string): boolean {
  return useDrawnDoorCoverStore.getState().drawn.has(hostId);
}

/** Marks `hostId`'s door cover drawn for as long as the caller stays mounted with it. */
export function useMarkDrawnDoorCover(hostId: string | null): void {
  useLayoutEffect(() => {
    if (hostId === null) return undefined;
    countDrawnCover(hostId, 1);
    return () => {
      countDrawnCover(hostId, -1);
    };
  }, [hostId]);
}

function countDrawnCover(hostId: string, delta: 1 | -1): void {
  useDrawnDoorCoverStore.setState(({ drawn }) => {
    const next = new Map(drawn);
    const count = (next.get(hostId) ?? 0) + delta;
    if (count > 0) next.set(hostId, count);
    else next.delete(hostId);
    return { drawn: next };
  });
}
