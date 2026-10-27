import { useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogModel } from "@/hooks/browser/use-browser-catalog-inventory";
import type {
  BrowserCatalogInventory,
  BrowserCatalogStatus,
} from "@/lib/browser-view/sessions/browser-catalog-inventory";
import {
  browserSessionsOwnerSupportsInventory,
  type BrowserSessionsState,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { HostOptions } from "@/components/settings/host-scope/use-host-options";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { BrowserPanelPreferences } from "@/stores/epics/browser-panel-store";
import { useBrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import {
  useBrowserSessionsContext,
  useMaybeBrowserSessionsCoordinatorKey,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useBrowserPanelPreferences } from "@/stores/epics/browser-panel-store";
import { browserSessionTileId } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";
import {
  filterBrowserTabRows,
  useBrowserSidebarTabRows,
  type BrowserSidebarSession,
  type BrowserSidebarTabRow,
} from "./use-browser-tab-rows";
import { isBrowserDeviceOffline } from "./browser-device-availability";

export interface BrowserDeviceGroupModel {
  readonly hostId: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly offline: boolean;
  readonly expanded: boolean;
  readonly rows: readonly BrowserSidebarTabRow[];
}

export interface BrowserListModel {
  readonly catalog: BrowserCatalogModel | null;
  readonly status: BrowserCatalogStatus;
  readonly fallback: boolean;
  readonly legacyView: boolean;
  readonly legacyHostId: string | null;
  readonly live: BrowserSessionsState;
  readonly options: HostOptions;
  readonly preferences: BrowserPanelPreferences;
  readonly groups: readonly BrowserDeviceGroupModel[];
  readonly rows: readonly BrowserSidebarTabRow[];
  readonly matches: readonly BrowserSidebarTabRow[];
  readonly incomplete: boolean;
  readonly loading: boolean;
  readonly legacyUnavailable: boolean;
  readonly directoryUnavailable: boolean;
  readonly hiddenOfflineMatches: boolean;
  readonly filteredEmpty: boolean;
  readonly refresh: () => void;
}

function fallbackMode(args: {
  readonly status: BrowserCatalogStatus;
  readonly legacyHostId: string | null;
  readonly live: BrowserSessionsState;
  readonly coordinatorKey: string | null;
}): "common" | "local-only" | "unsupported-reader" | "legacy-owner" {
  if (args.status === "local-only") return "local-only";
  if (args.status === "unsupported") return "unsupported-reader";
  if (args.status === "inaccessible") return "common";
  if (
    args.legacyHostId === null ||
    args.legacyHostId !== args.live.hostId ||
    args.coordinatorKey === null
  )
    return "common";
  if (
    args.live.lifecycle !== "live" ||
    !args.live.inventoryReady ||
    browserSessionsOwnerSupportsInventory(args.coordinatorKey)
  )
    return "common";
  return "legacy-owner";
}

/** Catalog membership/title/URL remain authoritative; live frames only decorate. */
function catalogSidebarSessions(
  records: readonly BrowserCatalogRecord[],
  live: BrowserSessionsState,
): readonly BrowserSidebarSession[] {
  const liveById = new Map(
    live.items.map((session) => [
      compositeKey(session.hostId, session.sessionId),
      session,
    ]),
  );
  return records.map((record) => {
    const owner = liveById.get(compositeKey(record.hostId, record.sessionId));
    const liveTabs = new Map(owner?.tabs.map((tab) => [tab.tabId, tab]) ?? []);
    return {
      source: "catalog",
      hostId: record.hostId,
      sessionId: record.sessionId,
      profile: owner?.profile ?? null,
      tabs: record.tabs.map((tab) => ({
        ...tab,
        status: liveTabs.get(tab.tabId)?.status ?? null,
        drivenBy: liveTabs.get(tab.tabId)?.drivenBy ?? [],
      })),
    };
  });
}

function inventoryIncomplete(
  inventory: BrowserCatalogInventory | undefined,
  options: HostOptions,
): boolean {
  if (
    options.isLoading ||
    !options.listsResolved ||
    options.listsFailed ||
    inventory === undefined
  )
    return true;
  if (
    inventory.readiness.length === 0 ||
    inventory.readiness.some((entry) => entry.state !== "complete")
  )
    return true;
  const indexed = new Set(inventory.readiness.map((entry) => entry.hostId));
  const revoked = new Set(inventory.revokedHostIds);
  return options.hosts.some(
    (host) =>
      host.entry?.kind !== "pool" &&
      host.health.state !== "removed" &&
      !revoked.has(host.hostId) &&
      !indexed.has(host.hostId),
  );
}

function matchesReveal(
  row: BrowserSidebarTabRow,
  revealNodeId: string | null,
): boolean {
  return (
    browserSessionTileId({
      sessionId: row.session.sessionId,
      tabId: row.tab.tabId,
    }) === revealNodeId
  );
}

function groupBrowserRows(args: {
  readonly rows: readonly BrowserSidebarTabRow[];
  readonly hosts: ReadonlyMap<string, HostScopeOption>;
  readonly directory: ReadonlyMap<string, HostDirectoryEntry> | undefined;
  readonly localHostId: string | null;
  readonly preferences: BrowserPanelPreferences;
  readonly query: string;
  readonly revealNodeId: string | null;
}): readonly BrowserDeviceGroupModel[] {
  const grouped = new Map<string, BrowserSidebarTabRow[]>();
  for (const row of args.rows) {
    const group = grouped.get(row.session.hostId) ?? [];
    group.push(row);
    grouped.set(row.session.hostId, group);
  }
  return [...grouped].map(([hostId, rows]) => ({
    hostId,
    name:
      args.hosts.get(hostId)?.name ??
      args.directory?.get(hostId)?.label ??
      hostId,
    isLocal: hostId === args.localHostId,
    offline: isBrowserDeviceOffline(args.hosts.get(hostId)),
    expanded:
      args.query.trim().length > 0 ||
      !args.preferences.collapsed[hostId] ||
      rows.some((row) => matchesReveal(row, args.revealNodeId)),
    rows,
  }));
}

function listLifecycle(args: {
  readonly status: BrowserCatalogStatus;
  readonly live: BrowserSessionsState;
  readonly fallback: boolean;
  readonly rowCount: number;
  readonly options: HostOptions;
}) {
  const { status, live, fallback, rowCount, options } = args;
  const directoryLoading =
    !fallback &&
    !options.listsFailed &&
    (options.isLoading || !options.listsResolved);
  const directoryUnavailable = !fallback && options.listsFailed;
  const ownerLoading =
    fallback &&
    !live.inventoryReady &&
    ["live", "connecting", "reconnecting"].includes(live.lifecycle);
  return {
    directoryUnavailable,
    loading:
      rowCount === 0 &&
      (status === "loading" || directoryLoading || ownerLoading),
  };
}

/** One presentation of task discovery, shared by the rail and mobile switcher. */
export function useBrowserListModel(
  epicId: string,
  query: string,
  revealNodeId: string | null,
): BrowserListModel {
  const catalog = useBrowserCatalogContext();
  const live = useBrowserSessionsContext();
  const coordinatorKey = useMaybeBrowserSessionsCoordinatorKey();
  const options = useHostOptions();
  const localHostId = useReactiveLocalHostId();
  const preferences = useBrowserPanelPreferences(epicId);
  const inventory = catalog?.inventory;
  const status = inventory?.status ?? "unsupported";
  const revoked = useMemo(
    () => new Set(inventory?.revokedHostIds ?? []),
    [inventory],
  );
  const legacyHostId =
    preferences.legacyHostId !== null && !revoked.has(preferences.legacyHostId)
      ? preferences.legacyHostId
      : null;
  const mode = fallbackMode({ status, legacyHostId, live, coordinatorKey });
  const fallback = mode !== "common";
  const sessions = useMemo<readonly BrowserSidebarSession[]>(() => {
    if (status === "inaccessible") return [];
    if (fallback)
      return live.items.map((session) => ({ ...session, source: "legacy" }));
    return catalogSidebarSessions(inventory?.records ?? [], live);
  }, [fallback, inventory, live, status]);
  const allRows = useBrowserSidebarTabRows(sessions);
  const hosts = useMemo(
    () => new Map(options.hosts.map((host) => [host.hostId, host])),
    [options.hosts],
  );
  const rows = allRows.filter(
    (row) =>
      !revoked.has(row.session.hostId) &&
      hosts.get(row.session.hostId)?.health.state !== "removed",
  );
  const visible = rows.filter(
    (row) =>
      preferences.showOffline ||
      !isBrowserDeviceOffline(hosts.get(row.session.hostId)),
  );
  const searchMatches = filterBrowserTabRows(visible, query);
  const matchKeys = new Set(searchMatches.map((row) => row.key));
  const matches = visible.filter(
    (row) => matchKeys.has(row.key) || matchesReveal(row, revealNodeId),
  );
  const groups = groupBrowserRows({
    rows: matches,
    hosts,
    directory: catalog?.hosts,
    localHostId,
    preferences,
    query,
    revealNodeId,
  });
  const lifecycle = listLifecycle({
    status,
    live,
    fallback,
    rowCount: rows.length,
    options,
  });
  return {
    catalog,
    status,
    fallback,
    legacyView: mode === "legacy-owner",
    legacyHostId,
    live,
    options,
    preferences,
    groups,
    rows,
    matches,
    incomplete:
      !fallback &&
      status !== "inaccessible" &&
      inventoryIncomplete(inventory, options),
    legacyUnavailable:
      (fallback || legacyHostId !== null) &&
      ["failed", "closed", "unsupported"].includes(live.lifecycle),
    hiddenOfflineMatches:
      !preferences.showOffline &&
      filterBrowserTabRows(
        rows.filter((row) =>
          isBrowserDeviceOffline(hosts.get(row.session.hostId)),
        ),
        query,
      ).length > 0,
    filteredEmpty: rows.length > 0 && visible.length === 0,
    refresh: catalog?.refresh ?? live.retry,
    ...lifecycle,
  };
}
