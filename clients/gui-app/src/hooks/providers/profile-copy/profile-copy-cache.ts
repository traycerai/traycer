import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import {
  isOutcomePromoted,
  reconcileProfileCopyRetryOutcome,
  type ProfileCopyAttempt,
  type ProfileCopyDraftResponse,
  type ProfileCopyOperationResponse,
  type ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";

/**
 * Cache writes for profile-copy answers. Every key built here names the host
 * the answer CAME FROM - the destination for a draft, the source for an
 * operation - never the host Settings happens to be showing.
 */

export function profileCopyDraftStatusKey(outcome: {
  readonly attempt: ProfileCopyOutcome["attempt"];
}): readonly unknown[] {
  return hostQueryKeys.method<
    HostRpcRegistry,
    "providers.profileCopy.draftStatus"
  >(outcome.attempt.destinationHostId, "providers.profileCopy.draftStatus", {
    attempt: outcome.attempt,
  });
}

export function profileCopyStatusKey(
  sourceHostId: string,
  operationId: string,
): readonly unknown[] {
  return hostQueryKeys.method<HostRpcRegistry, "providers.profileCopy.status">(
    sourceHostId,
    "providers.profileCopy.status",
    { sourceHostId, operationId },
  );
}

/**
 * A promoted destination profile changes what the DESTINATION's provider
 * surfaces show (its profile list, both harness catalogs, the judge's
 * verdict), so the provider invalidations run scoped to that host alone.
 */
export function invalidateProfileCopyDestinationProviders(
  queryClient: QueryClient,
  destinationHostId: string,
): void {
  for (const method of PROVIDER_INVALIDATIONS) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(destinationHostId, method),
    });
  }
}

/**
 * A destination's answer to any draft or sign-in verb IS its current outcome,
 * so it goes straight into that draft's cached status - unless a read that
 * landed first already holds a newer revision. The source's view of the same
 * attempt and the destination's incoming list are then re-read.
 */
export function writeProfileCopyDraftOutcome(
  queryClient: QueryClient,
  outcome: ProfileCopyOutcome,
): void {
  queryClient.setQueryData<ProfileCopyDraftResponse>(
    profileCopyDraftStatusKey(outcome),
    (previous) =>
      previous !== undefined && previous.outcome.revision > outcome.revision
        ? previous
        : { result: "current", outcome },
  );
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      outcome.attempt.destinationHostId,
      "providers.profileCopy.incoming",
    ),
  });
  void queryClient.invalidateQueries({
    queryKey: profileCopyStatusKey(
      outcome.attempt.sourceHostId,
      outcome.attempt.operationId,
    ),
  });
  if (isOutcomePromoted(outcome)) {
    invalidateProfileCopyDestinationProviders(
      queryClient,
      outcome.attempt.destinationHostId,
    );
  }
}

export function writeProfileCopyOperation(
  queryClient: QueryClient,
  response: ProfileCopyOperationResponse,
): void {
  queryClient.setQueryData<ProfileCopyOperationResponse>(
    profileCopyStatusKey(response.sourceHostId, response.operationId),
    response,
  );
}

/** Keep a current Retry receipt even when the following source read fails. */
export function writeProfileCopyRetryOutcome(
  queryClient: QueryClient,
  requested: ProfileCopyAttempt,
  outcome: ProfileCopyOutcome,
): void {
  queryClient.setQueryData<ProfileCopyOperationResponse>(
    profileCopyStatusKey(requested.sourceHostId, requested.operationId),
    (previous) => {
      if (
        previous === undefined ||
        previous.sourceHostId !== requested.sourceHostId ||
        previous.operationId !== requested.operationId
      )
        return previous;
      const outcomes = previous.outcomes.map((current) =>
        reconcileProfileCopyRetryOutcome(current, requested, outcome),
      );
      return outcomes.some(
        (current, index) => current !== previous.outcomes[index],
      )
        ? { ...previous, outcomes }
        : previous;
    },
  );
}

/**
 * Errors a later read cannot change: the host does not have the method, or
 * refused the request's shape. Everything else - FORBIDDEN during an account
 * directory outage, a transport drop - is worth reading again, paced.
 */
export function isPermanentProfileCopyError(
  error: HostRpcError | null,
): boolean {
  return (
    error !== null &&
    (error.code === "E_HOST_UNSUPPORTED" || error.code === "E_INVALID_ARGUMENT")
  );
}
