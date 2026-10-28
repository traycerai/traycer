import { useMemo } from "react";
import type {
  SimulatorCatalogRecord,
  SimulatorSessionEndReason,
} from "@traycer/protocol/host/simulator/catalog-contracts";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useNowMs } from "@/components/settings/panels/host-settings-panel-hooks";
import { useSimulatorCatalogContext } from "@/components/epic-canvas/renderers/simulator-catalog-context";
import type { SimulatorCatalogModel } from "@/hooks/simulator/use-simulator-catalog-inventory";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { simulatorTileId } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import {
  simulatorPendingOpensForEpic,
  useSimulatorPendingOpensStore,
  type SimulatorPendingOpen,
} from "@/stores/epics/simulator-pending-opens-store";
import { isBrowserDeviceOffline } from "./browser-device-availability";

/**
 * One instance this task holds, however many sessions hold it: the person's,
 * an agent's, both. `drivenByAgent` and `idleUntil` are the instance's own,
 * copied into every session's record on it.
 */
export interface SimulatorLiveRow {
  readonly kind: "live";
  readonly key: string;
  readonly hostId: string;
  readonly instanceKey: string;
  readonly simulatorId: string;
  readonly name: string;
  readonly platform: SimulatorPlatform;
  readonly version: string;
  readonly cloneOf: string | null;
  readonly drivenByAgent: boolean;
  readonly idleUntil: number | null;
  /** Every session in the row; its Close ends each. */
  readonly records: readonly SimulatorCatalogRecord[];
  /** The tile id the row reveals and its tile is placed under. */
  readonly tileId: string;
}

/** One session that ended without its owner closing it, until dismissed. */
export interface SimulatorEndedRow {
  readonly kind: "ended";
  readonly key: string;
  readonly hostId: string;
  readonly name: string;
  readonly platform: SimulatorPlatform;
  readonly version: string;
  readonly reason: SimulatorSessionEndReason;
  readonly record: SimulatorCatalogRecord;
  readonly tileId: string;
}

/** The person's own Boot or Watch, before the catalog lists its session. */
export interface SimulatorPendingRow {
  readonly kind: "pending";
  readonly key: string;
  readonly hostId: string;
  readonly name: string;
  readonly platform: SimulatorPlatform;
  readonly version: string;
  readonly requestId: string;
}

export type SimulatorListRow =
  | SimulatorLiveRow
  | SimulatorEndedRow
  | SimulatorPendingRow;

export interface SimulatorDeviceGroupModel {
  readonly hostId: string;
  readonly name: string;
  readonly isLocal: boolean;
  readonly offline: boolean;
  readonly rows: readonly SimulatorListRow[];
}

export interface SimulatorListModel {
  readonly status: SimulatorCatalogModel["status"];
  /** The cloud's simulator catalog is not enabled yet. */
  readonly notReady: boolean;
  readonly groups: readonly SimulatorDeviceGroupModel[];
  readonly rowCount: number;
  readonly loading: boolean;
  readonly nowMs: number;
  readonly refresh: () => void;
}

function newestFirst(
  a: SimulatorCatalogRecord,
  b: SimulatorCatalogRecord,
): number {
  return b.lastActivityAt - a.lastActivityAt;
}

function liveRow(
  hostId: string,
  instanceKey: string,
  records: readonly SimulatorCatalogRecord[],
): SimulatorLiveRow {
  const sorted = [...records].sort(newestFirst);
  const newest = sorted[0];
  const idleUntil = sorted.find((record) => record.idleUntil !== null);
  return {
    kind: "live",
    key: JSON.stringify(["live", hostId, instanceKey]),
    hostId,
    instanceKey,
    simulatorId: newest.simulatorId,
    name: newest.name,
    platform: newest.platform,
    version: newest.version,
    cloneOf: newest.cloneOf,
    drivenByAgent: sorted.some((record) => record.drivenByAgent),
    idleUntil: idleUntil?.idleUntil ?? null,
    records: sorted,
    tileId: simulatorTileId({ hostId, simulatorId: newest.simulatorId }),
  };
}

function endedRow(
  record: SimulatorCatalogRecord,
  reason: SimulatorSessionEndReason,
): SimulatorEndedRow {
  return {
    kind: "ended",
    key: JSON.stringify(["ended", record.hostId, record.sessionId]),
    hostId: record.hostId,
    name: record.name,
    platform: record.platform,
    version: record.version,
    reason,
    record,
    tileId: simulatorTileId({
      hostId: record.hostId,
      simulatorId: record.simulatorId,
    }),
  };
}

