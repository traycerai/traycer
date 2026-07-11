import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";
import {
  resolvePrimaryPath,
  trimFoldersPreservingPrimary,
} from "@/lib/worktree/resolve-primary-path";

export interface WorkspaceFolderInfo {
  readonly path: string;
  readonly name: string;
  readonly repoIdentifier: TaskRepoIdentifier | null;
}

interface WorkspaceFoldersStore {
  folders: ReadonlyArray<string>;
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
  primaryPath: string | null;
  // Returns the paths EVICTED by the 50-folder cap (empty when nothing was
  // evicted) so callers can unstage any in-flight worktree intent for them -
  // otherwise an evicted folder can disappear from rows/persistence while
  // still riding along in a staged/outgoing WorktreeIntent.
  addResolvedFolders: (
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => ReadonlyArray<string>;
  removeFolder: (folderPath: string) => void;
  setPrimaryFolder: (folderPath: string) => void;
}

const INITIAL_FOLDERS: ReadonlyArray<string> = [];
const INITIAL_FOLDER_INFO_BY_PATH: Readonly<
  Record<string, WorkspaceFolderInfo>
> = {};
const MAX_FOLDERS = 50;

export const useWorkspaceFoldersStore = create<WorkspaceFoldersStore>()(
  persist(
    (set, get) => ({
      folders: INITIAL_FOLDERS,
      folderInfoByPath: INITIAL_FOLDER_INFO_BY_PATH,
      primaryPath: null,
      addResolvedFolders: (folders) => {
        const before = get().folders;
        set((state) => mergeWorkspaceFolderInfo(state, folders));
        const afterSet = new Set(get().folders);
        return before.filter((path) => !afterSet.has(path));
      },
      removeFolder: (folderPath) => {
        set((state) => {
          if (!state.folders.includes(folderPath)) return state;
          const nextInfoByPath = { ...state.folderInfoByPath };
          delete nextInfoByPath[folderPath];
          const nextFolders = state.folders.filter(
            (folder) => folder !== folderPath,
          );
          return {
            folders: nextFolders,
            folderInfoByPath: nextInfoByPath,
            // Deterministic fallback to the first remaining folder when the
            // removed folder WAS the primary; `resolvePrimaryPath` also
            // covers the "no folders left" case (`null`).
            primaryPath: resolvePrimaryPath(nextFolders, state.primaryPath),
          };
        });
      },
      setPrimaryFolder: (folderPath) => {
        set((state) => {
          if (!state.folders.includes(folderPath)) return state;
          if (state.primaryPath === folderPath) return state;
          return { primaryPath: folderPath };
        });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.workspaceFolders)),
      // Defensive re-derivation on every rehydration (mirrors
      // `landing-draft-store.ts`'s `merge`) rather than a zustand
      // version+migrate bump: a v1 payload predates `primaryPath` entirely,
      // and this validates it - and every other field - from raw JSON
      // regardless of shape, so an absent/stale/out-of-bounds value always
      // resolves to `folders[0] ?? null` instead of rehydrating verbatim.
      // NOTE: any FUTURE version bump on this store must supply a real
      // `migrate` (this custom `merge` is not itself a migration path).
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        // Metadata is parsed FIRST, independent of the raw `folders` array,
        // then `folders` is filtered down to paths that actually resolved
        // valid metadata (mirrors `landing-draft-store.ts`'s parse order).
        // Reversing this order - filtering metadata by an unvalidated
        // `folders` array, then resolving primary against THAT array - lets
        // a "ghost" path (present in `folders`, no/corrupt metadata) survive
        // rehydration and even resolve as primary, while every other reader
        // (rows, launch, chip) only ever sees the metadata-backed set.
        const folderInfoByPath = parsePersistedFolderInfoByPath(
          persisted.folderInfoByPath,
        );
        const validatedFolders = parsePersistedFolders(
          persisted.folders,
          folderInfoByPath,
        );
        // Reapply the cap on rehydration too - a manually-edited or
        // otherwise oversized persisted payload must not bypass it.
        const folders = trimFoldersPreservingPrimary(
          validatedFolders,
          parsePersistedPrimaryPath(persisted.primaryPath),
          MAX_FOLDERS,
        );
        const folderSet = new Set(folders);
        const finalInfoByPath = Object.fromEntries(
          Object.entries(folderInfoByPath).filter(([path]) =>
            folderSet.has(path),
          ),
        );
        return {
          ...currentState,
          folders,
          folderInfoByPath: finalInfoByPath,
          primaryPath: resolvePrimaryPath(
            folders,
            parsePersistedPrimaryPath(persisted.primaryPath),
          ),
        };
      },
    },
  ),
);

