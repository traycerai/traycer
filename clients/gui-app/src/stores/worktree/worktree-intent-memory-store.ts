import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  worktreeFolderIntentSchema,
  worktreeIntentSchema,
  type WorktreeFolderIntent,
  type WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { cappedByUpdatedAt } from "@/lib/bounded-record";
import { basePersistOptions, worktreeIntentMemoryKey } from "@/lib/persist";
import {
  worktreeFolderIntentReferencesRemoved,
  type RemovedWorktreeRefs,
} from "@/lib/worktree/removed-worktree-refs";

/**
 * Remembered worktree defaults, persisted to localStorage, bucketed by the signed-in user's email
 * and then by HOST - the memory model used by `composer-run-settings-store`.
 */
export const WORKTREE_INTENT_MEMORY_EPIC_CAP = 200;
export const WORKTREE_INTENT_MEMORY_FOLDER_CAP = 200;

export interface WorktreeEpicIntentEntry {
  readonly intent: WorktreeIntent;
  readonly updatedAt: number;
}

export interface WorktreeFolderIntentEntry {
  readonly intent: WorktreeFolderIntent;
  readonly updatedAt: number;
}

/** One host's remembered defaults. Both tiers are capped within the bucket. */
export interface WorktreeIntentMemoryHostBucket {
  readonly folderIntentByPath: Readonly<
    Record<string, WorktreeFolderIntentEntry>
  >;
  readonly epicIntentByEpicId: Readonly<
    Record<string, WorktreeEpicIntentEntry>
  >;
}

export const EMPTY_WORKTREE_INTENT_MEMORY_BUCKET: WorktreeIntentMemoryHostBucket =
  { folderIntentByPath: {}, epicIntentByEpicId: {} };

interface WorktreeIntentMemoryStore {
  byHost: Readonly<Record<string, WorktreeIntentMemoryHostBucket>>;
  // Frozen pre-host-scoping (v1) data, kept so the common single-host install keeps its remembered
  // defaults across the migration - a migration cannot know which host the flat data belonged to.
  legacyFolderIntentByPath: Readonly<Record<string, WorktreeFolderIntentEntry>>;
  legacyEpicIntentByEpicId: Readonly<Record<string, WorktreeEpicIntentEntry>>;
  // WRITE - `hostId === null` (no resolved target host) drops the write: a remembered default that
  // cannot be attributed to a host must not leak onto another one.
  setFolderIntent: (
    hostId: string | null,
    intent: WorktreeFolderIntent,
    updatedAt: number,
  ) => void;
  getFolderIntent: (
    hostId: string | null,
    workspacePath: string,
  ) => WorktreeFolderIntent | null;
  setEpicIntent: (
    epicId: string,
    hostId: string | null,
    intent: WorktreeIntent,
    updatedAt: number,
  ) => void;
  getEpicIntent: (
    epicId: string,
    hostId: string | null,
  ) => WorktreeIntent | null;
  /** Clears an epic across EVERY host's bucket and the legacy fallback. */
  clearEpicIntent: (epicIds: ReadonlyArray<string>) => void;
  purgeRemovedWorktreeIntents: (
    hostId: string,
    removed: RemovedWorktreeRefs,
  ) => void;
  resetForTests: () => void;
}

/** The one read seam: a host's bucket, or the shared empty bucket for a
 *  missing/null host (stable identity, so selectors don't churn). */
export function selectWorktreeIntentMemoryBucket(
  state: Pick<WorktreeIntentMemoryStore, "byHost">,
  hostId: string | null,
): WorktreeIntentMemoryHostBucket {
  if (hostId === null || !Object.hasOwn(state.byHost, hostId)) {
    return EMPTY_WORKTREE_INTENT_MEMORY_BUCKET;
  }
  return state.byHost[hostId];
}

/**
 * Reactive selector for one folder's remembered choice on `hostId`, with the
 * per-key legacy fallback (see `getFolderIntent` for the imperative twin).
 */
export function selectRememberedFolderIntent(
  state: Pick<WorktreeIntentMemoryStore, "byHost" | "legacyFolderIntentByPath">,
  hostId: string | null,
  workspacePath: string,
): WorktreeFolderIntent | null {
  const bucket = selectWorktreeIntentMemoryBucket(state, hostId);
  if (Object.hasOwn(bucket.folderIntentByPath, workspacePath)) {
    return bucket.folderIntentByPath[workspacePath].intent;
  }
  return Object.hasOwn(state.legacyFolderIntentByPath, workspacePath)
    ? state.legacyFolderIntentByPath[workspacePath].intent
    : null;
}

/** Reactive selector for one epic's remembered intent on `hostId`, with the
 *  same per-key legacy fallback as `selectRememberedFolderIntent`. */
