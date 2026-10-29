import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogModel } from "@/hooks/browser/use-browser-catalog-inventory";
import {
  browserSessionsCoordinatorsForEpic,
  subscribeToBrowserSessionsCoordinators,
  type BrowserSessionsState,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { BrowserPanelPreferences } from "@/stores/epics/browser-panel-store";
import { useBrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useBrowserPanelPreferences } from "@/stores/epics/browser-panel-store";
import { browserSessionTileId } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  filterBrowserTabRows,
  useBrowserSidebarTabRows,
  type BrowserSidebarSession,
  type BrowserSidebarTabRow,
} from "./use-browser-tab-rows";
import { isBrowserDeviceOffline } from "./browser-device-availability";
import { hostNameFromLabel } from "@/hooks/agent/use-host-reachability";

export interface BrowserDeviceGroupModel {
  readonly hostId: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly offline: boolean;
  readonly expanded: boolean;
  readonly rows: readonly BrowserSidebarTabRow[];
}

export interface BrowserListModel {
  readonly status: BrowserCatalogModel["status"];
  readonly preferences: BrowserPanelPreferences;
  readonly groups: readonly BrowserDeviceGroupModel[];
  readonly rows: readonly BrowserSidebarTabRow[];
  readonly matches: readonly BrowserSidebarTabRow[];
  readonly loading: boolean;
  readonly hiddenOfflineMatches: boolean;
  readonly filteredEmpty: boolean;
  readonly refresh: () => void;
}

/** Observe streams already held by a surface or action; listing never opens one. */
function useHeldBrowserStates(epicId: string): readonly BrowserSessionsState[] {
  const cache = useRef<readonly BrowserSessionsState[]>([]);
  const getSnapshot = useCallback(() => {
    const states = browserSessionsCoordinatorsForEpic(epicId).map(
      (entry) => entry.state,
    );
    if (
      states.length !== cache.current.length ||
      states.some((state, index) => state !== cache.current[index])
    )
      cache.current = states;
    return cache.current;
  }, [epicId]);
  return useSyncExternalStore(
    subscribeToBrowserSessionsCoordinators,
    getSnapshot,
    getSnapshot,
  );
}

/** A connected owner's full inventory replaces that host's discovery rows. */
function mergeBrowserSessions(
  records: readonly BrowserCatalogRecord[],
  states: readonly BrowserSessionsState[],
  ambient: BrowserSessionsState,
): readonly BrowserSidebarSession[] {
  const owners = new Map<string, BrowserSessionsState>();
  for (const state of [ambient, ...states]) {
    if (
      state.hostId !== null &&
      state.lifecycle === "live" &&
      state.inventoryReady
    )
      owners.set(state.hostId, state);
  }
  return [
    ...records
      .filter((record) => !owners.has(record.hostId))
      .map((record): BrowserSidebarSession => ({
        hostId: record.hostId,
        sessionId: record.sessionId,
        profile: null,
        tabs: record.tabs.map((tab) => ({
          ...tab,
          status: null,
          drivenBy: [],
        })),
      })),
    ...[...owners.values()].flatMap((owner) => owner.items),
  ];
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
    name: hostNameFromLabel(args.hosts.get(hostId)?.name ?? null, hostId),
    isLocal: hostId === args.localHostId,
    offline: isBrowserDeviceOffline(args.hosts.get(hostId)),
    expanded:
      args.query.trim().length > 0 ||
      !args.preferences.collapsed[hostId] ||
      rows.some((row) => matchesReveal(row, args.revealNodeId)),
    rows,
  }));
}

/** One presentation of task discovery, shared by the rail and mobile switcher. */
export function useBrowserListModel(
  epicId: string,
  query: string,
  revealNodeId: string | null,
): BrowserListModel {
  const catalog = useBrowserCatalogContext();
  const live = useBrowserSessionsContext();
  const heldStates = useHeldBrowserStates(epicId);
  const options = useHostOptions();
  const localHostId = useReactiveLocalHostId();
  const preferences = useBrowserPanelPreferences(epicId);
  const sessions = useMemo(
    () =>
      mergeBrowserSessions(
        catalog?.scope === "cloud" ? catalog.records : [],
        heldStates,
        live,
      ),
    [catalog, heldStates, live],
  );
  const allRows = useBrowserSidebarTabRows(sessions);
  const hosts = useMemo(
    () => new Map(options.hosts.map((host) => [host.hostId, host])),
    [options.hosts],
  );
  const rows = allRows.filter(
    (row) => hosts.get(row.session.hostId)?.health.state !== "removed",
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
    localHostId,
    preferences,
    query,
    revealNodeId,
  });
  const status = catalog?.status ?? "ready";
  return {
    status,
    preferences,
    groups,
    rows,
    matches,
    loading: status === "loading" && rows.length === 0,
    hiddenOfflineMatches:
      !preferences.showOffline &&
      filterBrowserTabRows(
        rows.filter((row) =>
          isBrowserDeviceOffline(hosts.get(row.session.hostId)),
        ),
        query,
      ).length > 0,
    filteredEmpty: rows.length > 0 && visible.length === 0,
    refresh: catalog?.refetch ?? live.retry,
  };
}
