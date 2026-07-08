import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { RevokeAllSessionsResponse } from "@traycer/protocol/auth/devices-sessions";
import type { RevokeAllSessionsFetchResult } from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import type { AuthService } from "@/lib/auth/auth-service";
import { StepUpRequiredError } from "@/lib/auth/step-up-flow";
import { useHostBinding } from "@/lib/host";
import { authMutationKeys, authQueryKeys } from "@/lib/query-keys";

interface RevokeAllSessionsMutationContext {
  readonly auth: AuthService | null;
}

function unwrapRevokeAllSessionsResult(
  result: RevokeAllSessionsFetchResult,
): RevokeAllSessionsResponse {
  if (result.kind === "ok") {
    return result.response;
  }
  if (result.kind === "step-up-required") {
    throw new StepUpRequiredError();
  }
  if (result.kind === "unauthorized") {
    throw new Error("Sign in again to try that.");
  }
  throw new Error("Couldn't reach Traycer to sign out everywhere.");
}

export function useRevokeAllSessions(): UseMutationResult<
  RevokeAllSessionsResponse,
  Error,
  void,
  RevokeAllSessionsMutationContext
> {
  const binding = useHostBinding();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: authMutationKeys.revokeAllSessions(),
    onMutate: (): RevokeAllSessionsMutationContext => ({
      auth: binding === null ? null : binding.auth,
    }),
    mutationFn: async (): Promise<RevokeAllSessionsResponse> => {
      if (binding === null) {
        throw new Error("Sign in to manage sessions.");
      }
      const result = await binding.auth.revokeAllSessions();
      return unwrapRevokeAllSessionsResult(result);
    },
    onSuccess: (_data, _variables, context) => {
      if (context.auth === null) {
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.userSessions(context.auth),
      });
      void queryClient.invalidateQueries({
        queryKey: authQueryKeys.registeredHosts(context.auth),
      });
    },
  });
}
