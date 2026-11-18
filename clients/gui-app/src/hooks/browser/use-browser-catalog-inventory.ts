import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  BROWSER_CATALOG_HEAD_WAKE_MAP_KEY,
  readBrowserCatalogHeadWakeVersion,
} from "@traycer/protocol/host/browser/catalog-head-wake-room";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { useNotificationsStore } from "@/stores/notifications/notifications-store";
import { withoutClosedBrowserCatalogTabs } from "./browser-catalog-closed-tabs";

export interface BrowserCatalogQueryData {
  readonly scope: "cloud" | "local-only" | "inaccessible";
  readonly records: readonly BrowserCatalogRecord[];
  readonly unavailable: boolean;
}

export interface BrowserCatalogModel {
  readonly status: "loading" | "error" | "ready";
  readonly scope: BrowserCatalogQueryData["scope"];
  readonly records: readonly BrowserCatalogRecord[];
  readonly refetch: () => void;
}

const EMPTY_RECORDS: readonly BrowserCatalogRecord[] = [];

export function useBrowserCatalogInventory(args: {
  readonly epicId: string;
  readonly readerClient: HostClient<HostRpcRegistry> | null;
}): BrowserCatalogModel {
  const { epicId, readerClient } = args;
  const visible = usePaneVisible();
  const userId = useRequestContextUserId(readerClient);
  const readiness = useReactiveHostReadiness(readerClient);
  const queryClient = useQueryClient();
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "browser.catalog.read",
    BrowserCatalogQueryData
  >({
    client: userId === null ? null : readerClient,
    method: "browser.catalog.read",
    params: { epicId },
    cacheKeyIdentity: [userId],
    preflight: () => {
      if (userId === null || readerClient?.getRequestContextUserId() !== userId)
        throw new Error("Sign in to view browser tabs.");
    },
    mapResponse: ({ response, queryClient: cache, queryKey }) => {
      switch (response.kind) {
        case "available":
          return {
            scope: "cloud",
            records:
              userId === null
                ? response.snapshot.records
                : withoutClosedBrowserCatalogTabs(
                    userId,
                    epicId,
                    response.snapshot.records,
                  ),
            unavailable: false,
          };
        case "local-only":
        case "inaccessible":
          return { scope: response.kind, records: [], unavailable: false };
        case "unavailable": {
          const previous =
            cache.getQueryData<BrowserCatalogQueryData>(queryKey);
          return {
            scope: previous?.scope ?? "cloud",
            records: previous?.records ?? EMPTY_RECORDS,
            unavailable: true,
          };
        }
      }
    },
    options: {
      enabled: visible && userId !== null,
      poll: visible,
      refetchOnWindowFocus: true,
      retry: false,
    },
  });
  const doc = useNotificationsStore((state) => state.doc);
  useEffect(() => {
    if (userId === null) return;
    const hints = doc.getMap<unknown>(BROWSER_CATALOG_HEAD_WAKE_MAP_KEY);
    let observed: number | null = null;
    const wake = (): void => {
      const version = readBrowserCatalogHeadWakeVersion(
        doc,
        epicId,
        Date.now(),
      );
      if (version === null || version === observed) return;
      observed = version;
      void queryClient.invalidateQueries({
        queryKey: hostQueryKeys.browserCatalog(
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
  let status: BrowserCatalogModel["status"] = "ready";
  if (query.isError || query.data?.unavailable === true) status = "error";
  else if (query.isPending) status = "loading";
  return {
    status,
    scope: query.data?.scope ?? "cloud",
    records: query.data?.records ?? EMPTY_RECORDS,
    refetch,
  };
}
