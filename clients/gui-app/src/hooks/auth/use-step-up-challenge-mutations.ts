import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { StepUpChallengeResponse } from "@traycer/protocol/auth/devices-sessions";
import type {
  RetainedStepUpVerifyResponse,
  StepUpChallengeFetchResult,
  RetainedStepUpVerifyFetchResult,
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
  result: RetainedStepUpVerifyFetchResult,
): RetainedStepUpVerifyResponse {
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
  RetainedStepUpVerifyResponse,
  Error,
  string
> {
  const binding = useHostBinding();
  return useMutation({
    mutationKey: authMutationKeys.verifyStepUpChallenge(),
    mutationFn: async (code: string): Promise<RetainedStepUpVerifyResponse> => {
      if (binding === null) {
        throw new Error("Sign in again to verify this action.");
      }
      return unwrapStepUpVerifyResult(
        await binding.auth.verifyStepUpChallenge(code),
      );
    },
  });
}
