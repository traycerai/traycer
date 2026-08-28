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

/**
 * Which project root this tab is pointed at: the stored selection when it
 * still names something offered, else the single workspace of a one-workspace
 * host, else nothing.
 *
 * Extracted rather than inlined in `useProviderNativeScope` because the middle
 * case has a timing condition that reads as noise beside the hook's other work
 * — and it is the case that matters. `targetPaths` gains WORKTREE paths only
 * once the worktree query resolves, so until then a stored worktree selection
 * fails the membership test and looks indistinguishable from "nothing
 * selected". Taking the single-workspace default in that window silently
 * retargets the PARENT repo, and this value drives both the list and every
 * add/remove — so an action landing there writes a different repo's config.
 *
 * The gate is "have we got worktree data", NOT "is the query still pending".
 * A FAILED lookup also leaves `targetPaths` worktree-less, but leaves
 * `isPending` false - so gating on pending would hand the error path the exact
 * silent retarget the gate exists to prevent. `data === undefined` is the one
 * predicate that covers both, and it is what `targetPaths` is derived from, so
 * the two cannot drift apart; it also survives a failed BACKGROUND refetch,
 * where cached targets are still the right answer.
 *
 * Gating this way is safe only because it guards the branch that already
 * requires exactly one workspace, which is precisely when that query is
 * enabled. With zero workspaces it is disabled and never resolves, so a wider
 * gate here would strand the empty-host states behind it.
 */
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
  // Still defaults the single-workspace host to its one workspace - but the
  // picker now RENDERS that as a selected control instead of a static line, so
  // the default is visible as a choice that can be changed (including to one
  // of that repo's worktrees).
  if (hostPaths.length === 1) return hostPaths[0];
  return null;
}

/**
 * Shared global/project scope state for provider native-config tabs (MCP,
 * Plugins, Skills). Driven by each domain's `actionScopes.list` so a provider
 * that only advertises one scope does not show a dead second option.
 *
 * Workspace selection is per host (not per tab): switching MCP/Plugins/Skills
 * keeps the same project folder, which is the intended consistency.
 */
export function useProviderNativeScope(
  listScopes: readonly ProviderNativeScope[],
) {
  // Subscribed for the RE-RENDER, not for the value: the app-wide active host
  // changing has to repaint this hook. The id below is read off the BOUND
  // client instead, because Settings can target a non-active host through a
  // transient `HostRuntimeContext` override - and then `targets` come from
  // that host while the selection would have been filed under the active
  // one's key, so a stored path could never validate against the list it was
  // picked from.
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

  // Worktrees are targets, not trivia. A Traycer-managed worktree is a real
  // project root with its own config, and previously it could only be picked
  // here by coincidence - if its path happened to sit in the global
  // recent-folders store - and then showed as a bare basename indistinguishable
  // from its sibling worktrees. Listing them explicitly, with their branch, is
  // what makes "which folder?" answerable.
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
      // Emission order IS the grouping the picker relies on: a workspace
      // immediately followed by its own sibling worktrees, so no group headers
      // are needed to see which repo a worktree belongs to.
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

  // Adding a folder here is the escape hatch for the case the old control had
  // no answer to at all: this client has opened no folders on this host, so
  // `targets` is empty and Global is the only reachable destination. Bound to
  // the SETTINGS-selected client, not the app-wide one, so a folder picked
  // while viewing host B is prepared on B.
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
    // Only the workspace resolution gates the empty states. The worktree query
    // is ENRICHMENT layered on rows that already exist, and it is `enabled:
    // false` with zero workspaces - where `isPending` stays true forever, so
    // folding it in here would strand the "open a workspace" state behind a
    // spinner that never resolves.
    workspacesLoading: resolved.isLoading,
  };
}
