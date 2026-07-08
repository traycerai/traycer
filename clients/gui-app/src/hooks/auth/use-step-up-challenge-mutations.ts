import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type {
  StepUpChallengeResponse,
  VerifyStepUpResponse,
} from "@traycer/protocol/auth/devices-sessions";
import type {
  StepUpChallengeFetchResult,
  StepUpVerifyFetchResult,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import { useHostBinding } from "@/lib/host";
import { authMutationKeys } from "@/lib/query-keys";

function unwrapStepUpChallengeResult(
  result: StepUpChallengeFetchResult,
): StepUpChallengeResponse {
  if (result.kind === "ok") {
    return result.response;
  }
  if (result.kind === "unauthorized") {
    throw new Error("Sign in again to verify this action.");
  }
  throw new Error("Couldn't send a verification code. Try again.");
}

function unwrapStepUpVerifyResult(
  result: StepUpVerifyFetchResult,
): VerifyStepUpResponse {
  if (result.kind === "ok") {
    return result.response;
  }
  if (result.kind === "invalid") {
    throw new Error("Invalid or expired verification code.");
  }
  if (result.kind === "unauthorized") {
    throw new Error("Sign in again to verify this action.");
  }
  throw new Error("Couldn't verify that code. Try again.");
}

export function useRequestStepUpChallenge(): UseMutationResult<
  StepUpChallengeResponse,
  Error,
  void
> {
  const binding = useHostBinding();
  return useMutation({
    mutationKey: authMutationKeys.requestStepUpChallenge(),
    mutationFn: async (): Promise<StepUpChallengeResponse> => {
      if (binding === null) {
        throw new Error("Sign in again to verify this action.");
      }
      return unwrapStepUpChallengeResult(
        await binding.auth.requestStepUpChallenge(),
      );
    },
  });
}

export function useVerifyStepUpChallenge(): UseMutationResult<
  VerifyStepUpResponse,
  Error,
  string
> {
  const binding = useHostBinding();
  return useMutation({
    mutationKey: authMutationKeys.verifyStepUpChallenge(),
    mutationFn: async (code: string): Promise<VerifyStepUpResponse> => {
      if (binding === null) {
        throw new Error("Sign in again to verify this action.");
      }
      return unwrapStepUpVerifyResult(
        await binding.auth.verifyStepUpChallenge(code),
      );
    },
  });
}
