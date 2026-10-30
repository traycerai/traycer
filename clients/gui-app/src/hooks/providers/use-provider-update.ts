import { useCallback } from "react";
import {
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderId,
  ProviderManagedInstallState,
} from "@traycer/protocol/host/provider-schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { providerPackErrorDetail } from "@/components/providers/provider-pack-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersRefreshPackDiscoveryForClient } from "@/hooks/providers/use-providers-refresh-pack-discovery-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { providersListQueryKey, providersMutationKeys } from "@/lib/query-keys";

export interface ProviderUpdate {
  /** Updates the harness's provider on the host; `null` where the host cannot. */
  readonly update: ((harnessId: string) => void) | null;
  /** `true` from the press until the host's install of the update settles. */
  readonly pending: boolean;
  /** Why the last update did not take, for the row to say; `null` otherwise. */
  readonly failure: string | null;
}

/** One press: the provider, on the host its client answers for. */
interface UpdatePress {
  readonly providerId: ProviderId;
  readonly hostId: string;
}

/**
 * How a press ended: the update was taken, and the list read after it was
 * answered, or failed at `readFailedAt`.
 */
interface PressOutcome {
  readonly press: UpdatePress;
  readonly readFailedAt: number | null;
}

type ProvidersList = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type ProvidersListQuery = UseQueryResult<ProvidersList, HostRpcError>;

/** Tells one press's post-update list read from every other press's. */
let pressCount = 0;

/**
 * Update for a provider whose command-line tool its service refused as out of
 * date (Tracy Bots T71), on `hostId` through `client`: the host checks for the
 * provider's newest version (`providers.refreshPackDiscovery`), then moves its
 * managed copy to it (`providers.ensurePack`, the gesture Settings' retry
 * makes); the next run uses it. The host decided the update can help before
 * the row offered it, so this only asks whether the host has the method.
 * Pressed by a person only: `ensurePack` marks the request user-initiated.
 *
 * A press is one mutation. The check names the provider's pack, which only
 * `providers.list` carries: read from its cache, or fetched through `client`
 * when none is cached. The host only starts the install, so the press then
 * reads the list once more under a key of its own, which no other read joins
 * or cancels: sent after the host answered the update, it is answered after
 * the host took it. That answer goes into the list's cache, and from there
 * this reports the provider's install state as the host's list presents it:
 * pending while it downloads, the host's reason when the install is in error,
 * and done otherwise. If that read fails, the press stays pending until the
 * list's own next read is answered or fails, and goes on from there. It infers nothing about versions. The list says an install
 * is in error only while no copy of the provider is runnable: a replacement
 * that fails beside a runnable old copy reads as installed, so it settles
 * here, and the next refused turn offers Update again. A press belongs to the
 * host it was made on: once `client` answers for another, it no longer shows.
 */
export function useProviderUpdateForClient(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): ProviderUpdate {
  const queryClient = useQueryClient();
  const canEnsure =
    useHostSupportsMethod(hostId, "providers.ensurePack") && client !== null;
  const canRefresh = useHostSupportsMethod(
    hostId,
    "providers.refreshPackDiscovery",
  );
  const refresh = useProvidersRefreshPackDiscoveryForClient(client, null);
  const ensure = useProvidersEnsurePackForClient(client);
  const press = useMutation({
    mutationKey: providersMutationKeys.updateProvider(hostId),
    mutationFn: (variables: UpdatePress): Promise<PressOutcome> => {
      if (client === null) {
        return Promise.reject(new Error("No host to update the provider on."));
      }
      return runPress(
        {
          client,
          queryClient,
          canRefresh,
          refresh: (packId) => refresh.mutateAsync({ packId }),
          ensure: (providerId) => ensure.mutateAsync({ providerId }),
        },
        variables,
      );
    },
  });
  // A press belongs to the host it was made on.
  const ours = press.variables?.hostId === (client?.getActiveHostId() ?? null);
  const outcome = ours ? press.data : undefined;
  const following = outcome?.press.providerId ?? null;
  const listed = useProvidersListForClient(client, {
    enabled: following !== null,
    subscribed: following !== null,
  });
  const { mutate } = press;
  const update = useCallback(
    (harnessId: string) => {
      const harness = guiHarnessIdSchema.safeParse(harnessId);
      if (!harness.success || client === null) return;
      const providerId = providerCliIdForHarness(harness.data);
      const pressHostId = client.getActiveHostId();
      if (providerId === null || pressHostId === null) return;
      mutate({ providerId, hostId: pressHostId });
    },
    [client, mutate],
  );
  return {
    update: canEnsure ? update : null,
    ...presentPress(
      ours && (press.isPending || awaitingListAnswer(outcome, listed)),
      ours ? (press.error?.message ?? null) : null,
      installSlot(listed.data, following),
    ),
  };
}

