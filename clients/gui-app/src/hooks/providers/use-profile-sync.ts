import {
  useIsMutating,
  useMutationState,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProfileSyncOverview,
  ProfileSyncProvider,
} from "@traycer/protocol/host/profile-sync-link-schemas";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useHostMutation,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { profileSyncKeys } from "@/lib/query-keys/profile-sync-keys";

/**
 * Profile sync, as the app sees it: one polled overview read from the SOURCE
 * host and three intents sent to it. The app never talks to a destination and
 * never holds a sign-in; every answer is statuses only.
 */

/** An answer about another source must never land in this source's cache. */
function assertOverviewForSource(
  overview: ProfileSyncOverview,
  sourceHostId: string,
): void {
  if (overview.sourceHostId !== sourceHostId) {
    throw new Error("The device returned sync status for another source.");
  }
}

/**
 * Every intent answers with the overview it produced. Publishing it makes the
 * click's effect visible at once; the refetch behind it then picks up whatever
 * the host has done since, because a sync keeps moving after the answer.
 */
function publishOverview(
  queryClient: QueryClient,
  sourceHostId: string,
  overview: ProfileSyncOverview,
): void {
  const queryKey = profileSyncKeys.overview(sourceHostId);
  queryClient.setQueryData<ProfileSyncOverview>(queryKey, overview);
  void queryClient.invalidateQueries({ queryKey });
}

/** Polled while a dialog observes it; a closed dialog reads nothing. */
export function useProfileSyncOverview(
  sourceHostId: string,
): UseQueryResult<ProfileSyncOverview, HostRpcError> {
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.profileSync.overview",
    ProfileSyncOverview
  >({
    client: useHostClientForHostId(sourceHostId),
    method: "providers.profileSync.overview",
    params: { sourceHostId },
    cacheKeyIdentity: undefined,
    options: { poll: true, retry: false },
    // Checked before caching: a rejected poll keeps the last valid overview.
    mapResponse: ({ response }) => {
      assertOverviewForSource(response, sourceHostId);
      return response;
    },
  });
}

/** Sync everything supported to one device now. Safe to repeat. */
export function useProfileSyncNow(
  sourceHostId: string,
  destinationHostId: string,
): UseMutationResult<ProfileSyncOverview, HostRpcError, void> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileSync.syncNow",
    unknown,
    void
  >({
    client: useHostClientForHostId(sourceHostId),
    method: "providers.profileSync.syncNow",
    mapVariables: () => ({ sourceHostId, destinationHostId }),
    onResponse: (overview) => assertOverviewForSource(overview, sourceHostId),
    options: {
      mutationKey: profileSyncKeys.syncNow(sourceHostId, destinationHostId),
      onSuccess: (overview) =>
        publishOverview(queryClient, sourceHostId, overview),
      onError: (error) =>
        toastFromHostError(error, "Couldn't start the sync. Try again."),
    },
  });
}

export interface ProfileSyncKeepInSyncVariables {
  readonly enabled: boolean;
}

/** Turning it on also syncs at once; that is the host's doing, not a second call. */
export function useProfileSyncSetKeepInSync(
  sourceHostId: string,
  destinationHostId: string,
): UseMutationResult<
  ProfileSyncOverview,
  HostRpcError,
  ProfileSyncKeepInSyncVariables
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileSync.setKeepInSync",
    unknown,
    ProfileSyncKeepInSyncVariables
  >({
    client: useHostClientForHostId(sourceHostId),
    method: "providers.profileSync.setKeepInSync",
    mapVariables: ({ enabled }) => ({
      sourceHostId,
      destinationHostId,
      enabled,
    }),
    onResponse: (overview) => assertOverviewForSource(overview, sourceHostId),
    options: {
      mutationKey: profileSyncKeys.setKeepInSync(
        sourceHostId,
        destinationHostId,
      ),
      onSuccess: (overview) =>
        publishOverview(queryClient, sourceHostId, overview),
      onError: (error) =>
        toastFromHostError(error, "Couldn't change Keep in sync. Try again."),
    },
  });
}

/** The one explicit action after a synced profile changed account on the source. */
export function useProfileSyncAcceptAccount(
  sourceHostId: string,
  destinationHostId: string,
  providerId: ProfileSyncProvider,
  sourceProfileId: string,
): UseMutationResult<ProfileSyncOverview, HostRpcError, void> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.profileSync.acceptAccount",
    unknown,
    void
  >({
    client: useHostClientForHostId(sourceHostId),
    method: "providers.profileSync.acceptAccount",
    mapVariables: () => ({
      sourceHostId,
      destinationHostId,
      providerId,
      sourceProfileId,
    }),
    onResponse: (overview) => assertOverviewForSource(overview, sourceHostId),
    options: {
      mutationKey: profileSyncKeys.acceptAccount(
        sourceHostId,
        destinationHostId,
        providerId,
        sourceProfileId,
      ),
      onSuccess: (overview) =>
        publishOverview(queryClient, sourceHostId, overview),
      onError: (error) =>
        toastFromHostError(error, "Couldn't sync the new account. Try again."),
    },
  });
}

/**
 * Pending is read from the mutation cache by key, not from the hook instance
 * that sent it: the dialog can be closed while a request is in flight, and a
 * reopened dialog has to show that request on the control it belongs to.
 */
export function useProfileSyncNowPending(
  sourceHostId: string,
  destinationHostId: string,
): boolean {
  return (
    useIsMutating({
      mutationKey: profileSyncKeys.syncNow(sourceHostId, destinationHostId),
      exact: true,
    }) > 0
  );
}

export function useProfileSyncAcceptAccountPending(
  sourceHostId: string,
  destinationHostId: string,
  providerId: ProfileSyncProvider,
  sourceProfileId: string,
): boolean {
  return (
    useIsMutating({
      mutationKey: profileSyncKeys.acceptAccount(
        sourceHostId,
        destinationHostId,
        providerId,
        sourceProfileId,
      ),
      exact: true,
    }) > 0
  );
}

function requestedKeepInSync(variables: unknown): boolean | null {
  if (
    typeof variables !== "object" ||
    variables === null ||
    !("enabled" in variables)
  ) {
    return null;
  }
  return typeof variables.enabled === "boolean" ? variables.enabled : null;
}

/**
 * The value a pending Keep in sync request asked for, or `null` when none is
 * in flight. The switch shows it while the request runs, so it moves on the
 * click instead of waiting for the answer.
 */
export function useProfileSyncRequestedKeepInSync(
  sourceHostId: string,
  destinationHostId: string,
): boolean | null {
  const requested = useMutationState({
    filters: {
      mutationKey: profileSyncKeys.setKeepInSync(
        sourceHostId,
        destinationHostId,
      ),
      exact: true,
      status: "pending",
    },
    select: (mutation) => requestedKeepInSync(mutation.state.variables),
  });
  return requested.at(-1) ?? null;
}
