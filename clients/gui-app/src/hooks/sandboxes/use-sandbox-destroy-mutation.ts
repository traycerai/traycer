import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAccountFencedMutation } from "@/hooks/sandboxes/use-account-fenced-mutation";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import {
  forgetEndedSandboxHost,
  recordEndedSandboxHost,
} from "@/stores/sandboxes/ended-sandbox-hosts-store";

interface SandboxDestroyContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the destroy started. */
  readonly userId: string | null;
}

/**
 * `DELETE /api/sandboxes/:id`, scoped to one sandbox (bound at hook
 * level, so a re-render cannot re-point a destroy already in flight). Final:
 * the disk goes with it, which the confirmation at the call site says. A
 * `202` (still destroying) is success too: the row says `destroying` until
 * the list drops it.
 *
 * Resolves to whether the row is gone (`200`, or `404 sandbox_not_found`);
 * `false` for a `202`, the row still `destroying`.
 *
 * The destroy is recorded as the viewer's before it is sent, since the host's
 * session can end before the answer lands; a failed one is forgotten.
 *
 * Success refreshes the host list, the sandbox list and the selection fleet,
 * for the reason `useDeregisterHostFromAccount` refreshes all three: the whole
 * visible effect is the row's absence. A caller's per-call callbacks run only
 * for the account that started the destroy, as the hook's own do.
 */
export function useSandboxDestroy(
  sandbox: Pick<SandboxSummary, "id" | "hostId" | "displayName">,
): UseMutationResult<boolean, Error, void, SandboxDestroyContext> {
  const sandboxId = sandbox.id;
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const mutation = useMutation({
    mutationKey: sandboxMutationKeys.destroy(sandboxId),
    onMutate: (): SandboxDestroyContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (): Promise<boolean> => {
      if (binding === null) {
        throw new Error("Sign in to destroy this sandbox.");
      }
      const viewer = signedInUserId();
      if (viewer !== null) {
        recordEndedSandboxHost(sandbox.hostId, {
          name: sandbox.displayName,
          at: Date.now(),
          actor: { userId: viewer, displayName: null },
        });
      }
      const result = await binding.auth.destroySandbox(sandboxId);
      // `404 sandbox_not_found` resolves too: the user's intent ("this
      // sandbox should not exist") already holds - destroyed from another
      // window, or by its own idle timer.
      if (result.kind === "ok") return result.settled;
      if (
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
      ) {
        return true;
      }
      forgetEndedSandboxHost(sandbox.hostId);
      throw new SandboxOperationError(result);
    },
    onSuccess: (_data, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      void context.directory?.refresh();
      requestFleetRefresh(runnerHost);
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
    },
    onError: (error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      toastFromAuthError(error, "Couldn't destroy the sandbox.");
    },
  });
  return useAccountFencedMutation(mutation);
}
