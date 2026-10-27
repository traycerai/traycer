import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAccountFencedMutation } from "@/hooks/sandboxes/use-account-fenced-mutation";
import {
  sandboxDestroyMutationOptions,
  SandboxDestroySkippedError,
} from "@/hooks/sandboxes/use-sandbox-destroy-mutation";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";

/** One target's own outcome: a batch never reports for the set as a whole. */
export type SandboxBatchOutcome =
  | { readonly kind: "destroyed" }
  | { readonly kind: "destroying" }
  | { readonly kind: "skipped"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

export interface SandboxBatchResult {
  readonly sandboxId: string;
  readonly name: string;
  readonly outcome: SandboxBatchOutcome;
}

export interface SandboxBatchTarget {
  readonly hostId: string;
  readonly sandboxId: string;
  readonly name: string;
}

export interface SandboxDestroyBatchRequest {
  readonly targets: readonly SandboxBatchTarget[];
  /** The account signed in when the person confirmed the batch. */
  readonly startedBy: string | null;
}

interface SandboxDestroyBatchContext {
  readonly directory: HostDirectoryService | null;
  readonly userId: string | null;
}

/**
 * `Destroy all idle`: destroys the enumerated rows the confirmation named,
 * one by one, and never more. Each target is re-read at execution: a row
 * that woke or is no longer authorized is skipped rather than destroyed, and a
 * retry passes only failed targets, so it never widens the set. The server
 * rechecks authority per target. Each request carries whoever is signed in
 * when it is sent, so the batch stops before any read or destroy once the
 * account that confirmed it (`startedBy`) is no longer the one signed in.
 */
export function useSandboxDestroyBatch(): UseMutationResult<
  readonly SandboxBatchResult[],
  Error,
  SandboxDestroyBatchRequest,
  SandboxDestroyBatchContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const mutation = useMutation({
    mutationKey: sandboxMutationKeys.destroyBatch(userId),
    onMutate: ({
      startedBy,
    }: SandboxDestroyBatchRequest): SandboxDestroyBatchContext => ({
      directory: binding === null ? null : binding.directory,
      userId: startedBy,
    }),
    mutationFn: async ({
      targets,
      startedBy,
    }: SandboxDestroyBatchRequest): Promise<readonly SandboxBatchResult[]> => {
      if (binding === null) {
        throw new Error("Sign in to destroy these sandboxes.");
      }
      const stopIfAccountChanged = (): void => {
        if (signedInUserId() !== startedBy) {
          throw new Error("The account changed, so the batch stopped.");
        }
      };
      const results: SandboxBatchResult[] = [];
      for (const target of targets) {
        stopIfAccountChanged();
        const mutation = queryClient.getMutationCache().build(queryClient,
          sandboxDestroyMutationOptions({
            id: target.sandboxId,
            hostId: target.hostId,
            displayName: target.name,
          }, binding, queryClient, runnerHost),
        );
        try {
          const gone = await mutation.execute({ idleOnly: true, startedBy });
          results.push({ ...target, outcome: { kind: gone ? "destroyed" : "destroying" } });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Couldn't destroy this sandbox.";
          results.push({ ...target, outcome: {
            kind: error instanceof SandboxDestroySkippedError ? "skipped" : "failed", message,
          } });
        }
      }
      return results;
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
      toastFromAuthError(error, "Couldn't destroy the idle sandboxes.");
    },
  });
  return useAccountFencedMutation(mutation);
}