function pendingRow(open: SimulatorPendingOpen): SimulatorPendingRow {
  return {
    kind: "pending",
    key: JSON.stringify(["pending", open.requestId]),
    hostId: open.hostId,
    name: open.name,
    platform: open.platform,
    version: open.version,
    requestId: open.requestId,
  };
}

/**
 * The task's rows from its catalog records and the person's pending opens,
 * grouped by machine.
 *
 * Live records group by (host, instance), one row per instance. Each ended
 * record is its own closed row keyed by its session, so an agent's archived
 * end beside the person's live session reads as one live row and one notice.
 * A pending open stays until the catalog lists its session; a Watch of an
 * instance that already has its row shows no second one.
 */
export function buildSimulatorListGroups(args: {
  readonly records: readonly SimulatorCatalogRecord[];
  readonly pending: readonly SimulatorPendingOpen[];
  readonly hosts: ReadonlyMap<string, HostScopeOption>;
  readonly localHostId: string | null;
}): readonly SimulatorDeviceGroupModel[] {
  const rowsByHost = new Map<string, SimulatorListRow[]>();
  const push = (hostId: string, row: SimulatorListRow): void => {
    const rows = rowsByHost.get(hostId) ?? [];
    rows.push(row);
    rowsByHost.set(hostId, rows);
  };
  const liveByInstance = new Map<string, SimulatorCatalogRecord[]>();
  const sessionIds = new Set<string>();
  for (const record of args.records) {
    sessionIds.add(JSON.stringify([record.hostId, record.sessionId]));
    if (record.endedReason !== null) continue;
    const key = JSON.stringify([record.hostId, record.instanceKey]);
    const group = liveByInstance.get(key) ?? [];
    group.push(record);
    liveByInstance.set(key, group);
  }
  const live = [...liveByInstance.values()].map((records) =>
    liveRow(records[0].hostId, records[0].instanceKey, records),
  );
  const liveInstances = new Set(
    live.map((row) => JSON.stringify([row.hostId, row.instanceKey])),
  );
  for (const row of live) push(row.hostId, row);
  for (const record of args.records) {
    if (record.endedReason === null) continue;
    push(record.hostId, endedRow(record, record.endedReason));
  }
  for (const open of args.pending) {
    if (
      open.sessionId !== null &&
      sessionIds.has(JSON.stringify([open.hostId, open.sessionId]))
    )
      continue;
    if (
      open.instanceKey !== null &&
      liveInstances.has(JSON.stringify([open.hostId, open.instanceKey]))
    )
      continue;
    push(open.hostId, pendingRow(open));
  }
  return [...rowsByHost]
    .filter(([hostId]) => args.hosts.get(hostId)?.health.state !== "removed")
    .map(([hostId, rows]) => ({
      hostId,
      name: args.hosts.get(hostId)?.name ?? hostId,
      isLocal: hostId === args.localHostId,
      offline: isBrowserDeviceOffline(args.hosts.get(hostId)),
      rows: rows.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

const COUNTDOWN_TICK_MS = 30_000;

/** The Mobile simulators panel's rows, shared by the rail panel and the switcher. */
export function useSimulatorListModel(epicId: string): SimulatorListModel {
  const catalog = useSimulatorCatalogContext();
  const byRequestId = useSimulatorPendingOpensStore(
    (state) => state.byRequestId,
  );
  const options = useHostOptions();
  const localHostId = useReactiveLocalHostId();
  const nowMs = useNowMs(COUNTDOWN_TICK_MS);
  const records = catalog?.scope === "cloud" ? catalog.records : null;
  const hosts = useMemo(
    () => new Map(options.hosts.map((host) => [host.hostId, host])),
    [options.hosts],
  );
  const groups = useMemo(
    () =>
      buildSimulatorListGroups({
        records: records ?? [],
        pending: simulatorPendingOpensForEpic(byRequestId, epicId),
        hosts,
        localHostId,
      }),
    [byRequestId, epicId, hosts, localHostId, records],
  );
  const status = catalog?.status ?? "ready";
  const rowCount = groups.reduce((count, group) => count + group.rows.length, 0);
  return {
    status,
    notReady: catalog?.scope === "not-ready",
    groups,
    rowCount,
    loading: status === "loading" && rowCount === 0,
    nowMs,
    refresh: catalog?.refetch ?? (() => undefined),
  };
}
