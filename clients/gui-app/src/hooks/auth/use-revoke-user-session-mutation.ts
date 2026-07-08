import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { RevokeUserSessionResponse } from "@traycer/protocol/auth/devices-sessions";
import type { RevokeUserSessionFetchResult } from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import type { AuthService } from "@/lib/auth/auth-service";
import { StepUpRequiredError } from "@/lib/auth/step-up-flow";
import { useHostBinding } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";

export interface RevokeUserSessionInput {
  readonly familyId: string;
  readonly stepUpAccessToken: string | null;
}

interface RevokeUserSessionMutationContext {
  readonly auth: AuthService | null;
}

function unwrapRevokeUserSessionResult(
  result: RevokeUserSessionFetchResult,
): RevokeUserSessionResponse {
  if (result.kind === "ok") {
    return result.response;
  }
  if (result.kind === "step-up-required") {
    throw new StepUpRequiredError();
  }
  if (result.kind === "not-found") {
    throw new Error("This session is no longer available.");
  }
  if (result.kind === "unauthorized") {
    throw new Error("Sign in again to try that.");
  }
  throw new Error("Couldn't reach Traycer to sign out this session.");
}

export function useRevokeUserSession(
  familyId: string,
): UseMutationResult<
  RevokeUserSessionResponse,
  Error,
  RevokeUserSessionInput,
  RevokeUserSessionMutationContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: authMutationKeys.revokeUserSession(familyId),
    onMutate: (): RevokeUserSessionMutationContext => ({
      auth: binding === null ? null : binding.auth,
    }),
    mutationFn: async (
      input: RevokeUserSessionInput,
    ): Promise<RevokeUserSessionResponse> => {
      if (binding === null) {
        throw new Error("Sign in to manage sessions.");
      }
      const result = await binding.auth.revokeUserSession(
        input.familyId,
        input.stepUpAccessToken,
      );
      return unwrapRevokeUserSessionResult(result);
    },
    onSuccess: (_data, _variables, context) => {
      if (context.auth === null) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.userSessions(context.auth),
      });
    },
  });
}
