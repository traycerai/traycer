import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { writeProfileCopyDraftOutcome } from "@/hooks/providers/profile-copy/profile-copy-cache";
import { profileCopyMutationKeys } from "@/lib/query-keys";
import type { ProfileCopyAttempt } from "@/lib/profile-copy/profile-copy-model";

/**
 * Draft verbs, served by the DESTINATION that holds the draft. Every request
 * carries the revision the user was shown; a `stale-revision` answer is shown
 * as "this changed" and never sent again on the user's behalf.
 */

type DraftMutation<Method extends keyof HostRpcRegistry & string> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>
  >;

export function useProfileCopyVerifyMutation(
  attempt: ProfileCopyAttempt,
): DraftMutation<"providers.profileCopy.verify"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.verify">({
    client,
    method: "providers.profileCopy.verify",
    options: {
      mutationKey: profileCopyMutationKeys.verify(
        attempt.destinationHostId,
        attempt.attemptId,
      ),
      onSuccess: (response) => {
        writeProfileCopyDraftOutcome(queryClient, response.outcome);
      },
    },
    mapVariables: (variables) => variables,
  });
}

export function useProfileCopyConfirmVerificationMutation(
  attempt: ProfileCopyAttempt,
): DraftMutation<"providers.profileCopy.confirmVerification"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.confirmVerification"
  >({
    client,
    method: "providers.profileCopy.confirmVerification",
    options: {
      mutationKey: profileCopyMutationKeys.confirmVerification(
        attempt.destinationHostId,
        attempt.attemptId,
      ),
      onSuccess: (response) => {
        writeProfileCopyDraftOutcome(queryClient, response.outcome);
      },
    },
    mapVariables: (variables) => variables,
  });
}

export function useProfileCopyConfirmIdentityMutation(
  attempt: ProfileCopyAttempt,
): DraftMutation<"providers.profileCopy.confirmIdentity"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.confirmIdentity"
  >({
    client,
    method: "providers.profileCopy.confirmIdentity",
    options: {
      mutationKey: profileCopyMutationKeys.confirmIdentity(
        attempt.destinationHostId,
        attempt.attemptId,
      ),
      onSuccess: (response) => {
        writeProfileCopyDraftOutcome(queryClient, response.outcome);
      },
    },
    mapVariables: (variables) => variables,
  });
}

/** The desired-enabled preference. It never grants readiness. */
export function useProfileCopySetPreferenceMutation(
  attempt: ProfileCopyAttempt,
): DraftMutation<"providers.profileCopy.setPreference"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.setPreference"
  >({
    client,
    method: "providers.profileCopy.setPreference",
    options: {
      mutationKey: profileCopyMutationKeys.setPreference(
        attempt.destinationHostId,
        attempt.attemptId,
      ),
      onSuccess: (response) => {
        writeProfileCopyDraftOutcome(queryClient, response.outcome);
      },
    },
    mapVariables: (variables) => variables,
  });
}

/** Cancels this one destination's draft. Nothing already on it is removed. */
export function useProfileCopyCancelDraftMutation(
  attempt: ProfileCopyAttempt,
): DraftMutation<"providers.profileCopy.cancelDraft"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.cancelDraft">({
    client,
    method: "providers.profileCopy.cancelDraft",
    options: {
      mutationKey: profileCopyMutationKeys.cancelDraft(
        attempt.destinationHostId,
        attempt.attemptId,
      ),
      onSuccess: (response) => {
        writeProfileCopyDraftOutcome(queryClient, response.outcome);
      },
    },
    mapVariables: (variables) => variables,
  });
}
