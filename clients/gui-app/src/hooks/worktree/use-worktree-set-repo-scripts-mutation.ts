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
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface SetRepoScriptsMutationContext {
  readonly hostId: string | null;
}

// Scripts ride pre-epic workspace summaries and the host worktrees list
// (`WorktreeHostEntry.scripts`, which the Environment footer prefills an
// existing worktree from), so a save must refresh both so the next read
// reflects the edit.
const SET_REPO_SCRIPTS_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = ["worktree.listByWorkspacePaths", "worktree.listAllForHost"];

/**
 * Persists per-repo setup/teardown scripts to `<repoRoot>/.traycer/environment.json`
 * on an EXPLICIT host client (built via `useHostClientFor` /
 * `useTabHostClient` / the active-host binding). The Environment chip passes
 * `epicId: ""` pre-epic - the host resolver is authn-only for the empty epic
 * and editor-gated for a real one - so the same call shape works on the landing
 * page and in an epic.
 *
 * A `null` client makes the mutation a rejecting no-op, matching the other
 * `*For` worktree hooks - `useHostMutation`'s own `client === null` guard
 * covers it.
 */
export function useWorktreeSetRepoScriptsFor(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.setRepoScripts">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.setRepoScripts">,
  SetRepoScriptsMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "worktree.setRepoScripts",
    SetRepoScriptsMutationContext
  >({
    client,
    method: "worktree.setRepoScripts",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: worktreeMutationKeys.setRepoScripts(),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
      }),
      onSuccess: (_data, _variables, mutationContext) => {
        Analytics.getInstance().track(AnalyticsEvent.SetupScriptsSaved, {
          script_count: [_variables.setup, _variables.teardown].filter(
            (script) =>
              Object.values(script).some(
                (command) => command !== null && command.trim().length > 0,
              ),
          ).length,
        });
        if (mutationContext.hostId === null) return;
        for (const method of SET_REPO_SCRIPTS_INVALIDATIONS) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(mutationContext.hostId, method),
          });
        }
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save environment."),
    },
  });
}
