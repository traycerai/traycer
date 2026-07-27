import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
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
 * Remembered worktree defaults, persisted to localStorage and bucketed by the
 * signed-in user's email - the memory model used by `composer-run-settings-store`.
 * Two tiers, both client-local and never the cloud-synced Chat Y.Doc (intent
 * carries local paths, and the host binding (SQLite) owns an existing chat):
 *
 *  - `folderIntentByPath` - the per-folder last choice, keyed by `workspacePath`
 *    and written the moment a selection is made (so a mid-setup reload before
 *    send restores it). Seeds a freshly-added folder when neither the live
 *    binding nor per-epic memory covers it; if the remembered choice no longer
 *    matches disk (branch / worktree gone), the seeder falls back to a new
 *    worktree off the working tree. LRU-capped by `updatedAt`.
 *  - `epicIntentByEpicId` - per-epic full intent, so reopening an epic restores
 *    the exact branches the user last chose. LRU-capped by `updatedAt`.
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

interface WorktreeIntentMemoryStore {
  folderIntentByPath: Record<string, WorktreeFolderIntentEntry>;
  epicIntentByEpicId: Record<string, WorktreeEpicIntentEntry>;
  setFolderIntent: (intent: WorktreeFolderIntent, updatedAt: number) => void;
  getFolderIntent: (workspacePath: string) => WorktreeFolderIntent | null;
  setEpicIntent: (
    epicId: string,
    intent: WorktreeIntent,
    updatedAt: number,
  ) => void;
  getEpicIntent: (epicId: string) => WorktreeIntent | null;
  clearEpicIntent: (epicIds: ReadonlyArray<string>) => void;
  /**
   * Drops remembered intents that reference just-removed worktrees (deleted
   * branch checkout / fork source, or an import of a removed directory), so a
   * remembered default can never re-offer a selection that no longer
   * materializes. Per-folder entries are dropped whole; per-epic intents keep
   * their still-valid entries and are dropped only once empty.
   */
  purgeRemovedWorktreeIntents: (removed: RemovedWorktreeRefs) => void;
  resetForTests: () => void;
}

export const useWorktreeIntentMemoryStore = create<WorktreeIntentMemoryStore>()(
  persist(
    (set, get) => ({
      folderIntentByPath: {},
      epicIntentByEpicId: {},
      setFolderIntent: (intent, updatedAt) => {
        // Always write - no value dedup. `updatedAt` is the recency key the cap
        // sorts on, so re-selecting the same choice must still refresh it.
        set((state) => ({
          folderIntentByPath: cappedByUpdatedAt(
            {
              ...state.folderIntentByPath,
              [intent.workspacePath]: {
                intent: folderIntentForMemory(intent),
                updatedAt,
              },
            },
            WORKTREE_INTENT_MEMORY_FOLDER_CAP,
          ),
        }));
      },
      getFolderIntent: (workspacePath) => {
        const entries = get().folderIntentByPath;
        return Object.hasOwn(entries, workspacePath)
          ? entries[workspacePath].intent
          : null;
      },
      setEpicIntent: (epicId, intent, updatedAt) => {
        // Always write - no value dedup. `updatedAt` is the recency key the cap
        // sorts on, so even re-selecting the same intent must refresh it; a
        // just-touched epic must not be evicted as "least recently used".
        set((state) => ({
          epicIntentByEpicId: cappedByUpdatedAt(
            {
              ...state.epicIntentByEpicId,
              [epicId]: { intent: copyWorktreeIntent(intent), updatedAt },
            },
            WORKTREE_INTENT_MEMORY_EPIC_CAP,
          ),
        }));
      },
      getEpicIntent: (epicId) => {
        const entries = get().epicIntentByEpicId;
        return Object.hasOwn(entries, epicId) ? entries[epicId].intent : null;
      },
      clearEpicIntent: (epicIds) => {
        if (epicIds.length === 0) return;
        set((state) => {
          let changed = false;
          const next = { ...state.epicIntentByEpicId };
          for (const epicId of epicIds) {
            if (!Object.hasOwn(next, epicId)) continue;
            delete next[epicId];
            changed = true;
          }
          return changed ? { epicIntentByEpicId: next } : state;
        });
      },
      purgeRemovedWorktreeIntents: (removed) => {
        set((state) => {
          let changed = false;
          const folderIntentByPath = { ...state.folderIntentByPath };
          for (const [path, entry] of Object.entries(folderIntentByPath)) {
            if (!worktreeFolderIntentReferencesRemoved(entry.intent, removed)) {
              continue;
            }
            delete folderIntentByPath[path];
            changed = true;
          }
          const epicIntentByEpicId = { ...state.epicIntentByEpicId };
          for (const [epicId, entry] of Object.entries(epicIntentByEpicId)) {
            const entries = entry.intent.entries.filter(
              (folder) =>
                !worktreeFolderIntentReferencesRemoved(folder, removed),
            );
            if (entries.length === entry.intent.entries.length) continue;
            changed = true;
            if (entries.length === 0) {
              delete epicIntentByEpicId[epicId];
            } else {
              epicIntentByEpicId[epicId] = {
                intent: { entries },
                updatedAt: entry.updatedAt,
              };
            }
          }
          return changed ? { folderIntentByPath, epicIntentByEpicId } : state;
        });
      },
      resetForTests: () => {
        set({ folderIntentByPath: {}, epicIntentByEpicId: {} });
      },
    }),
    {
      ...basePersistOptions(worktreeIntentMemoryKey(null)),
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({
        folderIntentByPath: state.folderIntentByPath,
        epicIntentByEpicId: state.epicIntentByEpicId,
      }),
    },
  ),
);

// Scripts are an Environment concern (the setup/teardown dialog + per-repo
// `environment.json`), not part of a remembered worktree default - strip them so
// re-seeding a folder never silently re-applies a stale override.
function folderIntentForMemory(
  intent: WorktreeFolderIntent,
): WorktreeFolderIntent {
  if (intent.kind === "worktree") {
    return { ...intent, scripts: null };
  }
  return { ...intent };
}

// Per-epic memory strips the worktree `scripts` override per entry for the same
// reason `setFolderIntent` does (see `folderIntentForMemory`): a remembered
// default must never silently re-apply a stale setup/teardown override when the
// epic is reopened and a new worktree is created.
function copyWorktreeIntent(intent: WorktreeIntent): WorktreeIntent {
  return {
    entries: intent.entries.map((entry) => folderIntentForMemory(entry)),
  };
}
