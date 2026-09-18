import { create } from "zustand";
import { cappedByUpdatedAt } from "@/lib/bounded-record";

/**
 * Which `@` mention rows the user picked from the menu, and when. Feeds the
 * root search's recency nudge (`root-search-ranking.ts`): a row picked
 * recently gets a mild score edge over a stranger of equal match quality.
 *
 * Session-scoped and HOST-bucketed. Rows are keyed by their menu id, and for
 * files and folders that id is a bare local path (`file:<root>:<relPath>`)
 * that names a different file on another machine - the same reason every
 * persisted "last used" store nests under `byHost`. A pick with no resolved
 * host is dropped rather than attributed to a shared bucket. Files and
 * folders carry no clock of their own on the wire, which is why this memory
 * exists at all; agent and artifact rows keep their own `updatedAt` ordering
 * inside their providers and merely gain the same nudge here once picked.
 *
 * "Recent" is bounded by the cap alone: the memory lives for one session and
 * keeps a host's last `MENTION_PICK_MEMORY_CAP` picks, so no clock is
 * consulted at ranking time - the menu must not re-rank on a timer while it
 * is open. `updatedAt` orders picks among themselves (and the eviction).
 */
export const MENTION_PICK_MEMORY_CAP = 200;

export interface MentionPickEntry {
  readonly updatedAt: number;
}

export type MentionPickHostBucket = Readonly<Record<string, MentionPickEntry>>;

const EMPTY_MENTION_PICK_BUCKET: MentionPickHostBucket = {};

interface MentionPickMemoryStore {
  readonly byHost: Readonly<Record<string, MentionPickHostBucket>>;
  readonly recordPick: (
    hostId: string | null,
    entryId: string,
    pickedAt: number,
  ) => void;
  readonly resetForTests: () => void;
}

/** One host's picks, or the shared empty bucket (stable identity for selectors). */
export function selectMentionPickBucket(
  state: Pick<MentionPickMemoryStore, "byHost">,
  hostId: string | null,
): MentionPickHostBucket {
  if (hostId === null || !Object.hasOwn(state.byHost, hostId)) {
    return EMPTY_MENTION_PICK_BUCKET;
  }
  return state.byHost[hostId];
}

/** The bucket as the ranking reads it: row id → pick time. */
export function recentMentionPicks(
  bucket: MentionPickHostBucket,
): ReadonlyMap<string, number> {
  return new Map(
    Object.entries(bucket).map(([entryId, entry]) => [
      entryId,
      entry.updatedAt,
    ]),
  );
}

export const useMentionPickMemoryStore = create<MentionPickMemoryStore>()(
  (set) => ({
    byHost: {},
    recordPick: (hostId, entryId, pickedAt) => {
      if (hostId === null) return;
      set((state) => ({
        byHost: {
          ...state.byHost,
          [hostId]: cappedByUpdatedAt(
            {
              ...selectMentionPickBucket(state, hostId),
              [entryId]: { updatedAt: pickedAt },
            },
            MENTION_PICK_MEMORY_CAP,
          ),
        },
      }));
    },
    resetForTests: () => {
      set({ byHost: {} });
    },
  }),
);
