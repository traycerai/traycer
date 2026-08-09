import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, worktreeMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export interface SetRepoBranchPrefixMutationContext {
  readonly hostId: string | null;
}

// The override rides the pre-epic and epic-scoped workspace summaries
// (`WorktreeWorkspaceSummary.repoBranchPrefix`), so a save must refresh that
// scope for the next read to reflect the edit - mirrors
// `use-worktree-set-repo-scripts-mutation.ts`'s invalidation for the sibling
// concern.
const SET_REPO_BRANCH_PREFIX_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["worktree.listByWorkspacePaths"];

/**
 * Persists (or clears) the repository's worktree branch-prefix override to
 * `<repoRoot>/.traycer/environment.json` on an EXPLICIT host client, mirroring
 * `useWorktreeSetRepoScriptsFor`'s shape exactly: same `epicId`/`workspacePath`
 * authn/target contract, same `null`-client no-op guard via `useHostMutation`.
 *
 * `worktree.setRepoBranchPrefix` is registered off the released floor with
 * `degrade: { kind: "unsupported" }` - callers should gate the affordance with
 * `useHostSupportsMethod` before offering the edit; this hook's `onError`
 * still surfaces `E_HOST_UNSUPPORTED` via the normal toast as a backstop.
 */
export function useWorktreeSetRepoBranchPrefixFor(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.setRepoBranchPrefix">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.setRepoBranchPrefix">,
  SetRepoBranchPrefixMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "worktree.setRepoBranchPrefix",
    SetRepoBranchPrefixMutationContext
  >({
    client,
    method: "worktree.setRepoBranchPrefix",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: worktreeMutationKeys.setRepoBranchPrefix(),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
      }),
      onSuccess: (_data, _variables, mutationContext) => {
        if (mutationContext.hostId === null) return;
        for (const method of SET_REPO_BRANCH_PREFIX_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(mutationContext.hostId, method),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save the branch prefix."),
    },
  });
}
