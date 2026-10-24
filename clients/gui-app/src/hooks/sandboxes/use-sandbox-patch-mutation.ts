import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxPatchRequest,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAccountFencedMutation } from "@/hooks/sandboxes/use-account-fenced-mutation";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";

/**
 * How a patch ended: `saved`, or `gone` (`404 sandbox_not_found`: the row was
 * destroyed before the save reached it, which the caller says in its own
 * words).
 */
export type SandboxPatchOutcome = "saved" | "gone";

interface SandboxPatchContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the patch started. */
  readonly userId: string | null;
}

/**
 * `PATCH /api/sandboxes/:id` for one sandbox: its name and its idle and
 * resting periods (each `null` in the request leaves that setting as it is;
 * a resting period of `0` is never). Bound to the sandbox at hook level, so a
 * re-render cannot re-point a save already in flight.
 *
 * Settling refreshes the host list, the sandbox list, the fleet and the cost
 * view, as a lifecycle verb does: the name is the host's label, and a changed
 * resting period moves the row's deadline. A caller's per-call callbacks run
 * only for the account that started the save, as the hook's own do.
 */
export function useSandboxPatch(
  sandboxId: string,
): UseMutationResult<
  SandboxPatchOutcome,
  Error,
  SandboxPatchRequest,
  SandboxPatchContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const mutation = useMutation({
    mutationKey: sandboxMutationKeys.patch(sandboxId),
    onMutate: (): SandboxPatchContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (
      request: SandboxPatchRequest,
    ): Promise<SandboxPatchOutcome> => {
      if (binding === null) {
        throw new Error("Sign in to change this sandbox.");
      }
      const result = await binding.auth.patchSandbox(sandboxId, request);
      if (result.kind === "ok") return "saved";
      if (
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
      ) {
        return "gone";
      }
      throw new Error(sandboxFailureMessage(result));
    },
    onSettled: (_data, _error, _request, context) => {
      if (!settledForStartingAccount(context)) return;
      void context.directory?.refresh();
      requestFleetRefresh(runnerHost);
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
      void queryClient.invalidateQueries({
        queryKey: sandboxQueryKeys.costsAll(),
      });
    },
    onError: (error, _request, context) => {
      if (!settledForStartingAccount(context)) return;
      toastFromAuthError(error, "Couldn't save the sandbox's settings.");
    },
  });
  return useAccountFencedMutation(mutation);
}
