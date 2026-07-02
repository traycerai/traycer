import { useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { gitMutationKeys } from "@/lib/query-keys";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { writeGitListChangedFilesWithSubmodulesResponse } from "@/lib/git/write-list-changed-files-with-submodules-response";
import {
  bumpSubmoduleSnapshotEpoch,
  submoduleSnapshotSlotKey,
} from "@/lib/git/submodule-snapshot-refresh-coordinator";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface GitRefreshSubmoduleStatusVariables {
  readonly hostId: string;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}

interface GitRefreshSubmoduleStatusContext {
  readonly hostId: string;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}

type GitListChangedFilesResponse = ResponseOfMethod<
  HostRpcRegistry,
  "git.listChangedFiles"
>;

/**
 * Manual refresh for the submodule-aware nested snapshot. Force-fetches
 * `git.listChangedFiles@1.1` with `refreshRelations: true` - the only way to
 * make the host recompute a submodule relation past its SHA-tuple cache (e.g. a
 * cached `unknown`) without a tuple change - and writes the response into the
 * v1.1 slot the panel renders (mirroring the parent into the v1.0 slot the
 * picker/subscription share).
 *
 * `targetHostId` is the selected worktree's host: git panels are worktree-scoped,
 * so the RPC is routed through a client bound to that host (not the app-wide
 * active host). The passive poll shares the v1.1 slot, so the mutation cancels
 * any in-flight poll before writing and bumps the refresh epoch afterward so a
 * poll that overlapped it stands down - the forced snapshot always wins.
 */
export function useGitRefreshSubmoduleStatus(
  targetHostId: string | null,
): UseMutationResult<
  GitListChangedFilesResponse,
  HostRpcError,
  GitRefreshSubmoduleStatusVariables,
  GitRefreshSubmoduleStatusContext
> {
  const queryClient = useQueryClient();
  const entry = useHostDirectoryEntry(targetHostId ?? "");
  const client = useHostClientFor(entry);

  return useHostMutation<
    HostRpcRegistry,
    "git.listChangedFiles",
    GitRefreshSubmoduleStatusContext,
    GitRefreshSubmoduleStatusVariables
  >({
    client,
    method: "git.listChangedFiles",
    mapVariables: (variables) => ({
      hostId: variables.hostId,
      runningDir: variables.runningDir,
      ignoreWhitespace: variables.ignoreWhitespace,
      refreshRelations: true,
    }),
    options: {
      mutationKey: gitMutationKeys.refreshSubmoduleStatus(),
      onMutate: async (variables) => {
        // Supersede any in-flight passive poll on this slot so its older
        // `refreshRelations:false` result can't land after the forced snapshot.
        await queryClient.cancelQueries({
          queryKey: gitQueryKeys.listChangedFilesWithSubmodules(
            variables.hostId,
            variables.runningDir,
            variables.ignoreWhitespace,
          ),
        });
        return {
          hostId: variables.hostId,
          runningDir: variables.runningDir,
          ignoreWhitespace: variables.ignoreWhitespace,
        };
      },
      onSuccess: (data, _variables, context) => {
        writeGitListChangedFilesWithSubmodulesResponse(
          queryClient,
          context,
          data,
        );
        // A poll that started during the refresh will see a newer epoch and
        // discard its own result, keeping this forced snapshot.
        bumpSubmoduleSnapshotEpoch(
          submoduleSnapshotSlotKey(
            context.hostId,
            context.runningDir,
            context.ignoreWhitespace,
          ),
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh git status."),
    },
  });
}
