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
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
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

/** Always hits the host; resolve a transient client for variables.hostId inside mutationFn (hostId in the body does not route).
 * A missing client rejects like useHostMutation, never falling back to the app-wide host. */
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
              : buildDialableHostClient(globalClient, entry);
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
