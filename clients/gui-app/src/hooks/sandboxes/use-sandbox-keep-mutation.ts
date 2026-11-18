import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { SANDBOX_REFUSAL_CODE_NOT_FOUND } from "@traycer/protocol/host/sandbox-control";
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
 * How a keep ended: `kept`, or `gone` (`404 sandbox_not_found`: the row was
 * destroyed first, typically by its own idle timer racing the keep, which the
 * caller says in its own words).
 */
export type SandboxKeepOutcome = "kept" | "gone";

interface SandboxKeepContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the keep started. */
  readonly userId: string | null;
}

/**
 * `POST /api/sandboxes/:id/keep` for one sandbox an agent created: it stops
 * being destroyed when idle and waits for its owner, with the configuration's
 * idle and resting defaults. Bound to the sandbox at hook level, so a
 * re-render cannot re-point a keep already in flight.
 *
 * Settling refreshes the host list, the sandbox list, the fleet and the cost
 * view, as a lifecycle verb does: a kept sandbox joins the pickers. A
 * caller's per-call callbacks run only for the account that started the keep,
 * as the hook's own do.
 */
export function useSandboxKeep(
  sandboxId: string,
): UseMutationResult<SandboxKeepOutcome, Error, void, SandboxKeepContext> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const mutation = useMutation({
    mutationKey: sandboxMutationKeys.keep(sandboxId),
    onMutate: (): SandboxKeepContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (): Promise<SandboxKeepOutcome> => {
      if (binding === null) {
        throw new Error("Sign in to keep this sandbox.");
      }
      const result = await binding.auth.keepSandbox(sandboxId);
      if (result.kind === "ok") return "kept";
      if (
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
      ) {
        return "gone";
      }
      throw new Error(sandboxFailureMessage(result));
    },
    onSettled: (_data, _error, _variables, context) => {
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
    onError: (error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      toastFromAuthError(error, "Couldn't keep the sandbox.");
    },
  });
  return useAccountFencedMutation(mutation);
}