export function selectRememberedEpicIntent(
  state: Pick<WorktreeIntentMemoryStore, "byHost" | "legacyEpicIntentByEpicId">,
  hostId: string | null,
  epicId: string,
): WorktreeIntent | null {
  const bucket = selectWorktreeIntentMemoryBucket(state, hostId);
  if (Object.hasOwn(bucket.epicIntentByEpicId, epicId)) {
    return bucket.epicIntentByEpicId[epicId].intent;
  }
  return Object.hasOwn(state.legacyEpicIntentByEpicId, epicId)
    ? state.legacyEpicIntentByEpicId[epicId].intent
    : null;
}

export const useWorktreeIntentMemoryStore = create<WorktreeIntentMemoryStore>()(
  persist(
    (set, get) => ({
      byHost: {},
      legacyFolderIntentByPath: {},
      legacyEpicIntentByEpicId: {},
      setFolderIntent: (hostId, intent, updatedAt) => {
        if (hostId === null) return;
        // Always write - no value dedup. `updatedAt` is the recency key the cap
        // sorts on, so re-selecting the same choice must still refresh it.
        set((state) => {
          const adopted = adoptLegacyInto(state, hostId);
          return {
            ...adopted.clearedLegacy,
            byHost: {
              ...state.byHost,
              [hostId]: {
                ...adopted.bucket,
                folderIntentByPath: cappedByUpdatedAt(
                  {
                    ...adopted.bucket.folderIntentByPath,
                    [intent.workspacePath]: {
                      intent: folderIntentForMemory(intent),
                      updatedAt,
                    },
                  },
                  WORKTREE_INTENT_MEMORY_FOLDER_CAP,
                ),
              },
            },
          };
        });
      },
      getFolderIntent: (hostId, workspacePath) =>
        selectRememberedFolderIntent(get(), hostId, workspacePath),
      setEpicIntent: (epicId, hostId, intent, updatedAt) => {
        if (hostId === null) return;
        // Always write - no value dedup.
        set((state) => {
          const adopted = adoptLegacyInto(state, hostId);
          return {
            ...adopted.clearedLegacy,
            byHost: {
              ...state.byHost,
              [hostId]: {
                ...adopted.bucket,
                epicIntentByEpicId: cappedByUpdatedAt(
                  {
                    ...adopted.bucket.epicIntentByEpicId,
                    [epicId]: { intent: copyWorktreeIntent(intent), updatedAt },
                  },
                  WORKTREE_INTENT_MEMORY_EPIC_CAP,
                ),
              },
            },
          };
        });
      },
      getEpicIntent: (epicId, hostId) =>
        selectRememberedEpicIntent(get(), hostId, epicId),
      clearEpicIntent: (epicIds) => {
        if (epicIds.length === 0) return;
        const dropped = new Set(epicIds);
        set((state) => {
          let changed = false;
          const byHost: Record<string, WorktreeIntentMemoryHostBucket> = {};
          for (const [hostId, bucket] of Object.entries(state.byHost)) {
            const epicIntentByEpicId = omitKeys(
              bucket.epicIntentByEpicId,
              dropped,
            );
            if (epicIntentByEpicId === bucket.epicIntentByEpicId) {
              byHost[hostId] = bucket;
              continue;
            }
            changed = true;
            byHost[hostId] = { ...bucket, epicIntentByEpicId };
          }
          const legacyEpicIntentByEpicId = omitKeys(
            state.legacyEpicIntentByEpicId,
            dropped,
          );
          if (legacyEpicIntentByEpicId !== state.legacyEpicIntentByEpicId) {
            changed = true;
          }
          return changed ? { byHost, legacyEpicIntentByEpicId } : state;
        });
      },
      purgeRemovedWorktreeIntents: (hostId, removed) => {
        set((state) => {
          // A completed sweep is proof this host is live on this client, so it adopts the unattributed tier
          // the same way a write does - and the purge then has a single, host-scoped tier to filter.
          const adopted = adoptLegacyInto(state, hostId);
          const nextBucket = purgeBucket(adopted.bucket, removed);
          if (
            nextBucket === adopted.bucket &&
            adopted.bucket === selectWorktreeIntentMemoryBucket(state, hostId)
          ) {
            return state;
          }
          return {
            ...adopted.clearedLegacy,
            // An unchanged, still-empty bucket is never written back: an
            // unknown host must not gain an empty bucket just by being swept.
            byHost:
              nextBucket === EMPTY_WORKTREE_INTENT_MEMORY_BUCKET
                ? state.byHost
                : { ...state.byHost, [hostId]: nextBucket },
          };
        });
      },
      resetForTests: () => {
        set({
          byHost: {},
          legacyFolderIntentByPath: {},
          legacyEpicIntentByEpicId: {},
        });
      },
    }),
    {
      ...basePersistOptions(worktreeIntentMemoryKey(null)),
      version: 2,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        byHost: state.byHost,
        legacyFolderIntentByPath: state.legacyFolderIntentByPath,
        legacyEpicIntentByEpicId: state.legacyEpicIntentByEpicId,
      }),
      migrate: (persisted) =>
        migrateWorktreeIntentMemoryPersistedState(persisted),
      // Defensive re-derivation on every rehydration (mirrors `workspace-folders-store.ts`): every
      // bucket, and every entry in it, is validated from raw JSON and re-capped regardless of shape.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        return {
          ...currentState,
          byHost: parsePersistedByHost(persisted.byHost),
          legacyFolderIntentByPath: cappedByUpdatedAt(
            parseFolderIntentEntries(persisted.legacyFolderIntentByPath),
            WORKTREE_INTENT_MEMORY_FOLDER_CAP,
          ),
          legacyEpicIntentByEpicId: cappedByUpdatedAt(
            parseEpicIntentEntries(persisted.legacyEpicIntentByEpicId),
            WORKTREE_INTENT_MEMORY_EPIC_CAP,
          ),
        };
      },
    },
  ),
);

