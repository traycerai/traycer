import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxLifecycleVerb,
} from "@traycer/protocol/host/sandbox-control";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/hooks/sandboxes/sandbox-mutation-account";

/**
 * How a verb ended: `settled` (`200`, at rest), `moving` (`202`, still
 * moving at the server's deadline), or `gone` (`404 sandbox_not_found`: the
 * row was destroyed while the verb waited, typically by the card's own
 * Destroy - nothing to report, the destroy already said it).
 */
export type SandboxVerbOutcome = "settled" | "moving" | "gone";

interface SandboxVerbContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the verb started. */
  readonly userId: string | null;
}

const VERB_FAILURE_TITLE: Record<SandboxLifecycleVerb, string> = {
  suspend: "Couldn't suspend the sandbox.",
  resume: "Couldn't resume the sandbox.",
  stop: "Couldn't stop the sandbox.",
  start: "Couldn't start the sandbox.",
};

/**
 * `POST /api/sandboxes/:id/{suspend,resume,stop,start}` for one sandbox, the
 * card's lifecycle actions. Bound to the sandbox at hook level, so a
 * re-render cannot re-point a verb already in flight; one mutation key per
 * sandbox, so the card disables the other verbs while any one runs.
 *
 * Resolves to a {@link SandboxVerbOutcome}. `202` (still moving at the
 * server's deadline) and a `404` for a row destroyed meanwhile are success
 * too: the list's next read shows where it landed. Success refreshes the
 * host list, the sandbox list, the fleet and the cost view (the burn moved),
 * as a destroy does.
 */
export function useSandboxVerb(
  sandboxId: string,
): UseMutationResult<
  SandboxVerbOutcome,
  Error,
  SandboxLifecycleVerb,
  SandboxVerbContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  return useMutation({
    mutationKey: sandboxMutationKeys.verb(sandboxId),
    onMutate: (): SandboxVerbContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (
      verb: SandboxLifecycleVerb,
    ): Promise<SandboxVerbOutcome> => {
      if (binding === null) {
        throw new Error("Sign in to change this sandbox.");
      }
      const result = await binding.auth.runSandboxVerb(
        sandboxId,
        verb,
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      );
      if (result.kind === "ok") return result.settled ? "settled" : "moving";
      if (
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
      ) {
        return "gone";
      }
      throw new Error(sandboxFailureMessage(result));
    },
    onSettled: (_data, _error, _verb, context) => {
      // Settled, not success: a `sandbox_busy` refusal puts the row back to
      // `awake` and a conflict means it moved, so the lists are stale either
      // way.
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
    onError: (error, verb, context) => {
      if (!settledForStartingAccount(context)) return;
      toastFromAuthError(error, VERB_FAILURE_TITLE[verb]);
    },
  });
}
