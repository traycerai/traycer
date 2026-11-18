import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import { installCrossWindowRehydrate } from "@/lib/persist/cross-window-rehydrate";

/**
 * The tasks whose mirror line each person has seen ("once per task"), keyed by
 * viewer and epic, valued by when it was seen. Machine-local, like the feature
 * announcements: one more showing on another device is the cost of not syncing
 * a hint. Capped, oldest out, so a person who works in many tasks does not grow
 * it without bound.
 */
export const COMPOSER_MIRROR_LINE_SEEN_CAP = 500;

const COMPOSER_MIRROR_LINE_SEEN_PERSIST_KEY = persistKey(
  STORE_KEYS.composerMirrorLineSeen,
);

type SeenRecord = Readonly<Record<string, number>>;

interface ComposerMirrorLineSeenState {
  readonly seen: SeenRecord;
  /** Record that this person has seen the line in this task. Idempotent. */
  readonly markSeen: (viewerUserId: string, epicId: string) => void;
}

function seenKey(viewerUserId: string, epicId: string): string {
  return `${viewerUserId}\u0000${epicId}`;
}

export function composerMirrorLineSeen(
  seen: SeenRecord,
  viewerUserId: string,
  epicId: string,
): boolean {
  return Object.hasOwn(seen, seenKey(viewerUserId, epicId));
}

function markInto(seen: SeenRecord, key: string, at: number): SeenRecord {
  if (Object.hasOwn(seen, key)) return seen;
  const entries = Object.entries(seen);
  const kept =
    entries.length < COMPOSER_MIRROR_LINE_SEEN_CAP
      ? entries
      : entries
          .toSorted((a, b) => a[1] - b[1])
          .slice(entries.length - COMPOSER_MIRROR_LINE_SEEN_CAP + 1);
  return { ...Object.fromEntries(kept), [key]: at };
}

/** Only finite timestamps survive: a corrupt entry reads as unseen. */
function persistedSeen(persistedState: unknown): SeenRecord {
  if (typeof persistedState !== "object" || persistedState === null) return {};
  if (!("seen" in persistedState)) return {};
  const seen = persistedState.seen;
  if (typeof seen !== "object" || seen === null) return {};
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(seen)) {
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    next[key] = at;
  }
  return next;
}

export const useComposerMirrorLineSeenStore =
  create<ComposerMirrorLineSeenState>()(
    persist(
      (set, get) => ({
        seen: {},
        markSeen: (viewerUserId, epicId) => {
          // The record is localStorage, shared by every window, and each
          // window's store is its own copy: re-read it first, so this write
          // keeps what another window marked since this one hydrated. A
          // synchronous storage rehydrates inline (the same reasoning as
          // `feature-announcements-store`'s `claim`).
          void useComposerMirrorLineSeenStore.persist.rehydrate();
          const current = get().seen;
          const seen = markInto(
            current,
            seenKey(viewerUserId, epicId),
            Date.now(),
          );
          if (seen !== current) set({ seen });
        },
      }),
      {
        ...basePersistOptions(COMPOSER_MIRROR_LINE_SEEN_PERSIST_KEY),
        storage: createJSONStorage(() => localStorage),
        merge: (persistedState, currentState) => ({
          ...currentState,
          seen: persistedSeen(persistedState),
        }),
        partialize: (state) => ({ seen: state.seen }),
      },
    ),
  );

// Another window marked a task seen: follow it, so this window stops showing
// a line the person already dismissed there.
installCrossWindowRehydrate(
  useComposerMirrorLineSeenStore,
  COMPOSER_MIRROR_LINE_SEEN_PERSIST_KEY,
);
