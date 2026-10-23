import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  type SandboxCreateAccepted,
  type SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import { sandboxCreateFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * What a create sends: the request, and the team's name when it belongs to
 * a team, so a refusal can name it (the server names no team).
 */
export interface SandboxCreateSubmit {
  readonly request: SandboxCreateRequest;
  readonly teamName: string | null;
}

/**
 * A refused create, carrying the server's refusal `code` and its `reason`
 * (`null` for a failure with none) so a caller can answer
 * `insufficient_credit` on a team pick with the capacity line rather than
 * only a toast.
 */
export class SandboxCreateError extends Error {
  readonly code: string | null;
  readonly reason: string | null;

  constructor(message: string, code: string | null, reason: string | null) {
    super(message);
    this.name = "SandboxCreateError";
    this.code = code;
    this.reason = reason;
  }
}

interface SandboxCreateContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the create started. */
  readonly userId: string | null;
}

/**
 * `POST /api/sandboxes` for a failed row's Retry. The server answers `202` once
 * the sandbox is created and its host is enrolling (the request can take
 * minutes: provider capacity, boot, boot-token delivery); the sandbox then
 * appears in the host list and the sandbox list, so the end of the request
 * refreshes both (one prefix covers both, see `sandboxQueryKeys.list`) and
 * the directory.
 */
export function useSandboxCreate(): UseMutationResult<
  SandboxCreateAccepted,
  Error,
  SandboxCreateSubmit,
  SandboxCreateContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  // The account the sandbox list and costs are keyed by.
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  return useMutation({
    mutationKey: sandboxMutationKeys.create(userId),
    onMutate: (): SandboxCreateContext => ({
      directory: binding === null ? null : binding.directory,
      userId: signedInUserId(),
    }),
    mutationFn: async ({
      request,
      teamName,
    }): Promise<SandboxCreateAccepted> => {
      if (binding === null) {
        throw new SandboxCreateError(
          "Sign in to create a sandbox.",
          null,
          null,
        );
      }
      const result = await binding.auth.createSandbox(request);
      if (result.kind === "ok") {
        return result.accepted;
      }
      throw new SandboxCreateError(
        sandboxCreateFailureMessage(result, teamName),
        result.kind === "refused" ? result.code : null,
        result.kind === "refused" ? result.reason : null,
      );
    },
    onSuccess: (_accepted, { request }, context) => {
      if (!settledForStartingAccount(context)) return;
      toast.success(`Created ${request.displayName}`);
    },
    // Settled, not only success: a `502 provider_failed` leaves a `failed`
    // row behind, which the lists must show so it can be destroyed.
    onSettled: (_data, error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      void context.directory?.refresh();
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHostsAll(),
      });
      // The server says the person is no longer in the team: the team's
      // environment, read once per session, is read again so the next create
      // answers from membership rather than from the stale id.
      if (
        error instanceof SandboxCreateError &&
        error.code === SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND
      ) {
        void queryClient.invalidateQueries({
          queryKey: sandboxQueryKeys.teamEnvironmentAll(),
        });
      }
    },
    onError: (error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      if (error instanceof SandboxCreateError) {
        toast.error(error.message);
        return;
      }
      toastFromAuthError(error, "Couldn't create the sandbox.");
    },
  });
}
