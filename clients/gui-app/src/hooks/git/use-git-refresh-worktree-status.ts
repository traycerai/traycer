import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  useHostClient,
  useHostDirectory,
  type HostRpcRegistry,
} from "@/lib/host";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
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
 *
 * Rolls a bespoke `useMutation` (rather than `useHostMutation`) because
 * `variables.hostId` in the request body does not route the call
 * (`HostClient.request()` sends through the bound messenger) - the mutation
 * must resolve a transient client for `variables.hostId` inside `mutationFn`,
 * per mutate call, instead of binding one fixed client at hook-render time.
 * Mirrors `useGitListChangedFilesWithSubmodules`'s reasoning for bypassing its
 * wrapper. A host with no reachable client rejects the same way
 * `useHostMutation` does for `client === null`, rather than silently falling
 * back to the app-wide active host.
 */
export function useGitRefreshWorktreeStatus(): UseMutationResult<
  GitListChangedFilesResponse,
  HostRpcError,
  GitRefreshWorktreeStatusVariables,
  GitRefreshWorktreeStatusContext
> {
  const globalClient = useHostClient();
  const directory = useHostDirectory();
  const queryClient = useQueryClient();

  return useMutation<
    GitListChangedFilesResponse,
    HostRpcError,
    GitRefreshWorktreeStatusVariables,
    GitRefreshWorktreeStatusContext
  >(
    withHostMutationLifecycleBoundary("git.listChangedFiles", {
      mutationKey: gitMutationKeys.refreshWorktreeStatus(),
      mutationFn: (variables) =>
        withHostQueryErrorBoundary("git.listChangedFiles", () => {
          const entry = directory.findById(variables.hostId);
          const client =
            entry === null
              ? null
              : buildTransientHostClient(globalClient, entry);
          if (client === null) {
            return Promise.reject<GitListChangedFilesResponse>(
              hostClientUnavailableError("git.listChangedFiles"),
            );
          }
          // Parent-only: this refresh feeds the v1.0 change-list slot; the nested
          // snapshot has its own invalidation path.
          return client.request("git.listChangedFiles", {
            hostId: variables.hostId,
            runningDir: variables.runningDir,
            ignoreWhitespace: variables.ignoreWhitespace,
            includeSubmodules: false,
          });
        }),
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
    }),
  );
}
