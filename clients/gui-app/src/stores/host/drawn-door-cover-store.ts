import { useLayoutEffect } from "react";
import { create } from "zustand";

/**
 * The host whose door cover this window has on screen now, or `null`.
 *
 * Written only by the narrator, and only while it is drawing that cover: a
 * blocking state can be stored for a host no cover is drawn for (another
 * computer than the one serving this window, or one already serving it), and
 * the narrator can stand aside for another card. The toast reads this, so a
 * refusal it keeps quiet about is always one the person can see.
 */
const useDrawnDoorCoverStore = create<{ readonly hostId: string | null }>(
  () => ({ hostId: null }),
);

export function drawnDoorCoverHost(): string | null {
  return useDrawnDoorCoverStore.getState().hostId;
}

/** Marks `hostId`'s door cover drawn for as long as the caller stays mounted with it. */
export function useMarkDrawnDoorCover(hostId: string | null): void {
  useLayoutEffect(() => {
    if (hostId === null) return undefined;
    useDrawnDoorCoverStore.setState({ hostId });
    return () => {
      if (useDrawnDoorCoverStore.getState().hostId === hostId)
        useDrawnDoorCoverStore.setState({ hostId: null });
    };
  }, [hostId]);
}
