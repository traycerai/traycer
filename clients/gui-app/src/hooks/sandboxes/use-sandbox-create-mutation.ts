import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import {
  SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_NOT_FOUND,
  SANDBOX_REFUSAL_CODE_PROVIDER_FAILED,
  type SandboxCreateAccepted,
  type SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding, type HostDirectoryService } from "@/lib/host";
import {
  authQueryKeys,
  sandboxMutationKeys,
  sandboxQueryKeys,
} from "@/lib/query-keys";
import {
  sandboxCreateFailureMessage,
  sandboxFailureMessageFor,
  sandboxFailureCodeMessage,
} from "@/hooks/sandboxes/sandbox-failure-copy";
import {
  settledForStartingAccount,
  signedInUserId,
} from "@/lib/sandboxes/sandbox-account-fence";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  sandboxCreateKey,
  sandboxCreateKeyForPress,
} from "@/lib/sandboxes/sandbox-create-key";

/**
 * What a create sends: the request, and the team's name when it belongs to
 * a team, so a refusal can name it (the server names no team).
 */
export interface SandboxCreateSubmit {
  readonly request: SandboxCreateRequest;
  readonly teamName: string | null;
  /** Keeps the originating failed-row button pending while the press walks. */
  readonly sourceSandboxId?: string;
}

/**
 * A refused create, carrying the server's refusal code for cache invalidation.
 */
export class SandboxCreateError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly failedSandboxId: string | null,
    readonly startKey: string | null,
  ) {
    super(message);
    this.name = "SandboxCreateError";
  }
}

export function sandboxCreatePressKey(
  baseKey: string,
  error: Error | null,
): string {
  return error instanceof SandboxCreateError
    ? sandboxCreateKeyForPress(baseKey, error.failedSandboxId, error.startKey)
    : baseKey;
}

/** One press can pass previous destroyed attempts and reserve at most one row. */
async function walkSandboxCreate(
  auth: AuthService,
  request: SandboxCreateRequest,
  userId: string | null,
): Promise<SandboxCreateFetchResult> {
  const walked = new Set<string | null>();
  let clientRequestId = request.clientRequestId;
  while (signedInUserId() === userId) {
    walked.add(clientRequestId);
    const result = await auth.createSandbox({ ...request, clientRequestId });
    if (
      result.kind !== "ok" ||
      result.joined !== true ||
      result.accepted.sandbox.state !== "destroyed" ||
      result.accepted.sandbox.failureCode === "credit-gate"
    ) {
      return result;
    }
    const next = sandboxCreateKey("retry", result.accepted.sandboxId);
    // A repeated key cannot advance the walk, even if the response was stale.
    if (walked.has(next)) return result;
    clientRequestId = next;
  }
  return { kind: "unauthorized" };
}

interface SandboxCreateContext {
  readonly directory: HostDirectoryService | null;
  /** The account signed in when the create started. */
  readonly userId: string | null;
}

/**
 * Where a failed create says why: a `toast`, or `inline`, where the caller
 * draws the error's message beside the control that sent it.
 */
export type SandboxCreateRefusals = "toast" | "inline";

/**
 * `POST /api/sandboxes` for a failed row's Retry and a team's Enable cloud.
 * The server answers `202` once the sandbox is created and its host is
 * enrolling (the request can take minutes: provider capacity, boot,
 * boot-token delivery); the sandbox then appears in the host list and the
 * sandbox list, so the end of the request refreshes both (one prefix covers
 * both, see `sandboxQueryKeys.list`) and the directory.
 */
export function useSandboxCreate(
  refusals: SandboxCreateRefusals,
  buysTeamCredits: boolean,
): UseMutationResult<
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
          request.clientRequestId,
        );
      }
      const result = await walkSandboxCreate(binding.auth, request, userId);
      if (result.kind === "ok") {
        const { accepted } = result;
        const { state } = accepted.sandbox;
        if (state !== "destroyed" && state !== "failed") return accepted;
        const code =
          state === "failed"
            ? SANDBOX_REFUSAL_CODE_PROVIDER_FAILED
            : SANDBOX_REFUSAL_CODE_NOT_FOUND;
        throw new SandboxCreateError(
          sandboxFailureCodeMessage(code),
          code,
          accepted.sandboxId,
          request.clientRequestId,
        );
      }
      // A refusal for the team's credits tells only a buyer how much to add.
      throw new SandboxCreateError(
        sandboxFailureMessageFor(
          result,
          sandboxCreateFailureMessage(result, teamName),
          { buysTeamCredits, teamName },
        ),
        result.kind === "refused" ? result.code : null,
        result.kind === "refused" ? (result.sandboxId ?? null) : null,
        request.clientRequestId,
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
      if (refusals === "inline" || !settledForStartingAccount(context)) return;
      if (error instanceof SandboxCreateError) {
        toast.error(error.message);
        return;
      }
      toastFromAuthError(error, "Couldn't create the sandbox.");
    },
  });
}
