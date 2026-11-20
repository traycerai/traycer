import { useCallback, useMemo, useSyncExternalStore } from "react";
import { subscribeAnyHostRowChanged } from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  hasBorrowableRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import { useHostBinding } from "@/lib/host";
import { servesOverLocalSocket } from "@/lib/host/host-messenger";
import {
  readsHostBindingsFromPool,
  useHostEnvironmentBindings,
} from "@/hooks/bots/use-host-environment-bindings-query";

/**
 * Each listed host's environment label for Settings' host list (Tracy Bots),
 * obtained WITHOUT causing a connection to the host. In a build with a pool
 * every row's binding comes from the pool, so every row is read. Without
 * one each read goes to the host itself, so the rule the fleet update badges
 * keep applies - Settings does not silently dial other hosts to decorate a row:
 * a host is read only when reading it dials nothing (a host the transport
 * serves over the local socket, the host Settings is scoped to, and any
 * remote host with a borrowable session). Every other host resolves to `null`
 * and its row says nothing about its environment.
 */
export function useHostEnvironmentLabelResolver(
  hostIds: ReadonlyArray<string>,
  scopedHostId: string | null,
): (hostId: string) => string | null {
  const hostClient = useHostBinding()?.hostClient ?? null;
  const fromPool = readsHostBindingsFromPool();
  const idsKey = hostIds.join("\n");
  const subscribe = useCallback((onStoreChange: () => void) => {
    const unsubscribeSessions = subscribeRemoteSessionReadiness(onStoreChange);
    const unsubscribeRows = subscribeAnyHostRowChanged(onStoreChange);
    return () => {
      unsubscribeSessions();
      unsubscribeRows();
    };
  }, []);
  const servedOverLocalSocket = useCallback(
    (hostId: string) => {
      const entry =
        hostClient === null ? null : hostClient.resolveHostById(hostId);
      return entry !== null && servesOverLocalSocket(entry);
    },
    [hostClient],
  );
  // A string stamp because `useSyncExternalStore` compares with `Object.is`:
  // a readiness wake that moved no listed host re-renders nothing.
  const getReadableStamp = useCallback(
    () =>
      idsKey
        .split("\n")
        .filter(
          (hostId) =>
            hostId.length > 0 &&
            (fromPool ||
              servedOverLocalSocket(hostId) ||
              hostId === scopedHostId ||
              hasBorrowableRemoteSession(hostId)),
        )
        .join("\n"),
    [fromPool, idsKey, servedOverLocalSocket, scopedHostId],
  );
  const readableStamp = useSyncExternalStore(
    subscribe,
    getReadableStamp,
    getReadableStamp,
  );
  const readableHostIds = useMemo(
    () => readableStamp.split("\n").filter((id) => id.length > 0),
    [readableStamp],
  );
  const bindings = useHostEnvironmentBindings(readableHostIds, true);
  const byHostId = bindings.byHostId;
  return useCallback(
    (hostId: string) => byHostId.get(hostId)?.environment.label ?? null,
    [byHostId],
  );
}
