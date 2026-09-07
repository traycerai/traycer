import { create } from "zustand";
import type {
  TileMinimapAdapter,
  TileMinimapTargetRecord,
  TileMinimapTargetRegistration,
} from "@/stores/tile-minimap/types";

export interface TileMinimapState {
  readonly targetsByTileInstanceId: Readonly<
    Record<string, TileMinimapTargetRecord | undefined>
  >;
  readonly nextRegistrationId: number;
  readonly registerTarget: (
    registration: TileMinimapTargetRegistration,
  ) => () => void;
  readonly unregisterTarget: (
    tileInstanceId: string,
    registeredAt: number,
  ) => void;
}

export const useTileMinimapStore = create<TileMinimapState>((set, get) => ({
  targetsByTileInstanceId: {},
  nextRegistrationId: 1,
  registerTarget: (registration) => {
    const registeredAt = get().nextRegistrationId;
    set((state) => ({
      nextRegistrationId: registeredAt + 1,
      targetsByTileInstanceId: {
        ...state.targetsByTileInstanceId,
        [registration.tileInstanceId]: { ...registration, registeredAt },
      },
    }));
    return () => {
      get().unregisterTarget(registration.tileInstanceId, registeredAt);
    };
  },
  unregisterTarget: (tileInstanceId, registeredAt) => {
    set((state) => {
      const existing = state.targetsByTileInstanceId[tileInstanceId];
      if (existing === undefined || existing.registeredAt !== registeredAt) {
        return state;
      }
      const next = { ...state.targetsByTileInstanceId };
      delete next[tileInstanceId];
      return { targetsByTileInstanceId: next };
    });
  },
}));

/** The adapter for one tile, or `null` when that tile has no navigable content. */
export function selectTileMinimapAdapter(
  tileInstanceId: string,
): (state: TileMinimapState) => TileMinimapAdapter | null {
  return (state) =>
    state.targetsByTileInstanceId[tileInstanceId]?.adapter ?? null;
}
