import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

interface RecordRecentContext {
  readonly hostId: string | null;
}

export interface RecordRecentWorkspaceInput {
  readonly path: string;
  readonly bumpRecency: boolean;
  readonly failureFeedback: "silent" | "move_warning";
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
      // The host is the only owner of the recents order, so the appended list
      // has to be re-read rather than guessed at. Host captured in `onMutate`
      // and used in `onSuccess`: the picker settles and closes the moment this
      // is fired, so the active host can have moved on by the time it lands -
      // invalidating the CURRENT host would refetch the wrong machine's list
      // and leave the right one stale.
      onMutate: () => ({ hostId: args.client?.getActiveHostId() ?? null }),
      onSuccess: async (_result, _variables, context) => {
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "workspace.prepareFolders",
          ),
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
