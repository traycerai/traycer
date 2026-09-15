import {
  useMutationState,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderCliState,
  ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { providersMutationKeys } from "@/lib/query-keys";
import { welcomeRosterFreshnessFor } from "@/stores/onboarding/welcome-roster-freshness-store";

export interface WelcomeRoster {
  readonly query: UseQueryResult<ProvidersListResponse, HostRpcError>;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  /** A `providers.setEnabled` aimed at this host is in flight. */
  readonly toggling: boolean;
  /**
   * A toggle aimed at this host succeeded and no fetch of the roster that
   * started AFTER it has completed successfully yet, so the roster on hand
   * may be the one from before the toggle. A refresh that failed, was
   * paused, or had started before the toggle leaves this set.
   */
  readonly refreshRequired: boolean;
  /**
   * Whether the roster may be acted on: resolved, not mid-fetch, not in
   * error, and every toggle aimed at this host receipted by a later fetch.
   */
  readonly settled: boolean;
}

/**
 * Page 1's roster, with the one fact `providers.list` alone cannot answer:
 * whether it is CURRENT with respect to the toggles sent to its host.
 *
 * `useHostScopedMutation` fires the list invalidation inside `onSuccess`
 * without awaiting it, and a refetch can fail: TanStack then keeps the old
 * data, drops `isFetching`, and the query reads as resolved - with the
 * roster from before the toggle. The Continue branch reads that roster, so
 * "enable Claude, refresh fails, Continue" would finish the modal as
 * `no-sessions` for a user who had just turned Claude on.
 *
 * The requirement is a RECEIPT, kept by `welcome-roster-freshness-store`
 * off the query client's own caches (see its comment for the rule and for
 * the one extra fetch it asks for). This hook only reads it: the host is
 * the one the list query is keyed on - the same resolver `useHostQuery`
 * reads, and the same client a toggle captures its `hostId` from - so a
 * toggle aimed at another host is never this roster's business.
 */
export function useWelcomeRoster(): WelcomeRoster {
  const hostId = useAddressableHostId();
  // App-wide host on purpose: this is an app-wide surface, not a composer.
  const query = useProvidersList({ enabled: true, subscribed: true });
  const queryClient = useQueryClient();
  const tracker = welcomeRosterFreshnessFor(queryClient);
  const subscribe = useCallback(
    (listener: () => void) => tracker.subscribe(listener),
    [tracker],
  );
  const freshness = useSyncExternalStore(subscribe, () => tracker.read(hostId));

  const pendingToggleHosts = useMutationState({
    filters: {
      mutationKey: providersMutationKeys.setEnabled(),
      status: "pending",
    },
    select: (mutation) => contextHostId(mutation.state.context),
  });
  const toggling =
    hostId !== null && pendingToggleHosts.some((host) => host === hostId);

  const refreshRequired = freshness.required > freshness.satisfied;
  const providers = query.data?.providers;
  const settled =
    providers !== undefined &&
    !toggling &&
    !query.isFetching &&
    !query.isError &&
    !refreshRequired;
  return { query, providers, toggling, refreshRequired, settled };
}

/** The host a `useHostScopedMutation` captured at `onMutate`; see the store. */
function contextHostId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  if (!("hostId" in context)) return null;
  const { hostId } = context;
  return typeof hostId === "string" ? hostId : null;
}
