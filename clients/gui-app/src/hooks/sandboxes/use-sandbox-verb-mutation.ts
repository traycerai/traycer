import { useRef } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  type SandboxLifecycleVerb,
} from "@traycer/protocol/host/sandbox-control";
import { SANDBOX_VERB_FETCH_TIMEOUT_MS } from "@traycer-clients/shared/host-client/sandbox-control";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import { requestFleetRefresh } from "@/lib/host/fleet-refresh";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAccountFencedMutation } from "@/hooks/sandboxes/use-account-fenced-mutation";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import { SandboxOperationError } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";

/**
 * How a verb ended: `settled` (`200`, at rest, with the state the row reached,
 * which need not be the verb's own: a suspend can land `stopped`), `moving`
 * (`202`, still moving at the server's deadline), or `gone`
 * (`404 sandbox_not_found`: the row was destroyed while the verb waited,
 * typically by the card's own Destroy - nothing to report, the destroy
 * already said it).
 */
export type SandboxVerbOutcome =
  | { readonly kind: "settled"; readonly state: HostSandboxState | null }
  | { readonly kind: "moving" }
  | { readonly kind: "gone" };

interface SandboxVerbContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the verb started. */
  readonly userId: string | null;
}

/**
 * `POST /api/sandboxes/:id/{suspend,resume,stop,start}` for one sandbox, the
 * card's lifecycle actions. Bound to the sandbox at hook level, so a
 * re-render cannot re-point a verb already in flight. `useSandboxOperation`
 * observes every caller's mutation for this sandbox, including confirmations.
 *
 * Resolves to a {@link SandboxVerbOutcome}. `202` (still moving at the
 * server's deadline) and a `404` for a row destroyed meanwhile are success
 * too: the list's next read shows where it landed. Success refreshes the
 * host list, the sandbox list, the fleet and the cost view (the burn moved),
 * as a destroy does. A caller's per-call callbacks run only for the account
 * that started the verb, as the hook's own do.
 */
export function useSandboxVerb(
  sandboxId: string,
): UseMutationResult<
  SandboxVerbOutcome,
  Error,
  SandboxLifecycleVerb,
  SandboxVerbContext
> {
  const { mutationFn, ...options } = useSandboxVerbOptions(sandboxId);
  const mutation = useMutation({
    ...options,
    mutationFn: (verb: SandboxLifecycleVerb) => mutationFn(verb, null),
  });
  return useAccountFencedMutation(mutation);
}

interface PendingSandboxStopIssue {
  readonly sandboxId: string;
  readonly hostId: string;
  readonly verify: () => Promise<boolean>;
  readonly isCurrent: () => boolean;
}

interface PendingSandboxStopMutation {
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly stop: (issue: PendingSandboxStopIssue) => Promise<SandboxVerbOutcome>;
}

export function usePendingSandboxStop(
  sandboxId: string,
): PendingSandboxStopMutation {
  const issue = useRef<PendingSandboxStopIssue | null>(null);
  const mutation = usePressCapturedMutation<
    SandboxVerbOutcome,
    Error,
    SandboxLifecycleVerb,
    PendingSandboxStopIssue | null,
    SandboxVerbContext
  >(() => issue.current, useSandboxVerbOptions(sandboxId));
  return {
    isPending: mutation.isPending,
    error: mutation.error,
    stop: (pressed) => {
      issue.current = pressed;
      try {
        return mutation.mutateAsync("stop");
      } finally {
        issue.current = null;
      }
    },
  };
}

function useSandboxVerbOptions(sandboxId: string) {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  return {
    mutationKey: sandboxMutationKeys.verb(sandboxId),
    onMutate: (): SandboxVerbContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async (
      verb: SandboxLifecycleVerb,
      issue: PendingSandboxStopIssue | null,
    ): Promise<SandboxVerbOutcome> => {
      if (binding === null) {
        throw new Error("Sign in to change this sandbox.");
      }
      if (issue !== null) {
        if (issue.sandboxId !== sandboxId || !issue.isCurrent())
          throw new Error("The pending stop no longer owns this sandbox.");
        const row = await binding.auth.getSandbox(sandboxId);
        if (!(await issue.verify()) || !issue.isCurrent())
          throw new Error("The pending stop no longer owns this sandbox.");
        if (
          row.kind === "refused" &&
          row.status === 404 &&
          row.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
        )
          return { kind: "gone" };
        if (
          row.kind !== "ok" ||
          row.sandbox.id !== sandboxId ||
          row.sandbox.hostId !== issue.hostId
        )
          throw new Error("The pending stop could not verify the sandbox.");
        if (row.sandbox.state === "stopped" || row.sandbox.state === "suspended")
          return { kind: "settled", state: row.sandbox.state };
      }
      const result = await binding.auth.runSandboxVerb(
        sandboxId,
        verb,
        null,
        SANDBOX_VERB_FETCH_TIMEOUT_MS,
      );
      if (result.kind === "ok") {
        return result.settled
          ? { kind: "settled", state: result.state }
          : { kind: "moving" };
      }
      if (
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND
      ) {
        return { kind: "gone" };
      }
      throw new SandboxOperationError(result);
    },
    onSettled: (
      _data: SandboxVerbOutcome | undefined,
      _error: Error | null,
      _verb: SandboxLifecycleVerb,
      context: SandboxVerbContext | undefined,
    ): void => {
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
  };
}
