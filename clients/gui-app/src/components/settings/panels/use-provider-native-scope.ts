import { useCallback, useMemo, useState } from "react";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActionsForClient,
} from "@/hooks/workspace/use-workspace-folder-actions";
import { useWorktreeListByWorkspacePathsForClient } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import { useHostBinding } from "@/lib/host";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { useProvidersWorkspaceSelectionStore } from "@/stores/settings/providers-workspace-selection-store";
import {
  selectWorkspaceFoldersBucket,
  useWorkspaceFoldersStore,
} from "@/stores/workspace/workspace-folders-store";
import type { McpScopeTarget } from "./provider-mcp-scope-picker";

function resolveLockedScope(
  supportsProject: boolean,
  supportsGlobal: boolean,
): ProviderNativeScope {
  if (supportsProject && !supportsGlobal) return "project";
  return "global";
}

/** With zero workspaces it is disabled and never resolves, so a wider gate here would strand the empty-host
 * states behind it. */
export function resolveProviderNativeWorkspaceRoot(args: {
  readonly selected: string | undefined;
  readonly targetPaths: readonly string[];
  readonly hostPaths: readonly string[];
  readonly worktreesLoaded: boolean;
}): string | null {
  const { selected, targetPaths, hostPaths, worktreesLoaded } = args;
  // Validated against every offered target, not just the open workspaces, so a
  // stored worktree selection survives a reload.
  if (selected !== undefined && targetPaths.includes(selected)) return selected;
  if (selected !== undefined && !worktreesLoaded) return null;
  // Still defaults the single-workspace host to its one workspace.
  if (hostPaths.length === 1) return hostPaths[0];
  return null;
}

/** Driven by each domain's `actionScopes.list` so a provider that only advertises one scope does not show a
 * dead second option. */
