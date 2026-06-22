import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export const LOCAL_SNAPSHOT_CLEAR_PERSIST_KEY = persistKey(
  STORE_KEYS.localSnapshotClear,
);

interface LocalSnapshotClearState {
  readonly clearedAtByScope: Readonly<Record<string, number>>;
  markCleared: (userId: string, hostId: string, clearedAt: number) => void;
}

type PersistedLocalSnapshotClearState = Pick<
  LocalSnapshotClearState,
  "clearedAtByScope"
>;

export const useLocalSnapshotClearStore = create<LocalSnapshotClearState>()(
  persist(
    (set) => ({
      clearedAtByScope: {},
      markCleared: (userId, hostId, clearedAt) => {
        set((state) => {
          const key = localSnapshotClearScopeKey(userId, hostId);
          if ((state.clearedAtByScope[key] ?? null) === clearedAt) {
            return state;
          }
          return {
            clearedAtByScope: {
              ...state.clearedAtByScope,
              [key]: clearedAt,
            },
          };
        });
      },
    }),
    {
      ...basePersistOptions(LOCAL_SNAPSHOT_CLEAR_PERSIST_KEY),
      partialize: (state): PersistedLocalSnapshotClearState => ({
        clearedAtByScope: state.clearedAtByScope,
      }),
    },
  ),
);

export function localSnapshotClearScopeKey(
  userId: string,
  hostId: string,
): string {
  return `${userId}::${hostId}`;
}

export function localSnapshotsClearedAt(
  clearedAtByScope: Readonly<Record<string, number>>,
  userId: string | null,
  hostId: string | null,
): number | null {
  if (userId === null || hostId === null) return null;
  return clearedAtByScope[localSnapshotClearScopeKey(userId, hostId)] ?? null;
}
