import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { SANDBOX_REFUSAL_CODE_NOT_FOUND } from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import { authQueryKeys, sandboxMutationKeys } from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useAccountFencedMutation } from "@/hooks/sandboxes/use-account-fenced-mutation";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";

/** One target's own outcome: a batch never reports for the set as a whole. */
export type SandboxBatchOutcome =
  | { readonly kind: "destroyed" }
  | { readonly kind: "destroying" }
  | { readonly kind: "gone" }
  /** No longer an idle agent sandbox when the batch reached it. */
  | { readonly kind: "skipped" }
  | { readonly kind: "failed"; readonly message: string };

export interface SandboxBatchResult {
  readonly sandboxId: string;
  readonly name: string;
  readonly outcome: SandboxBatchOutcome;
}

export interface SandboxBatchTarget {
  readonly sandboxId: string;
  readonly name: string;
}

interface SandboxDestroyBatchContext {
  readonly directory: HostDirectoryService | null;
  readonly userId: string | null;
}

/**
 * `Destroy all idle`: destroys the enumerated rows the confirmation named,
 * one by one, and never more. Each target is re-read at execution: a row
 * that woke or was kept meanwhile is skipped rather than destroyed, and a
 * retry passes the same targets, so it never widens the set. The server
 * rechecks authority per target.
 */
export function useSandboxDestroyBatch(): UseMutationResult<
  readonly SandboxBatchResult[],
  Error,
  readonly SandboxBatchTarget[],
  SandboxDestroyBatchContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const mutation = useMutation({
    mutationKey: sandboxMutationKeys.destroyBatch(userId),
    onMutate: (): SandboxDestroyBatchContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (
      targets: readonly SandboxBatchTarget[],
    ): Promise<readonly SandboxBatchResult[]> => {
      if (binding === null) {
        throw new Error("Sign in to destroy these sandboxes.");
      }
      const listed = await binding.auth.listSandboxes();
      if (listed.kind !== "ok") {
        throw new Error(sandboxFailureMessage(listed));
      }
      const results: SandboxBatchResult[] = [];
      for (const target of targets) {
        const row =
          listed.response.sandboxes.find((s) => s.id === target.sandboxId) ??
          null;
        if (row === null) {
          results.push({ ...target, outcome: { kind: "gone" } });
          continue;
        }
        if (!row.burst || row.frozen || row.state !== "suspended") {
          results.push({ ...target, outcome: { kind: "skipped" } });
          continue;
        }
        const result = await binding.auth.destroySandbox(target.sandboxId);
        if (result.kind === "ok") {
          results.push({
            ...target,
            outcome: { kind: result.settled ? "destroyed" : "destroying" },
          });
        } else if (
          result.kind === "refused" &&
          result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
        ) {
          results.push({ ...target, outcome: { kind: "gone" } });
        } else {
          results.push({
            ...target,
            outcome: { kind: "failed", message: sandboxFailureMessage(result) },
          });
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
    },
    onError: (error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      toastFromAuthError(error, "Couldn't destroy the idle sandboxes.");
    },
  });
  return useAccountFencedMutation(mutation);
}
