import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseMutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT,
  type SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type { SandboxControlFailure } from "@traycer-clients/shared/host-client/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";
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

/** A batch retry retains its idle-only constraint and confirming account. */
export type SandboxDestroyRequest = void | {
  readonly idleOnly: true;
  readonly startedBy: string | null;
};

export class SandboxDestroySkippedError extends Error {
  constructor(reason: "idle" | "authority") {
    super(
      reason === "idle"
        ? "no longer idle, left as it is"
        : "no longer available to destroy, left as it is",
    );
    this.name = "SandboxDestroySkippedError";
  }
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
): UseMutationResult<
  boolean,
  Error,
  SandboxDestroyRequest,
  SandboxDestroyContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  const runnerHost = useRunnerHost();
  const mutation = useMutation(
    sandboxDestroyMutationOptions(sandbox, binding, queryClient, runnerHost),
  );
  return useAccountFencedMutation(mutation);
}

/** Shared by single-row Destroy and every individually observed batch target. */
export function sandboxDestroyMutationOptions(
  sandbox: Pick<SandboxSummary, "id" | "hostId" | "displayName">,
  binding: HostRuntimeBinding<HostRpcRegistry> | null,
  queryClient: QueryClient,
  runnerHost: IRunnerHost,
): UseMutationOptions<
  boolean,
  Error,
  SandboxDestroyRequest,
  SandboxDestroyContext
> {
  const sandboxId = sandbox.id;
  return {
    mutationKey: sandboxMutationKeys.destroy(sandboxId),
    onMutate: (request): SandboxDestroyContext => ({
      directory: binding === null ? null : binding.directory,
      userId: request === undefined ? signedInUserId() : request.startedBy,
    }),
    mutationFn: async (request): Promise<boolean> => {
      if (binding === null) {
        throw new Error("Sign in to destroy this sandbox.");
      }
      const target =
        request === undefined
          ? sandbox
          : await readIdleDestroyTarget(
              binding.auth,
              sandboxId,
              request.startedBy,
            );
      const viewer = signedInUserId();
      if (viewer !== null) {
        recordEndedSandboxHost(target.hostId, {
          name: target.displayName,
          at: Date.now(),
          actor: { userId: viewer, displayName: null },
        });
      }
      const result = await binding.auth.destroySandbox(
        sandboxId,
        request !== undefined,
      );
      // Ordinary Destroy is idempotent on a 404. A guarded batch cannot tell
      // an already destroyed row from lost authority, so it records a skip.
      if (result.kind === "ok") return result.settled;
      if (
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_NOT_FOUND &&
        request === undefined
      ) {
        return true;
      }
      forgetEndedSandboxHost(target.hostId);
      if (request !== undefined && isAuthorityFailure(result)) {
        throw new SandboxDestroySkippedError("authority");
      }
      if (
        request !== undefined &&
        result.kind === "refused" &&
        result.code === SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT
      ) {
        throw new SandboxDestroySkippedError("idle");
      }
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
      if (error instanceof SandboxDestroySkippedError) {
        void queryClient.invalidateQueries({
          queryKey: authQueryKeys.registeredHostsAll(),
        });
        return;
      }
      toastFromAuthError(error, "Couldn't destroy the sandbox.");
    },
  };
}

/** Recheck each batch target through the current account's authorized list. */
async function readIdleDestroyTarget(
  auth: Pick<AuthService, "listSandboxes">,
  sandboxId: string,
  startedBy: string | null,
): Promise<SandboxSummary> {
  if (signedInUserId() !== startedBy)
    throw new SandboxDestroySkippedError("authority");
  const listed = await auth.listSandboxes();
  // A sign-in can change while the authenticated read is in flight.
  if (signedInUserId() !== startedBy)
    throw new SandboxDestroySkippedError("authority");
  if (listed.kind !== "ok") {
    if (isAuthorityFailure(listed))
      throw new SandboxDestroySkippedError("authority");
    throw new SandboxOperationError(listed);
  }
  const row = listed.response.sandboxes.find(
    (candidate) => candidate.id === sandboxId,
  );
  if (row === undefined || row.kind === "automation")
    throw new SandboxDestroySkippedError("authority");
  if (row.frozen || (row.state !== "suspended" && row.state !== "stopped")) {
    throw new SandboxDestroySkippedError("idle");
  }
  return row;
}

function isAuthorityFailure(failure: SandboxControlFailure): boolean {
  return (
    failure.kind === "unauthorized" ||
    (failure.kind === "refused" &&
      (failure.status === 403 || failure.status === 404))
  );
}