function parsePersistedPrimaryPath(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePersistedFolders(
  value: unknown,
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    if (!Object.hasOwn(folderInfoByPath, entry)) return [];
    if (seen.has(entry)) return [];
    seen.add(entry);
    return [entry];
  });
}

function parsePersistedFolderInfoByPath(
  value: unknown,
): Readonly<Record<string, WorkspaceFolderInfo>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([path, entry]) => {
      const parsed = parsePersistedFolderInfo(entry, path);
      return parsed === null ? [] : [[path, parsed]];
    }),
  );
}

function parsePersistedFolderInfo(
  value: unknown,
  expectedPath: string,
): WorkspaceFolderInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (value.path !== expectedPath) return null;
  return {
    path: value.path,
    name: value.name,
    repoIdentifier: parsePersistedRepoIdentifier(value.repoIdentifier),
  };
}

function parsePersistedRepoIdentifier(
  value: unknown,
): TaskRepoIdentifier | null {
  if (!isRecord(value)) return null;
  if (typeof value.owner !== "string" || typeof value.repo !== "string") {
    return null;
  }
  return { owner: value.owner, repo: value.repo };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeWorkspaceFolderInfo(
  state: WorkspaceFoldersStore,
  folders: ReadonlyArray<WorkspaceFolderInfo>,
):
  | WorkspaceFoldersStore
  | Pick<
      WorkspaceFoldersStore,
      "folders" | "folderInfoByPath" | "primaryPath"
    > {
  const trimmed = folders.flatMap((folder) => {
    const path = folder.path.trim();
    return path.length > 0
      ? [
          {
            path,
            name: folder.name,
            repoIdentifier: folder.repoIdentifier,
          },
        ]
      : [];
  });
  if (trimmed.length === 0) return state;

  const accumulator: MergeAccumulator = {
    folders: [...state.folders],
    infoByPath: { ...state.folderInfoByPath },
    changed: false,
  };
  for (const folder of trimmed) {
    mergeOneFolder(accumulator, folder);
  }
  if (!accumulator.changed) return state;
  // Cap eviction must never silently move primary: trim the oldest
  // SECONDARY folders first, keeping the resolved primary's slot intact even
  // when it sits at the front (the most eviction-prone position under naive
  // front-trimming).
  const nextFolders = trimFoldersPreservingPrimary(
    accumulator.folders,
    state.primaryPath,
    MAX_FOLDERS,
  );
  const nextFolderSet = new Set(nextFolders);
  // Prune evicted metadata the same functional way `merge()` does on rehydrate.
  const nextInfoByPath = Object.fromEntries(
    Object.entries(accumulator.infoByPath).filter(([path]) =>
      nextFolderSet.has(path),
    ),
  );
  return {
    folders: nextFolders,
    folderInfoByPath: nextInfoByPath,
    // Only stamps a primary when none was resolvable before (a fresh store,
    // or one whose stored primary no longer names a folder); an existing
    // valid primary is never disturbed by an add.
    primaryPath: resolvePrimaryPath(nextFolders, state.primaryPath),
  };
}

interface MergeAccumulator {
  folders: string[];
  infoByPath: Record<string, WorkspaceFolderInfo>;
  changed: boolean;
}

function mergeOneFolder(
  acc: MergeAccumulator,
  folder: WorkspaceFolderInfo,
): void {
  // Path is the identity - two clones of the same repo at different
  // paths coexist as separate entries.
  if (!acc.folders.includes(folder.path)) {
    acc.folders.push(folder.path);
    acc.changed = true;
  }
  const existing = Object.hasOwn(acc.infoByPath, folder.path)
    ? acc.infoByPath[folder.path]
    : null;
  if (
    existing === null ||
    !sameRepoIdentifier(existing.repoIdentifier, folder.repoIdentifier) ||
    existing.name !== folder.name
  ) {
    acc.infoByPath[folder.path] = folder;
    acc.changed = true;
  }
}

function sameRepoIdentifier(
  a: TaskRepoIdentifier | null,
  b: TaskRepoIdentifier | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.owner === b.owner && a.repo === b.repo;
}