interface WorktreeIntentMemoryPersistedState {
  readonly byHost: Readonly<Record<string, WorktreeIntentMemoryHostBucket>>;
  readonly legacyFolderIntentByPath: Readonly<
    Record<string, WorktreeFolderIntentEntry>
  >;
  readonly legacyEpicIntentByEpicId: Readonly<
    Record<string, WorktreeEpicIntentEntry>
  >;
}

/** v1 -> v2 migration. */
export function migrateWorktreeIntentMemoryPersistedState(
  persisted: unknown,
): WorktreeIntentMemoryPersistedState {
  if (!isRecord(persisted)) {
    return {
      byHost: {},
      legacyFolderIntentByPath: {},
      legacyEpicIntentByEpicId: {},
    };
  }
  return {
    byHost: {},
    legacyFolderIntentByPath: cappedByUpdatedAt(
      parseFolderIntentEntries(persisted.folderIntentByPath),
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    ),
    legacyEpicIntentByEpicId: cappedByUpdatedAt(
      parseEpicIntentEntries(persisted.epicIntentByEpicId),
      WORKTREE_INTENT_MEMORY_EPIC_CAP,
    ),
  };
}

function parsePersistedByHost(
  value: unknown,
): Readonly<Record<string, WorktreeIntentMemoryHostBucket>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([hostId, rawBucket]) => {
      if (!isRecord(rawBucket)) return [];
      const folderIntentByPath = cappedByUpdatedAt(
        parseFolderIntentEntries(rawBucket.folderIntentByPath),
        WORKTREE_INTENT_MEMORY_FOLDER_CAP,
      );
      const epicIntentByEpicId = cappedByUpdatedAt(
        parseEpicIntentEntries(rawBucket.epicIntentByEpicId),
        WORKTREE_INTENT_MEMORY_EPIC_CAP,
      );
      if (
        Object.keys(folderIntentByPath).length === 0 &&
        Object.keys(epicIntentByEpicId).length === 0
      ) {
        return [];
      }
      return [[hostId, { folderIntentByPath, epicIntentByEpicId }]];
    }),
  );
}

function parseFolderIntentEntries(
  value: unknown,
): Record<string, WorktreeFolderIntentEntry> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([workspacePath, raw]) => {
      if (!isRecord(raw)) return [];
      const updatedAt = parseUpdatedAt(raw.updatedAt);
      if (updatedAt === null) return [];
      const parsed = worktreeFolderIntentSchema.safeParse(raw.intent);
      // The key is the lookup path and the intent carries its own - a row where they disagree would seed
      // one folder from another folder's choice, so drop it rather than trust either side.
      if (!parsed.success || parsed.data.workspacePath !== workspacePath) {
        return [];
      }
      return [[workspacePath, { intent: parsed.data, updatedAt }]];
    }),
  );
}

function parseEpicIntentEntries(
  value: unknown,
): Record<string, WorktreeEpicIntentEntry> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([epicId, raw]) => {
      if (!isRecord(raw)) return [];
      const updatedAt = parseUpdatedAt(raw.updatedAt);
      if (updatedAt === null) return [];
      const parsed = worktreeIntentSchema.safeParse(raw.intent);
      // An entry-less intent remembers nothing, and the purge already deletes
      // an epic once its last entry goes - so it never round-trips as state.
      if (!parsed.success || parsed.data.entries.length === 0) return [];
      return [[epicId, { intent: parsed.data, updatedAt }]];
    }),
  );
}

function parseUpdatedAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Referentially stable when nothing is dropped, so every caller can compare
// identity to decide whether the surrounding state changed at all.
function omitKeys<T>(
  entries: Readonly<Record<string, T>>,
  dropped: ReadonlySet<string>,
): Readonly<Record<string, T>> {
  const kept = Object.entries(entries).filter(([key]) => !dropped.has(key));
  return kept.length === Object.keys(entries).length
    ? entries
    : Object.fromEntries(kept);
}