export function useProviderNativeScope(
  listScopes: readonly ProviderNativeScope[],
) {
  // The id below is read off the bound client instead, because Settings can target a non-active host through a
  // transient `HostRuntimeContext` override.
  const activeHostId = useAddressableHostId();
  // Prefer the runtime binding when present; null is valid (tests / host-less
  // shells) and falls through to local-only resolution.
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const hostId = client?.getActiveHostId() ?? activeHostId;
  // The Settings-bound host's own folder bucket - another host's paths can
  // never become a Project workspaceRoot for this host (B6).
  const folders = useWorkspaceFoldersStore(
    (s) => selectWorkspaceFoldersBucket(s, hostId).folders,
  );
  const folderInfoByPath = useWorkspaceFoldersStore(
    (s) => selectWorkspaceFoldersBucket(s, hostId).folderInfoByPath,
  );
  const folderSource = useMemo(
    () => ({ folders, folderInfoByPath }),
    [folders, folderInfoByPath],
  );
  const selectedByHostId = useProvidersWorkspaceSelectionStore(
    (s) => s.selectedByHostId,
  );
  const setSelected = useProvidersWorkspaceSelectionStore((s) => s.setSelected);

  // Resolve against the HostRuntimeContext-bound host so paths from another
  // machine never become Project workspaceRoot for this host (B6).
  const resolved = useResolvedWorkspaceFolders(folderSource, client, hostId);
  const workspaces = useMemo(
    () =>
      resolved.folders
        .filter((folder) => folder.kind !== "unresolved")
        .map((folder) => ({
          path: folder.path,
          name:
            folder.name.length > 0
              ? folder.name
              : workspaceFolderName(folder.path),
        })),
    [resolved.folders],
  );
  const hostPaths = useMemo(
    () => workspaces.map((ws) => ws.path),
    [workspaces],
  );

  // Worktrees are targets, not trivia.
  const worktreeQuery = useWorktreeListByWorkspacePathsForClient(client, {
    workspacePaths: hostPaths,
    enabled: hostPaths.length > 0,
  });

  const targets = useMemo<readonly McpScopeTarget[]>(() => {
    const summaries = worktreeQuery.data?.workspaces ?? [];
    const out: McpScopeTarget[] = [];
    const seen = new Set<string>();
    const push = (target: McpScopeTarget): void => {
      if (seen.has(target.path)) return;
      seen.add(target.path);
      out.push(target);
    };
    for (const ws of workspaces) {
      const summary =
        summaries.find((entry) => entry.workspacePath === ws.path) ?? null;
      const entries = summary?.worktrees ?? [];
      const self = entries.find((wt) => wt.worktreePath === ws.path) ?? null;
      // Emission order IS the grouping the picker relies on: a workspace immediately followed by its own sibling
      // worktrees, so no group headers are needed to see which repo a worktree belongs to.
      push({
        path: ws.path,
        name: ws.name,
        branch: self?.branch ?? null,
        isWorktree: self !== null && !self.isMain,
      });
      // Deduped against `seen` because a repo listed under two open folders
      // reports the same worktree set twice.
      for (const wt of entries) {
        if (wt.worktreePath === ws.path) continue;
        push({
          path: wt.worktreePath,
          name: workspaceFolderName(wt.worktreePath),
          branch: wt.branch,
          isWorktree: !wt.isMain,
        });
      }
    }
    return out;
  }, [workspaces, worktreeQuery.data]);

  const targetPaths = useMemo(
    () => targets.map((target) => target.path),
    [targets],
  );

  const selected = hostId === null ? undefined : selectedByHostId[hostId];
  const workspaceRoot = resolveProviderNativeWorkspaceRoot({
    selected,
    targetPaths,
    hostPaths,
    worktreesLoaded: worktreeQuery.data !== undefined,
  });

  const setWorkspaceRoot = useCallback(
    (path: string) => {
      if (hostId === null) return;
      setSelected(hostId, path);
    },
    [hostId, setSelected],
  );

  const multiWorkspace = hostPaths.length > 1;

  // Bound to the settings-selected client, not the app-wide one, so a folder picked while viewing host B is
  // prepared on B.
  const folderActions = useWorkspaceFolderActionsForClient(client);
  const addResolvedFolders = useWorkspaceFoldersStore(
    (s) => s.addResolvedFolders,
  );
  const { pickAndPrepareFolders } = folderActions;
  const browseForWorkspace = useCallback(async (): Promise<string | null> => {
    const result = await pickAndPrepareFolders(false);
    if (result === null) return null;
    addResolvedFolders(
      // `result.hostId` is the dispatch-time identity the action captured
      // and re-validated across every await - never re-read the client here.
      result.hostId,
      result.folders.map((folder) =>
        preparedWorkspaceFolderToWorkspaceFolderInfo(folder, result.hostId),
      ),
    );
    return result.folders[0]?.workspacePath ?? null;
  }, [addResolvedFolders, pickAndPrepareFolders]);

  const supportsGlobal = listScopes.includes("global");
  const supportsProject = listScopes.includes("project");
  const multiScope = supportsGlobal && supportsProject;
  const lockedScope = resolveLockedScope(supportsProject, supportsGlobal);

  const [scope, setScope] = useState<ProviderNativeScope>(lockedScope);
  const effectiveScope: ProviderNativeScope = multiScope ? scope : lockedScope;

  const projectNeedsWorkspace =
    effectiveScope === "project" && workspaceRoot === null;
  const listWorkspaceRoot = effectiveScope === "global" ? null : workspaceRoot;

  return {
    hostId,
    targets,
    workspaceRoot,
    setWorkspaceRoot,
    browseForWorkspace,
    browsePending: folderActions.isPreparing,
    multiWorkspace,
    multiScope,
    effectiveScope,
    setScope,
    projectNeedsWorkspace,
    listWorkspaceRoot,
    listEnabled: !projectNeedsWorkspace,
    // The worktree query is enrichment layered on rows that already exist, and it is `enabled: false` with zero
    // workspaces.
    workspacesLoading: resolved.isLoading,
  };
}
