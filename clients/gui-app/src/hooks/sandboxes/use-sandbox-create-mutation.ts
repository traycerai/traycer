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
import {
  sandboxCreateOpenIdNow,
  sandboxCreateOpenIsCurrent,
  useSandboxCreateDialogStore,
} from "@/stores/settings/sandbox-create-dialog-store";

/**
 * What the form submits: the request, and the team's name when it belongs to
 * a team, so a refusal can name it (the server names no team).
 */
export interface SandboxCreateSubmit {
  readonly request: SandboxCreateRequest;
  readonly teamName: string | null;
  /** The team it is created for, `null` for Personal. */
  readonly teamId: string | null;
}

/**
 * A refused create, carrying the server's refusal `code` and its `reason`
 * (`null` for a failure with none) so the form can answer
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
  /** The dialog open that sent it, `null` when no dialog was open. */
  readonly openId: number | null;
}

/**
 * `POST /api/sandboxes` from the create form. The server answers `202` once
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
      openId: sandboxCreateOpenIdNow(),
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
    // At hook level, not the form's `mutate` call: the form unmounts when the
    // dialog closes, and a create can take minutes, so only the mutation
    // itself is still there to say it finished.
    // The open that sent it closes, or offers the team task, from here rather
    // than from the form's own `mutate` callback: that callback is dropped
    // when the form remounted while the create ran (F46).
    onSuccess: (accepted, { request, teamId }, context) => {
      if (!settledForStartingAccount(context)) return;
      toast.success(`Created ${request.displayName}`);
      if (sandboxCreateOpenIsCurrent(context.openId)) {
        useSandboxCreateDialogStore
          .getState()
          .setCreated({ hostId: accepted.hostId, teamId });
      }
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
      // environment, read once per session, is read again so the form
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
    // The open that sent it says it, beside the values that were sent (F46);
    // a create that outlived its open, closed or replaced by a new one, toasts.
    onError: (error, _variables, context) => {
      if (!settledForStartingAccount(context)) return;
      if (sandboxCreateOpenIsCurrent(context.openId)) {
        useSandboxCreateDialogStore.getState().setFailure({
          message:
            error instanceof SandboxCreateError
              ? error.message
              : "Couldn't create the sandbox. Try again.",
          code: error instanceof SandboxCreateError ? error.code : null,
        });
        return;
      }
      toastFromAuthError(error, "Couldn't create the sandbox.");
    },
  });
}
