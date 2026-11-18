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
  /**
   * Host that prepared/opened this folder. Required for non-git (local-only)
   * paths so Project-scope MCP does not send Host A's scratch path to Host B.
   * Null only for legacy persisted rows that predate host stamping (v2
   * migration drops those - they cannot be attributed to a bucket).
   */
  readonly hostId: string | null;
}

/**
 * One host's workspace selection. Folder paths are host-local (the SAME
 * string can name different directories on two machines), so the selection
 * list, its metadata, and the primary choice are all bucketed by host -
 * switching hosts restores that host's last selection instead of leaking
 * another machine's paths.
 */
export interface WorkspaceFoldersHostBucket {
  readonly folders: ReadonlyArray<string>;
  readonly folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
  readonly primaryPath: string | null;
}

interface WorkspaceFoldersStore {
  byHost: Readonly<Record<string, WorkspaceFoldersHostBucket>>;
  // Returns the paths EVICTED by the 50-folder cap (empty when nothing was
  // evicted) so callers can unstage any in-flight worktree intent for them -
  // otherwise an evicted folder can disappear from rows/persistence while
  // still riding along in a staged/outgoing WorktreeIntent. `hostId === null`
  // (no resolved host) is a no-op: a folder selection always belongs to the
  // host it was browsed on.
  addResolvedFolders: (
    hostId: string | null,
    folders: ReadonlyArray<WorkspaceFolderInfo>,
  ) => ReadonlyArray<string>;
  removeFolder: (hostId: string | null, folderPath: string) => void;
  setPrimaryFolder: (hostId: string | null, folderPath: string) => void;
}

const MAX_FOLDERS = 50;

export const EMPTY_WORKSPACE_FOLDERS_BUCKET: WorkspaceFoldersHostBucket = {
  folders: [],
  folderInfoByPath: {},
  primaryPath: null,
};

/** The one read seam: a host's bucket, or the shared empty bucket for a
 *  missing/null host (stable identity, so selectors don't churn). */
export function selectWorkspaceFoldersBucket(
  state: Pick<WorkspaceFoldersStore, "byHost">,
  hostId: string | null,
): WorkspaceFoldersHostBucket {
  if (hostId === null || !Object.hasOwn(state.byHost, hostId)) {
    return EMPTY_WORKSPACE_FOLDERS_BUCKET;
  }
  return state.byHost[hostId];
}

