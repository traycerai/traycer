import { useMemo } from "react";
import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  RequestOfMethod,
  ResponseOfMethod,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { localStoreMutationKeys } from "@/lib/query-keys/local-store-mutation-keys";
import { resetCloudEpicTasksPagesForHost } from "@/stores/epics/cloud-epic-tasks-pages-store";

interface LocalStoreRebindContext {
  readonly hostId: string | null;
}

export type LocalStoreRebindMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.rebindLocalStore">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.rebindLocalStore">,
  LocalStoreRebindContext
> & {
  /** The session host exists, but its directory entry has not arrived yet. */
  readonly isHostEntryPending: boolean;
};

/**
 * The GUI repair route for a fail-closed local store refusal.
 *
 * Scoped to the Epic SESSION's host, not a tile binding. `LOCAL_STORE_UNAVAILABLE`
 * is a snapshot-load failure, so `SnapshotErrorBanner` renders in place of the
 * whole `TileCanvas` body - no tile renderer, and therefore no
 * `<TabHostProvider>`, ever mounts underneath it. Reading `useTabHostClient()`
 * here reached the throwing `useTabHostId()` and crashed the one screen whose
 * entire job is to offer the recovery.
 */
export function useLocalStoreRebindMutation(): LocalStoreRebindMutationResult {
  const sessionHostId = useEpicSessionHostId();
  const directory = useHostDirectoryList();
  const entry = useMemo(
    () =>
      sessionHostId === null
        ? null
        : ((directory.data ?? []).find((e) => e.hostId === sessionHostId) ??
          null),
    [directory.data, sessionHostId],
  );
  const client = useHostClientFor(entry);
  const queryClient = useQueryClient();
  const mutation = useHostMutation<
    HostRpcRegistry,
    "host.rebindLocalStore",
    LocalStoreRebindContext
  >({
    client,
    method: "host.rebindLocalStore",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: localStoreMutationKeys.rebind(),
      // A rebind republishes the host's durability store, so EVERY read served
      // from it - task lists, task contexts, notification indicators - was
      // answered by a store this host no longer uses. The whole host scope is
      // the honest blast radius; a narrower list would silently go stale the
      // next time a resolver starts consulting the local store.
      // `capturedHostId` rather than a re-read: a host swap between mutate and
      // settle must not invalidate the incoming host's fresh data.
      onMutate: () => ({ hostId: sessionHostId }),
      onSuccess: (response, _variables, context) => {
        // `not-needed` is a REPAIR BOUNDARY, not a no-op for this window.
        //
        // It is an honest no-op for the HOST - the process-global store is
        // already healthy, so it declines to tear one down for a stale panel.
        // But the reason it is already healthy is that a rebind happened: an
        // earlier fence retry, or another window, which invalidated only its
        // OWN `QueryClient`. This window's caches were filled by the abandoned
        // store and nothing has told it so. Skipping invalidation here left
        // History's infinite-lived first page, its retained tails, task
        // contexts and notification indicators answering from that store while
        // the panel reported the repair as done.
        //
        // `refused` stays the only successful arm that skips: nothing was
        // rebound, by this window or any other, so the caches in hand are as
        // good (or bad) as they were before the click.
        if (response.status === "refused") return;
        // The "Show more" tails live OUTSIDE TanStack Query, in the pages
        // store, and `useCloudEpicTasksQuery` keeps concatenating them with
        // the refetched first page - so invalidation alone would leave rows,
        // home markers and cursors answered by the abandoned store on screen.
        if (context.hostId !== null) {
          resetCloudEpicTasksPagesForHost(context.hostId);
        }
        // Invalidation refetches ACTIVE queries only. An inactive one - a
        // History filter scope the user left, its last-known fallback, a task
        // context nothing is rendering - is merely marked stale, and History's
        // first pages mount with `refetchOnMount: false`, so revisiting such a
        // scope kept serving the abandoned store's page indefinitely. Inactive
        // host-scoped data is therefore REMOVED: nothing is looking at it, so
        // there is no flash, and its next observer fetches from the rebound
        // store. Active queries refetch in place through the invalidation.
        const scope = hostQueryKeys.scope(context.hostId);
        queryClient.removeQueries({ queryKey: scope, type: "inactive" });
        void queryClient.invalidateQueries({ queryKey: scope });
      },
      // A refusal is a successful response arm with its own inline surface. A
      // rejected RPC - host gone, method unavailable - has none, and without
      // this the confirmation just stops looking busy and says nothing.
      onError: (error) => {
        toastFromHostError(error, "Could not rebind the local store.");
      },
    },
  });
  const isHostEntryPending = sessionHostId !== null && directory.isPending;
  return useMemo<LocalStoreRebindMutationResult>(
    () => ({ ...mutation, isHostEntryPending }),
    [isHostEntryPending, mutation],
  );
}
