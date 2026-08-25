import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { WorkspacePrepareFoldersResponseV14 } from "@traycer/protocol/host/workspace/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { recentWorkspacesQueryKey } from "./use-workspace-list-recent-workspaces-query";

interface RecordRecentContext {
  readonly hostId: string | null;
}

export interface RecordRecentWorkspaceInput {
  readonly path: string;
  readonly bumpRecency: boolean;
  readonly failureFeedback: "silent" | "move_warning";
}

export function writeRecentWorkspacesCache(
  queryClient: QueryClient,
  hostId: string | null,
  result: WorkspacePrepareFoldersResponseV14,
): boolean {
  if (result.recentWorkspaces === null) return false;
  queryClient.setQueryData<WorkspacePrepareFoldersResponseV14>(
    recentWorkspacesQueryKey(hostId),
    { ...result, operation: "listRecentWorkspaces" },
  );
  return true;
}

/**
 * Append a folder to the host's recent-workspaces list.
 *
 * New picks use this as fire-and-forget bookkeeping. Moving an active folder
 * awaits the same mutation before removing it from context, because that user
 * action must either complete both halves or leave the active folder intact.
 *
 * No `mutationKey`: `workspaceMutationKeys.prepareFolders()` is what
 * `useWorkspaceFolderActions` counts to drive its `isPreparing` flag, and
 * recording a recent is not preparing folders.
 */
export function useWorkspaceRecordRecentWorkspace(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
}) {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "workspace.prepareFolders",
    RecordRecentContext,
    RecordRecentWorkspaceInput
  >({
    client: args.client,
    method: "workspace.prepareFolders",
    mapVariables: (input) => ({
      operation: "recordRecentWorkspace",
      folderPaths: null,
      path: input.path,
      bumpRecency: input.bumpRecency,
    }),
    options: {
      retry: false,
      // The host is the only owner of recents order, so current hosts return
      // the authoritative post-write list for a cache write-through. Older
      // hosts return null and fall back to one exact invalidation. Host is
      // captured before dispatch because the picker closes immediately and
      // the active host can move before this lands.
      onMutate: () => ({ hostId: args.client?.getActiveHostId() ?? null }),
      onSuccess: async (result, _variables, context) => {
        if (writeRecentWorkspacesCache(queryClient, context.hostId, result))
          return;
        if (result.validation?.ok === false) return;
        await queryClient.invalidateQueries({
          queryKey: recentWorkspacesQueryKey(context.hostId),
        });
      },
      onError: (_error, variables) => {
        if (variables.failureFeedback !== "move_warning") return;
        reportableErrorToast(
          "Workspace wasn't moved because it couldn't be saved to Recent.",
          undefined,
          {
            title: "Could not save recent workspace",
            message: null,
            code: null,
            source: "Workspace folders",
          },
        );
      },
    },
  });
}
