import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useHostMutation,
  useHostMutationWithResponseTimeout,
} from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { writeProfileCopyDraftOutcome } from "@/hooks/providers/profile-copy/profile-copy-cache";
import { profileCopyMutationKeys } from "@/lib/query-keys";
import type { ProfileCopyAttempt } from "@/lib/profile-copy/profile-copy-model";

/**
 * The import sign-in verbs - never the ordinary `providers.*Login` ones, and
 * never ordinary reauth completion. Served by the destination.
 *
 * Every answer can carry a challenge, and `submitCode` carries the pasted
 * code, so none of these mutations is retained: a short `gcTime` drops each
 * one from the MutationCache once nothing observes it, and the login flow
 * `reset()`s each verb once it has settled, which detaches the observer. The
 * challenge then lives only in the flow's component state; nothing persists,
 * logs or reports it. While a request is in flight the cache does hold it -
 * that is the request itself.
 */

/**
 * A settled, unobserved login mutation is dropped within this. Not 0: a
 * PENDING mutation with no observer (the panel closed during a `login.await`
 * long-poll) re-arms its GC timer every `gcTime` until it settles, so 0 is a
 * zero-delay timer loop for the rest of the request.
 */
const LOGIN_MUTATION_GC_TIME_MS = 250;

type LoginMutation<Method extends keyof HostRpcRegistry & string> =
  UseMutationResult<
    ResponseOfMethod<HostRpcRegistry, Method>,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, Method>
  >;

/** Starts a sign-in, or attaches to the live one and returns its challenge. */
export function useProfileCopyLoginStartMutation(
  attempt: ProfileCopyAttempt,
): LoginMutation<"providers.profileCopy.login.start"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.login.start">({
    client,
    method: "providers.profileCopy.login.start",
    options: {
      gcTime: LOGIN_MUTATION_GC_TIME_MS,
      mutationKey: profileCopyMutationKeys.loginStart(
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

/**
 * Waits for the sign-in to finish. The host answers only after verification
 * completes, so the response frame gets the same long-poll budget ordinary
 * sign-in uses; dial and handshake still fail fast.
 */
export function useProfileCopyLoginAwaitMutation(
  attempt: ProfileCopyAttempt,
): LoginMutation<"providers.profileCopy.login.await"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "providers.profileCopy.login.await"
  >({
    client,
    method: "providers.profileCopy.login.await",
    responseTimeoutMs: PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
    options: {
      gcTime: LOGIN_MUTATION_GC_TIME_MS,
      mutationKey: profileCopyMutationKeys.loginAwait(
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

/** Keeps a live sign-in from expiring while this window is waiting on it. */
export function useProfileCopyLoginTouchMutation(
  attempt: ProfileCopyAttempt,
): LoginMutation<"providers.profileCopy.login.touch"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.login.touch">({
    client,
    method: "providers.profileCopy.login.touch",
    options: {
      gcTime: LOGIN_MUTATION_GC_TIME_MS,
      mutationKey: profileCopyMutationKeys.loginTouch(
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

/**
 * Sends a pasted code. The code is never logged or echoed back, and is not
 * kept once the request settles (see the note at the top).
 */
export function useProfileCopyLoginSubmitCodeMutation(
  attempt: ProfileCopyAttempt,
): LoginMutation<"providers.profileCopy.login.submitCode"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileCopy.login.submitCode"
  >({
    client,
    method: "providers.profileCopy.login.submitCode",
    options: {
      gcTime: LOGIN_MUTATION_GC_TIME_MS,
      mutationKey: profileCopyMutationKeys.loginSubmitCode(
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

/**
 * Cancels the sign-in AND the draft: the host's `login.cancel` runs the
 * draft's cancel transition. There is no "stop signing in, keep the draft"
 * verb (Q2 ruling), which is why the button says "Cancel copy to …".
 */
export function useProfileCopyLoginCancelMutation(
  attempt: ProfileCopyAttempt,
): LoginMutation<"providers.profileCopy.login.cancel"> {
  const client = useHostClientForHostId(attempt.destinationHostId);
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "providers.profileCopy.login.cancel">(
    {
      client,
      method: "providers.profileCopy.login.cancel",
      options: {
        gcTime: LOGIN_MUTATION_GC_TIME_MS,
        mutationKey: profileCopyMutationKeys.loginCancel(
          attempt.destinationHostId,
          attempt.attemptId,
        ),
        onSuccess: (response) => {
          writeProfileCopyDraftOutcome(queryClient, response.outcome);
        },
      },
      mapVariables: (variables) => variables,
    },
  );
}
