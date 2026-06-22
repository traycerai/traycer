import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";

export interface WorkspaceFolderInfo {
  readonly path: string;
  readonly name: string;
  readonly repoIdentifier: TaskRepoIdentifier | null;
}

interface WorkspaceFoldersStore {
  folders: ReadonlyArray<string>;
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
  addResolvedFolders: (folders: ReadonlyArray<WorkspaceFolderInfo>) => void;
  removeFolder: (folderPath: string) => void;
}

const INITIAL_FOLDERS: ReadonlyArray<string> = [];
const INITIAL_FOLDER_INFO_BY_PATH: Readonly<
  Record<string, WorkspaceFolderInfo>
> = {};
const MAX_FOLDERS = 50;

export const useWorkspaceFoldersStore = create<WorkspaceFoldersStore>()(
  persist(
    (set) => ({
      folders: INITIAL_FOLDERS,
      folderInfoByPath: INITIAL_FOLDER_INFO_BY_PATH,
      addResolvedFolders: (folders) => {
        set((state) => mergeWorkspaceFolderInfo(state, folders));
      },
      removeFolder: (folderPath) => {
        set((state) => {
          if (!state.folders.includes(folderPath)) return state;
          const nextInfoByPath = { ...state.folderInfoByPath };
          delete nextInfoByPath[folderPath];
          return {
            folders: state.folders.filter((folder) => folder !== folderPath),
            folderInfoByPath: nextInfoByPath,
          };
        });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.workspaceFolders)),
    },
  ),
);

function mergeWorkspaceFolderInfo(
  state: WorkspaceFoldersStore,
  folders: ReadonlyArray<WorkspaceFolderInfo>,
):
  | WorkspaceFoldersStore
  | Pick<WorkspaceFoldersStore, "folders" | "folderInfoByPath"> {
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
  const nextFolders = accumulator.folders;
  const nextInfoByPath = accumulator.infoByPath;

  if (nextFolders.length <= MAX_FOLDERS) {
    return { folders: nextFolders, folderInfoByPath: nextInfoByPath };
  }
  const limitedFolders = nextFolders.slice(nextFolders.length - MAX_FOLDERS);
  const limitedFolderSet = new Set(limitedFolders);
  for (const path of Object.keys(nextInfoByPath)) {
    if (!limitedFolderSet.has(path)) delete nextInfoByPath[path];
  }
  return { folders: limitedFolders, folderInfoByPath: nextInfoByPath };
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
