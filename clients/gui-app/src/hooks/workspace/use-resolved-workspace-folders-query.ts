import { useMemo } from "react";
import {
  formatRepoIdentifier,
  type TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import {
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";
export type { ResolvedFolder };

export interface ResolvedWorkspaceFoldersQueryResult {
  readonly folders: ReadonlyArray<ResolvedFolder>;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
}

export interface WorkspaceFoldersSource {
  readonly folders: ReadonlyArray<string>;
  readonly folderInfoByPath: Readonly<Record<string, WorkspaceFolderInfo>>;
}

/**
 * Joins the GUI's global `useWorkspaceFoldersStore` against the bound
 * host's `RepoWorkspacePersistence` lookup, producing a unified list
 * of `ResolvedFolder` rows that the combined chip can render directly.
 *
 * Folders without a `repoIdentifier` are projected as `local-only`
 * without hitting the host - they only mean something on the host
 * where they were added. Folders with a `repoIdentifier` round-trip
 * through `workspace.resolvePathsByRepoIdentifiers`; missing rows are
 * `unresolved`.
 *
 * `client` is the host the repo-identifier resolution runs against. Callers
 * MUST pass the scope-correct client: the active/default host for landing &
 * chat surfaces, the source agent's FIXED host for the terminal-agent fork
 * dialog (otherwise paths would resolve on the wrong machine on multi-host
 * setups).
 */
export function useResolvedWorkspaceFolders(
  source: WorkspaceFoldersSource | null,
  client: HostClient<HostRpcRegistry> | null,
): ResolvedWorkspaceFoldersQueryResult {
  const globalFolders = useWorkspaceFoldersStore((s) => s.folders);
  const globalFolderInfoByPath = useWorkspaceFoldersStore(
    (s) => s.folderInfoByPath,
  );
  const folders = source === null ? globalFolders : source.folders;
  const folderInfoByPath =
    source === null ? globalFolderInfoByPath : source.folderInfoByPath;

  const folderInfos = useMemo<ReadonlyArray<WorkspaceFolderInfo>>(
    () =>
      folders.flatMap<WorkspaceFolderInfo>((path) =>
        Object.hasOwn(folderInfoByPath, path) ? [folderInfoByPath[path]] : [],
      ),
    [folders, folderInfoByPath],
  );

  const repoIdentifiers = useMemo<ReadonlyArray<TaskRepoIdentifier>>(
    () =>
      folderInfos.flatMap((info) =>
        info.repoIdentifier === null ? [] : [info.repoIdentifier],
      ),
    [folderInfos],
  );

  const queryParams = useMemo(
    () => ({ repoIdentifiers: [...repoIdentifiers] }),
    [repoIdentifiers],
  );
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "workspace.resolvePathsByRepoIdentifiers",
    params: queryParams,
    options: {
      enabled: repoIdentifiers.length > 0,
      // Resolution gates submit. A transient failure must have a recovery
      // trigger short of reloading the app, even though app-wide queries opt
      // out of focus/reconnect refetches by default.
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
    },
  });

  // One repo can resolve to multiple paths on the same host (two
  // clones, two adopted worktrees, …) - store the full set so each
  // stored `info.path` matches independently.
  const resolvedByKey = useMemo<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => {
    const map = new Map<string, Set<string>>();
    if (query.data === undefined) return map;
    for (const mapping of query.data.mappings) {
      const key = formatRepoIdentifier(mapping.repoIdentifier);
      const existing = map.get(key);
      if (existing === undefined) {
        map.set(key, new Set([mapping.workspacePath]));
      } else {
        existing.add(mapping.workspacePath);
      }
    }
    return map;
  }, [query.data]);

  const resolved = useMemo<ReadonlyArray<ResolvedFolder>>(
    () => folderInfos.map((info) => projectFolder(info, resolvedByKey)),
    [folderInfos, resolvedByKey],
  );

  return useMemo(() => {
    const isError = query.isError;
    return {
      folders: resolved,
      // A readiness-disabled query with repo-backed folders has not checked
      // the host yet. Treat it as checking, not as a confirmed missing row.
      isLoading:
        repoIdentifiers.length > 0 && query.data === undefined && !isError,
      isFetching: query.isFetching,
      isError,
    };
  }, [
    resolved,
    repoIdentifiers.length,
    query.data,
    query.isError,
    query.isFetching,
  ]);
}

function projectFolder(
  info: WorkspaceFolderInfo,
  resolvedByKey: ReadonlyMap<string, ReadonlySet<string>>,
): ResolvedFolder {
  const repoIdentifier = info.repoIdentifier;
  if (repoIdentifier === null) {
    return { kind: "local-only", path: info.path, name: info.name };
  }
  const hostPaths = resolvedByKey.get(formatRepoIdentifier(repoIdentifier));
  if (hostPaths !== undefined && hostPaths.has(info.path)) {
    return {
      kind: "resolved",
      path: info.path,
      name: info.name,
      repoIdentifier,
    };
  }
  return {
    kind: "unresolved",
    path: info.path,
    name: info.name,
    repoIdentifier,
  };
}