export const useWorkspaceFoldersStore = create<WorkspaceFoldersStore>()(
  persist(
    (set, get) => ({
      byHost: {},
      addResolvedFolders: (hostId, folders) => {
        if (hostId === null) return [];
        // `hostId` is canonical, so a bucket only ever holds rows stamped with
        // its own host. The picker stamps each row with its DISPATCH-time
        // host, which a host switch landing between `pickAndPrepareFolders()`
        // and this call can outrun - filing host A's paths under host B is the
        // exact cross-host leak the buckets exist to prevent, so a mismatched
        // row is dropped rather than rehomed.
        const ownFolders = folders.filter((folder) => folder.hostId === hostId);
        const before = selectWorkspaceFoldersBucket(get(), hostId).folders;
        set((state) => {
          const bucket = selectWorkspaceFoldersBucket(state, hostId);
          const nextBucket = mergeWorkspaceFolderInfo(bucket, ownFolders);
          if (nextBucket === bucket) return state;
          return { byHost: { ...state.byHost, [hostId]: nextBucket } };
        });
        const afterSet = new Set(
          selectWorkspaceFoldersBucket(get(), hostId).folders,
        );
        return before.filter((path) => !afterSet.has(path));
      },
      removeFolder: (hostId, folderPath) => {
        if (hostId === null) return;
        set((state) => {
          const bucket = selectWorkspaceFoldersBucket(state, hostId);
          if (!bucket.folders.includes(folderPath)) return state;
          const nextInfoByPath = { ...bucket.folderInfoByPath };
          delete nextInfoByPath[folderPath];
          const nextFolders = bucket.folders.filter(
            (folder) => folder !== folderPath,
          );
          return {
            byHost: {
              ...state.byHost,
              [hostId]: {
                folders: nextFolders,
                folderInfoByPath: nextInfoByPath,
                // Deterministic fallback to the first remaining folder when
                // the removed folder WAS the primary; `resolvePrimaryPath`
                // also covers the "no folders left" case (`null`).
                primaryPath: resolvePrimaryPath(
                  nextFolders,
                  bucket.primaryPath,
                ),
              },
            },
          };
        });
      },
      setPrimaryFolder: (hostId, folderPath) => {
        if (hostId === null) return;
        set((state) => {
          const bucket = selectWorkspaceFoldersBucket(state, hostId);
          if (!bucket.folders.includes(folderPath)) return state;
          if (bucket.primaryPath === folderPath) return state;
          return {
            byHost: {
              ...state.byHost,
              [hostId]: { ...bucket, primaryPath: folderPath },
            },
          };
        });
      },
    }),
    {
      ...basePersistOptions(persistKey(STORE_KEYS.workspaceFolders)),
      version: 2,
      // v1 -> v2: the flat selection is partitioned into per-host buckets by
      // each row's existing `hostId` stamp; null-stamped rows (pre-stamping
      // legacy) are dropped - they cannot be attributed to a host, and
      // keeping them in every bucket would recreate the cross-host leak this
      // migration exists to fix.
      migrate: (persisted) => migrateWorkspaceFoldersPersistedState(persisted),
      // Defensive re-derivation on every rehydration (mirrors
      // `landing-draft-store.ts`'s `merge`): every bucket - and every field
      // in it - is validated from raw JSON regardless of shape, so an
      // absent/stale/out-of-bounds value always resolves sanely instead of
      // rehydrating verbatim. `migrate` above only runs for version < 2;
      // this validates the CURRENT shape too.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        return {
          ...currentState,
          byHost: parsePersistedByHost(persisted.byHost),
        };
      },
    },
  ),
);

interface MigratedWorkspaceFoldersPersistedState {
  readonly byHost: Readonly<Record<string, WorkspaceFoldersHostBucket>>;
}

export function migrateWorkspaceFoldersPersistedState(
  persisted: unknown,
): MigratedWorkspaceFoldersPersistedState {
  if (!isRecord(persisted)) return { byHost: {} };
  // Metadata is parsed FIRST, independent of the raw `folders` array, then
  // `folders` is filtered down to paths that actually resolved valid
  // metadata (mirrors `landing-draft-store.ts`'s parse order). Reversing
  // this order lets a "ghost" path (present in `folders`, no/corrupt
  // metadata) survive migration and even resolve as primary.
  const folderInfoByPath = parsePersistedFolderInfoByPath(
    persisted.folderInfoByPath,
  );
  const orderedFolders = parsePersistedFolders(
    persisted.folders,
    folderInfoByPath,
  );
  const flatPrimaryPath = parsePersistedPrimaryPath(persisted.primaryPath);
  const partitioned: Record<
    string,
    { folders: string[]; folderInfoByPath: Record<string, WorkspaceFolderInfo> }
  > = {};
  for (const path of orderedFolders) {
    const info = folderInfoByPath[path];
    if (info.hostId === null) continue;
    const bucket = (partitioned[info.hostId] ??= {
      folders: [],
      folderInfoByPath: {},
    });
    bucket.folders.push(path);
    bucket.folderInfoByPath[path] = info;
  }
  const byHost = Object.fromEntries(
    Object.entries(partitioned).map(([hostId, bucket]) => [
      hostId,
      // The v1 primary belongs to whichever bucket contains its path; every
      // other bucket resolves its own first folder, matching the pre-split
      // "absent primary" behavior.
      normalizeBucket(
        bucket.folders,
        bucket.folderInfoByPath,
        bucket.folders.includes(flatPrimaryPath ?? "") ? flatPrimaryPath : null,
      ),
    ]),
  );
  return { byHost };
}

