import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Per-device unread tracking for epic artifacts, persisted to localStorage so a user's read/unread
 * view survives reloads and app restarts.
 */
interface ArtifactReadState {
  readonly seedAtByEpic: Readonly<Record<string, number>>;
  readonly lastSeenByArtifact: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  markRead: (epicId: string, artifactId: string, updatedAt: number) => void;
  seedEpicArtifacts: (
    epicId: string,
    artifacts: ReadonlyArray<{
      readonly id: string;
      readonly updatedAt: number;
    }>,
  ) => void;
}

export const ARTIFACT_READ_STATE_PERSIST_KEY = persistKey(
  STORE_KEYS.artifactReadState,
);

export const useArtifactReadStateStore = create<ArtifactReadState>()(
  persist(
    (set) => ({
      seedAtByEpic: {},
      lastSeenByArtifact: {},
      markRead: (epicId, artifactId, updatedAt) => {
        set((state) => {
          const epicEntries = Object.hasOwn(state.lastSeenByArtifact, epicId)
            ? state.lastSeenByArtifact[epicId]
            : null;
          if (
            epicEntries !== null &&
            Object.hasOwn(epicEntries, artifactId) &&
            epicEntries[artifactId] >= updatedAt
          ) {
            return state;
          }
          return {
            lastSeenByArtifact: {
              ...state.lastSeenByArtifact,
              [epicId]: {
                ...(epicEntries ?? {}),
                [artifactId]: updatedAt,
              },
            },
          };
        });
      },
      seedEpicArtifacts: (epicId, artifacts) => {
        set((state) => {
          if (Object.hasOwn(state.seedAtByEpic, epicId)) return state;
          const epicEntries = Object.hasOwn(state.lastSeenByArtifact, epicId)
            ? state.lastSeenByArtifact[epicId]
            : {};
          const seededEntries = artifacts.reduce<Record<string, number>>(
            (entries, artifact) => {
              entries[artifact.id] =
                Object.hasOwn(entries, artifact.id) &&
                entries[artifact.id] >= artifact.updatedAt
                  ? entries[artifact.id]
                  : artifact.updatedAt;
              return entries;
            },
            { ...epicEntries },
          );
          return {
            seedAtByEpic: { ...state.seedAtByEpic, [epicId]: Date.now() },
            lastSeenByArtifact: {
              ...state.lastSeenByArtifact,
              [epicId]: seededEntries,
            },
          };
        });
      },
    }),
    {
      ...basePersistOptions(ARTIFACT_READ_STATE_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      // Persist only the data maps; actions come from the initializer on rehydrate.
      partialize: (state) => ({
        seedAtByEpic: state.seedAtByEpic,
        lastSeenByArtifact: state.lastSeenByArtifact,
      }),
    },
  ),
);

/**
 * Pure unread predicate over the read-state snapshot maps. The single source of the rule, shared
 * by the per-node marker hook and any whole-tree pass.
 */
export function isArtifactUnread(args: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly updatedAt: number;
  readonly seedAtByEpic: Readonly<Record<string, number>>;
  readonly lastSeenByArtifact: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
}): boolean {
  if (!Object.hasOwn(args.seedAtByEpic, args.epicId)) return false;
  const epicEntries = Object.hasOwn(args.lastSeenByArtifact, args.epicId)
    ? args.lastSeenByArtifact[args.epicId]
    : null;
  if (epicEntries === null || !Object.hasOwn(epicEntries, args.artifactId)) {
    return true;
  }
  return epicEntries[args.artifactId] < args.updatedAt;
}