/** What a press calls on: the host's client, the cache, and the two updates. */
interface PressDeps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly canRefresh: boolean;
  readonly refresh: (packId: string) => Promise<unknown>;
  readonly ensure: (providerId: ProviderId) => Promise<unknown>;
}

/**
 * One press: the check, the update, then one list read under a key of its
 * own, sent after the host answered the update and written into the list's
 * cache. A refused update rejects; a failed read does not.
 */
async function runPress(
  deps: PressDeps,
  variables: UpdatePress,
): Promise<PressOutcome> {
  const { client, queryClient } = deps;
  // Filed under the host that answers it, as `useHostQuery` files it.
  const listKey = providersListQueryKey(variables.hostId);
  // `gcTime` `undefined` keeps the list's own; a one-off read is dropped.
  const readList = (
    queryKey: ReadonlyArray<unknown>,
    staleTime: number,
    gcTime: number | undefined,
  ): Promise<ProvidersList | null> =>
    queryClient
      .fetchQuery(
        queryOptions({
          queryKey,
          queryFn: () => client.request("providers.list", { native: null }),
          staleTime,
          gcTime,
          retry: false,
        }),
      )
      .catch(() => null);
  // A cached list names the pack as well as a fresh one.
  const packId = deps.canRefresh
    ? ((
        await readList(listKey, Number.POSITIVE_INFINITY, undefined)
      )?.providers.find(
        (candidate) => candidate.providerId === variables.providerId,
      )?.packId ?? null)
    : null;
  // A refused or failed check is toasted by its hook; the update still runs,
  // on whatever the host already knows.
  if (packId !== null) await deps.refresh(packId).catch(() => undefined);
  await deps.ensure(variables.providerId);
  pressCount += 1;
  const answer = await readList([...listKey, "post-ensure", pressCount], 0, 0);
  if (answer === null) {
    // The update was taken; the list's own reads say how it goes.
    const readFailedAt = Date.now();
    void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
    return { press: variables, readFailedAt };
  }
  queryClient.setQueryData(listKey, answer);
  return { press: variables, readFailedAt: null };
}

/**
 * Whether a press whose own list read failed still waits on the list's next
 * read: neither answered nor failed since.
 */
function awaitingListAnswer(
  outcome: PressOutcome | undefined,
  listed: Pick<ProvidersListQuery, "dataUpdatedAt" | "errorUpdatedAt">,
): boolean {
  const readFailedAt = outcome?.readFailedAt ?? null;
  return (
    readFailedAt !== null &&
    listed.dataUpdatedAt < readFailedAt &&
    listed.errorUpdatedAt < readFailedAt
  );
}

function installSlot(
  list: ProvidersList | undefined,
  providerId: ProviderId | null,
): ProviderManagedInstallState | null {
  if (providerId === null) return null;
  return (
    list?.providers.find((candidate) => candidate.providerId === providerId)
      ?.managedInstallState ?? null
  );
}

/**
 * The row's view of a press: its requests, or the list read after them, in
 * flight; the update refused (`refusal`); or the pressed provider's install
 * slot as the host's list presents it.
 */
function presentPress(
  inFlight: boolean,
  refusal: string | null,
  slot: ProviderManagedInstallState | null,
): Omit<ProviderUpdate, "update"> {
  if (inFlight || slot?.status === "downloading") {
    return { pending: true, failure: null };
  }
  if (refusal !== null) return { pending: false, failure: refusal };
  if (slot?.status === "error") {
    return {
      pending: false,
      failure: `The update failed: ${providerPackErrorDetail(slot.reason)}`,
    };
  }
  return { pending: false, failure: null };
}