// Validate + cap one raw bucket into the canonical shape. Shared by the v2
// `merge` validation and the v1 migration so both apply the identical cap
// and primary-resolution rules.
function normalizeBucket(
  validatedFolders: ReadonlyArray<string>,
  folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>,
  primaryPath: string | null,
): WorkspaceFoldersHostBucket {
  // Reapply the cap on rehydration too - a manually-edited or otherwise
  // oversized persisted payload must not bypass it.
  const folders = trimFoldersPreservingPrimary(
    validatedFolders,
    primaryPath,
    MAX_FOLDERS,
  );
  const folderSet = new Set(folders);
  const finalInfoByPath = Object.fromEntries(
    Object.entries(folderInfoByPath).filter(([path]) => folderSet.has(path)),
  );
  return {
    folders,
    folderInfoByPath: finalInfoByPath,
    primaryPath: resolvePrimaryPath(folders, primaryPath),
  };
}

function parsePersistedByHost(
  value: unknown,
): Readonly<Record<string, WorkspaceFoldersHostBucket>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([hostId, rawBucket]) => {
      if (!isRecord(rawBucket)) return [];
      // Same invariant the writer enforces, re-applied to raw JSON: a bucket
      // keeps only rows stamped with ITS host. A hand-edited or otherwise
      // corrupt payload therefore cannot surface one host's local paths under
      // another host. Filtering the metadata BEFORE parsing `folders` also
      // drops the now-ghost paths, since a path survives only while it
      // resolves metadata.
      const bucketFolderInfoByPath = Object.fromEntries(
        Object.entries(
          parsePersistedFolderInfoByPath(rawBucket.folderInfoByPath),
        ).filter(([, info]) => info.hostId === hostId),
      );
      const folders = parsePersistedFolders(
        rawBucket.folders,
        bucketFolderInfoByPath,
      );
      if (folders.length === 0) return [];
      return [
        [
          hostId,
          normalizeBucket(
            folders,
            bucketFolderInfoByPath,
            parsePersistedPrimaryPath(rawBucket.primaryPath),
          ),
        ],
      ];
    }),
  );
}

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
    hostId: typeof value.hostId === "string" ? value.hostId : null,
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
  bucket: WorkspaceFoldersHostBucket,
  folders: ReadonlyArray<WorkspaceFolderInfo>,
): WorkspaceFoldersHostBucket {
  const trimmed = folders.flatMap((folder) => {
    const path = folder.path.trim();
    return path.length > 0
      ? [
          {
            path,
            name: folder.name,
            repoIdentifier: folder.repoIdentifier,
            hostId: folder.hostId,
          },
        ]
      : [];
  });
  if (trimmed.length === 0) return bucket;

  const accumulator: MergeAccumulator = {
    folders: [...bucket.folders],
    infoByPath: { ...bucket.folderInfoByPath },
    changed: false,
  };
  for (const folder of trimmed) {
    mergeOneFolder(accumulator, folder);
  }
  if (!accumulator.changed) return bucket;
  // Cap eviction must never silently move primary: trim the oldest
  // SECONDARY folders first, keeping the resolved primary's slot intact even
  // when it sits at the front (the most eviction-prone position under naive
  // front-trimming).
  const nextFolders = trimFoldersPreservingPrimary(
    accumulator.folders,
    bucket.primaryPath,
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
    // Only stamps a primary when none was resolvable before (a fresh bucket,
    // or one whose stored primary no longer names a folder); an existing
    // valid primary is never disturbed by an add.
    primaryPath: resolvePrimaryPath(nextFolders, bucket.primaryPath),
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
    existing.name !== folder.name ||
    existing.hostId !== folder.hostId
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
