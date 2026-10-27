import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  BROWSER_CATALOG_HEAD_WAKE_MAP_KEY,
  readBrowserCatalogHeadWakeVersion,
} from "@traycer/protocol/host/browser/catalog-head-wake-room";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { BrowserCatalogReadRequest } from "@traycer/protocol/host/browser/catalog-contracts";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";
import { browserCatalogDiscovery } from "@/lib/browser-view/sessions/browser-catalog-discovery";
import {
  browserCatalogInventory,
  type BrowserCatalogInventory,
} from "@/lib/browser-view/sessions/browser-catalog-inventory";
import { useNotificationsStore } from "@/stores/notifications/notifications-store";

const EMPTY_INVENTORY: BrowserCatalogInventory = {
  status: "loading",
  records: [],
  readiness: [],
  version: null,
  pendingCount: 0,
  revokedHostIds: [],
};

export interface BrowserCatalogModel {
  readonly inventory: BrowserCatalogInventory;
  /** Directory facts only; reading this model never acquires an owner stream. */
  readonly hosts: ReadonlyMap<string, HostDirectoryEntry>;
  readonly refresh: () => void;
}

interface CatalogRead {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string;
  readonly userId: string;
  readonly request: BrowserCatalogReadRequest;
  readonly signal: AbortSignal;
}

export function useBrowserCatalogInventory(args: {
  readonly epicId: string;
  readonly readerClient: HostClient<HostRpcRegistry> | null;
}): BrowserCatalogModel {
  const { epicId, readerClient } = args;
  const active = usePaneVisible();
  const userId = useRequestContextUserId(readerClient);
  const readiness = useReactiveHostReadiness(readerClient);
  const { mutateAsync: readCatalog } = useHostMutation<
    HostRpcRegistry,
    "browser.catalog.read",
    unknown,
    CatalogRead
  >({
    client: (variables) => {
      variables.signal.throwIfAborted();
      if (
        variables.client.getRequestContextUserId() !== variables.userId ||
        variables.client.getActiveHostId() !== variables.hostId
      )
        throw new Error("Browser inventory identity changed.");
      return variables.client;
    },
    method: "browser.catalog.read",
    mapVariables: (variables) => variables.request,
    signalFor: (variables) => variables.signal,
    options: {
      mutationKey: browserMutationKeys.catalogRead(
        readiness.hostId,
        userId,
        epicId,
      ),
      retry: false,
      gcTime: 0,
      networkMode: "always",
    },
  });
  const scope = useMemo(
    () => (userId === null ? null : { userId, epicId }),
    [epicId, userId],
  );
  const discovery = useMemo(
    () => (scope === null ? null : browserCatalogDiscovery(scope)),
    [scope],
  );
  const doc = useNotificationsStore((state) => state.doc);
  const directory = useHostDirectoryList();

  useEffect(() => {
    if (
      !active ||
      discovery === null ||
      readerClient === null ||
      userId === null ||
      !readiness.canExecute ||
      readiness.hostId === null
    )
      return;
    const hostId = readiness.hostId;
    const release = discovery.acquire({
      read: (request, signal) =>
        readCatalog({
          client: readerClient,
          hostId,
          userId,
          request,
          signal,
        }),
    });
    const changed = readerClient.onChange(discovery.refresh);
    const verdict = readerClient.onCloudVerdictChanged(discovery.refresh);
    return () => {
      changed();
      verdict();
      release();
    };
  }, [
    active,
    discovery,
    readerClient,
    userId,
    readiness.canExecute,
    readiness.hostId,
    readCatalog,
  ]);

  useEffect(() => {
    if (discovery === null) return;
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
      discovery.refresh();
    };
    hints.observe(wake);
    wake();
    return () => hints.unobserve(wake);
  }, [discovery, doc, epicId]);

  const snapshot = useCallback(
    () =>
      scope === null ? EMPTY_INVENTORY : browserCatalogInventory.read(scope),
    [scope],
  );
  const inventory = useSyncExternalStore(
    browserCatalogInventory.subscribe,
    snapshot,
    () => EMPTY_INVENTORY,
  );
  const hosts = useMemo(
    () => new Map((directory.data ?? []).map((entry) => [entry.hostId, entry])),
    [directory.data],
  );
  const refresh = useCallback(() => discovery?.refresh(), [discovery]);
  return { inventory, hosts, refresh };
}
