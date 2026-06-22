import { useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { gitMutationKeys } from "@/lib/query-keys";
import { writeGitListChangedFilesResponse } from "@/lib/git/write-list-changed-files-response";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface GitRefreshWorktreeStatusVariables {
  readonly hostId: string;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}

interface GitRefreshWorktreeStatusContext {
  readonly hostId: string;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}

type GitListChangedFilesResponse = ResponseOfMethod<
  HostRpcRegistry,
  "git.listChangedFiles"
>;

/**
 * Forces a fresh git.listChangedFiles fetch for a worktree and writes the
 * response into the same cache slot the subscription feeds, so a manual refresh
 * pulls the latest working-tree state on demand instead of waiting for the
 * host's 5s poll. Unlike useGitPrefetchWorktreeStatus there is no cached
 * early-exit: a refresh always hits the host, and the returned promise
 * resolves once the response lands so callers can spin while it is in flight.
 *
 * Q20: response-equals-state carve-out. The RPC response directly reifies the
 * change-list UI state without transformation.
 */
export function useGitRefreshWorktreeStatus(): UseMutationResult<
  GitListChangedFilesResponse,
  HostRpcError,
  GitRefreshWorktreeStatusVariables,
  GitRefreshWorktreeStatusContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();

  return useHostMutation<
    HostRpcRegistry,
    "git.listChangedFiles",
    GitRefreshWorktreeStatusContext,
    GitRefreshWorktreeStatusVariables
  >({
    client,
    method: "git.listChangedFiles",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: gitMutationKeys.refreshWorktreeStatus(),
      onMutate: (variables) => ({
        hostId: variables.hostId,
        runningDir: variables.runningDir,
        ignoreWhitespace: variables.ignoreWhitespace,
      }),
      onSuccess: (data, _variables, context) => {
        writeGitListChangedFilesResponse(queryClient, context, data);
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't refresh git status."),
    },
  });
}
