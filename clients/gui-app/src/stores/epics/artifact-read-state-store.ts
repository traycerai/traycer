import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

/**
 * Per-device unread tracking for epic artifacts, persisted to localStorage so a
 * user's read/unread view survives reloads and app restarts. Collaborators and
 * other devices each keep their own view of what's "new".
 *
 * Two cooperating maps:
 *   - `seedAtByEpic[epicId]`: a per-epic baseline MARKER. Its presence means
 *     "this device has captured this epic's baseline"; the timestamp value is
 *     informational only and is never compared against artifact versions. Until
 *     an epic is seeded, every artifact reads as read - this suppresses the
 *     "sea of blue dots" on the very first navigation to an epic.
 *   - `lastSeenByArtifact[epicId][artifactId]`: the latest `updatedAt` the user
 *     has acknowledged - seeded at baseline for every artifact present on first
 *     open, then advanced by `markRead`. Newer remote edits re-mark the artifact
 *     unread until viewed again.
 *
 * Reliability contract:
 *   - An artifact present at first open is seeded with its concrete version, so
 *     it stays read across restarts and is immune to clock skew between the
 *     host/cloud and this renderer.
 *   - An artifact that appears AFTER the baseline has no `lastSeen` entry, so it
 *     reads as unread without any wall-clock comparison - this is what makes a
 *     newly created artifact reliably show its marker.
 *
 * `markRead` writes the supplied `updatedAt` (not `Date.now()`), so repeated
 * calls with the same artifact version are exact no-ops at the selector
 * boundary - no spurious store mutations during a steady-state view.
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
 * Pure unread predicate over the read-state snapshot maps. The single source of
 * the rule, shared by the per-node marker hook and any whole-tree pass.
 *
 * An epic with no baseline marker yet reads as fully read (suppress markers
 * until the session seed lands). Once seeded, an artifact is unread iff we have
 * never acknowledged a version at least as new as `updatedAt` - which includes
 * artifacts created after the baseline (no `lastSeen` entry at all). The rule
 * never compares wall clocks, so host/renderer clock skew cannot hide a new
 * artifact's marker.
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
