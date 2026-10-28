import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY } from "@traycer/protocol/host/simulator/catalog-contracts";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { SimulatorCatalogRecord } from "@traycer/protocol/host/simulator/catalog-contracts";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { readSimulatorCatalogHeadWakeVersion } from "@/lib/simulator-view/simulator-catalog-head-wake";
import { useNotificationsStore } from "@/stores/notifications/notifications-store";
import { withoutClosedSimulatorCatalogSessions } from "./simulator-catalog-closed-sessions";

export interface SimulatorCatalogQueryData {
  /**
   * `not-ready` is a cloud whose simulator catalog is not enabled yet; the
   * panel says so instead of showing an empty task.
   */
  readonly scope: "cloud" | "local-only" | "inaccessible" | "not-ready";
  readonly records: readonly SimulatorCatalogRecord[];
  readonly unavailable: boolean;
}

export interface SimulatorCatalogModel {
  readonly status: "loading" | "error" | "ready";
  readonly scope: SimulatorCatalogQueryData["scope"];
  readonly records: readonly SimulatorCatalogRecord[];
  readonly refetch: () => void;
}

const EMPTY_RECORDS: readonly SimulatorCatalogRecord[] = [];

/**
 * The task's simulator catalog, read through `readerClient` (the task's own
 * host relays it). A copy of `useBrowserCatalogInventory` without the live
 * merge: simulator rows come from the catalog only.
 */
export function useSimulatorCatalogInventory(args: {
  readonly epicId: string;
  readonly readerClient: HostClient<HostRpcRegistry> | null;
}): SimulatorCatalogModel {
  const { epicId, readerClient } = args;
  const visible = usePaneVisible();
  const userId = useRequestContextUserId(readerClient);
  const readiness = useReactiveHostReadiness(readerClient);
  const supported = useHostSupportsMethod(
    readiness.hostId,
    "simulator.catalog.read",
  );
  const queryClient = useQueryClient();
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "simulator.catalog.read",
    SimulatorCatalogQueryData
  >({
    client: userId === null || !supported ? null : readerClient,
    method: "simulator.catalog.read",
    params: { epicId },
    cacheKeyIdentity: [userId],
    preflight: () => {
      if (userId === null || readerClient?.getRequestContextUserId() !== userId)
        throw new Error("Sign in to view simulators.");
    },
    mapResponse: ({ response, queryClient: cache, queryKey }) => {
      switch (response.kind) {
        case "available":
          return {
            scope: "cloud",
            records:
              userId === null
                ? response.snapshot.records
                : withoutClosedSimulatorCatalogSessions(
                    userId,
                    epicId,
                    response.snapshot.records,
                  ),
            unavailable: false,
          };
        case "local-only":
        case "inaccessible":
        case "not-ready":
          return { scope: response.kind, records: [], unavailable: false };
        case "unavailable": {
          const previous =
            cache.getQueryData<SimulatorCatalogQueryData>(queryKey);
          return {
            scope: previous?.scope ?? "cloud",
            records: previous?.records ?? EMPTY_RECORDS,
            unavailable: true,
          };
        }
      }
    },
    options: {
      enabled: visible && userId !== null && supported,
      poll: visible,
      refetchOnWindowFocus: true,
      retry: false,
    },
  });
  const doc = useNotificationsStore((state) => state.doc);
  useEffect(() => {
    if (userId === null) return;
    const hints = doc.getMap<unknown>(SIMULATOR_CATALOG_HEAD_WAKE_MAP_KEY);
    let observed: number | null = null;
    const wake = (): void => {
      const version = readSimulatorCatalogHeadWakeVersion(
        doc,
        epicId,
        Date.now(),
      );
      if (version === null || version === observed) return;
      observed = version;
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.simulatorCatalog(
          readiness.hostId,
          epicId,
          userId,
        ),
        exact: true,
      });
    };
    hints.observe(wake);
    wake();
    return () => hints.unobserve(wake);
  }, [doc, epicId, queryClient, readiness.hostId, userId]);

  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);
  let status: SimulatorCatalogModel["status"] = "ready";
  if (query.isError || query.data?.unavailable === true) status = "error";
  else if (supported && query.isPending) status = "loading";
  return {
    status,
    scope: query.data?.scope ?? "cloud",
    records: query.data?.records ?? EMPTY_RECORDS,
    refetch,
  };
}
