import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  hasBorrowableRemoteSession,
  subscribeRemoteSessionReadiness,
} from "@traycer-clients/shared/host-transport/remote/index";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
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
 * a host is read only when this client already holds a session to it (the
 * local host, the host Settings is scoped to, and any remote host with a
 * borrowable session). Every other host resolves to `null` and its row says
 * nothing about its environment.
 */
export function useHostEnvironmentLabelResolver(
  hostIds: ReadonlyArray<string>,
  scopedHostId: string | null,
): (hostId: string) => string | null {
  const localHostId = useReactiveLocalHostId();
  const fromPool = readsHostBindingsFromPool();
  const idsKey = hostIds.join("\n");
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      subscribeRemoteSessionReadiness(onStoreChange),
    [],
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
              hostId === localHostId ||
              hostId === scopedHostId ||
              hasBorrowableRemoteSession(hostId)),
        )
        .join("\n"),
    [fromPool, idsKey, localHostId, scopedHostId],
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