interface AdoptedLegacy {
  /** `hostId`'s bucket with any adopted entries folded in. */
  readonly bucket: WorktreeIntentMemoryHostBucket;
  /** Spread into the `set` result; empty object when nothing was adopted. */
  readonly clearedLegacy: {
    readonly legacyFolderIntentByPath?: Readonly<
      Record<string, WorktreeFolderIntentEntry>
    >;
    readonly legacyEpicIntentByEpicId?: Readonly<
      Record<string, WorktreeEpicIntentEntry>
    >;
  };
}

/**
 * The first host to ACT after the migration adopts the frozen v1 memory into its own bucket, and
 * the fallback is retired.
 */
function adoptLegacyInto(
  state: Pick<
    WorktreeIntentMemoryStore,
    "byHost" | "legacyFolderIntentByPath" | "legacyEpicIntentByEpicId"
  >,
  hostId: string,
): AdoptedLegacy {
  const bucket = selectWorktreeIntentMemoryBucket(state, hostId);
  const legacyFolders = state.legacyFolderIntentByPath;
  const legacyEpics = state.legacyEpicIntentByEpicId;
  if (
    Object.keys(legacyFolders).length === 0 &&
    Object.keys(legacyEpics).length === 0
  ) {
    return { bucket, clearedLegacy: {} };
  }
  return {
    bucket: {
      folderIntentByPath: cappedByUpdatedAt(
        { ...legacyFolders, ...bucket.folderIntentByPath },
        WORKTREE_INTENT_MEMORY_FOLDER_CAP,
      ),
      epicIntentByEpicId: cappedByUpdatedAt(
        { ...legacyEpics, ...bucket.epicIntentByEpicId },
        WORKTREE_INTENT_MEMORY_EPIC_CAP,
      ),
    },
    clearedLegacy: {
      legacyFolderIntentByPath: {},
      legacyEpicIntentByEpicId: {},
    },
  };
}

function purgeFolderIntents(
  entries: Readonly<Record<string, WorktreeFolderIntentEntry>>,
  removed: RemovedWorktreeRefs,
): Readonly<Record<string, WorktreeFolderIntentEntry>> {
  const kept = Object.entries(entries).filter(
    ([, entry]) =>
      !worktreeFolderIntentReferencesRemoved(entry.intent, removed),
  );
  return kept.length === Object.keys(entries).length
    ? entries
    : Object.fromEntries(kept);
}

function purgeEpicIntents(
  entries: Readonly<Record<string, WorktreeEpicIntentEntry>>,
  removed: RemovedWorktreeRefs,
): Readonly<Record<string, WorktreeEpicIntentEntry>> {
  let changed = false;
  const next: Record<string, WorktreeEpicIntentEntry> = {};
  for (const [epicId, entry] of Object.entries(entries)) {
    const surviving = entry.intent.entries.filter(
      (folder) => !worktreeFolderIntentReferencesRemoved(folder, removed),
    );
    if (surviving.length === entry.intent.entries.length) {
      next[epicId] = entry;
      continue;
    }
    changed = true;
    if (surviving.length === 0) continue;
    next[epicId] = {
      intent: { entries: surviving },
      updatedAt: entry.updatedAt,
    };
  }
  return changed ? next : entries;
}

function purgeBucket(
  bucket: WorktreeIntentMemoryHostBucket,
  removed: RemovedWorktreeRefs,
): WorktreeIntentMemoryHostBucket {
  const folderIntentByPath = purgeFolderIntents(
    bucket.folderIntentByPath,
    removed,
  );
  const epicIntentByEpicId = purgeEpicIntents(
    bucket.epicIntentByEpicId,
    removed,
  );
  if (
    folderIntentByPath === bucket.folderIntentByPath &&
    epicIntentByEpicId === bucket.epicIntentByEpicId
  ) {
    return bucket;
  }
  return { folderIntentByPath, epicIntentByEpicId };
}

// Scripts are an Environment concern (the setup/teardown dialog + per-repo `environment.json`),
// not part of a remembered worktree default - strip them so re-seeding a folder never silently
function folderIntentForMemory(
  intent: WorktreeFolderIntent,
): WorktreeFolderIntent {
  if (intent.kind === "worktree") {
    return { ...intent, scripts: null };
  }
  return { ...intent };
}

// Per-epic memory strips the worktree `scripts` override per entry for the same reason
// `setFolderIntent` does (see `folderIntentForMemory`): a remembered default must never silently
function copyWorktreeIntent(intent: WorktreeIntent): WorktreeIntent {
  return {
    entries: intent.entries.map((entry) => folderIntentForMemory(entry)),
  };
}
