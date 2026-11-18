import { useLayoutEffect } from "react";
import { create } from "zustand";

// Written only by a drawn cover, so a refusal the toast keeps quiet about is always
// one the person can see. Counted: several tiles can show one computer.
const useDrawnDoorCoverStore = create<{
  readonly drawn: ReadonlyMap<string, number>;
}>(() => ({ drawn: new Map() }));

export function isDoorCoverDrawn(hostId: string): boolean {
  return useDrawnDoorCoverStore.getState().drawn.has(hostId);
}

export function useIsDoorCoverDrawn(hostId: string | null): boolean {
  return useDrawnDoorCoverStore((state) =>
    hostId === null ? false : state.drawn.has(hostId),
  );
}

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
