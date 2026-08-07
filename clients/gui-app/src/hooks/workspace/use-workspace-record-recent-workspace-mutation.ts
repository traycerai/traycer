import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useHostMutation } from "@/hooks/host/use-host-query";

interface RecordRecentContext {
  readonly hostId: string | null;
}

/**
 * Append a picked folder to the host's recent-workspaces list
 * (`workspace.prepareFolders` v1.1 `recordRecentWorkspace`, which re-validates
 * the path and only appends on success).
 *
 * Deliberately fire-and-forget, and deliberately WITHOUT an `onError` toast:
 * this is bookkeeping for a convenience row, so a v1.0 host (which fails this
 * closed with `DOWNGRADE_UNSUPPORTED`) or an unreachable one must cost the
 * user nothing - the folder they picked is still added by the caller's own
 * `prepare` call, which owns the real error reporting.
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
    string
  >({
    client: args.client,
    method: "workspace.prepareFolders",
    mapVariables: (path) => ({
      operation: "recordRecentWorkspace",
      folderPaths: null,
      path,
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
    },
  });
}
