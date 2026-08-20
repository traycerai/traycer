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
export function useLocalStoreRebindMutation(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.rebindLocalStore">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.rebindLocalStore">,
  LocalStoreRebindContext
> {
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
  return useHostMutation<
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
        if (response.status !== "rebound") return;
        // The "Show more" tails live OUTSIDE TanStack Query, in the pages
        // store, and `useCloudEpicTasksQuery` keeps concatenating them with
        // the refetched first page - so invalidation alone would leave rows,
        // home markers and cursors answered by the abandoned store on screen.
        if (context.hostId !== null) {
          resetCloudEpicTasksPagesForHost(context.hostId);
        }
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.scope(context.hostId),
        });
      },
      // A refusal is a successful response arm with its own inline surface. A
      // rejected RPC - host gone, method unavailable - has none, and without
      // this the confirmation just stops looking busy and says nothing.
      onError: (error) => {
        toastFromHostError(error, "Could not rebind the local store.");
      },
    },
  });
}
