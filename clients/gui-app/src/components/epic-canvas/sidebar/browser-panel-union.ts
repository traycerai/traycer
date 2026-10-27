import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserReplicaTab,
  BrowserSessionReplica,
} from "@traycer/protocol/host/browser/replicas";
import { TASK_HOST_UNNAMED_LABEL } from "@/components/epic-canvas/sidebar/task-host-groups-model";
import { resolveTabTitle } from "@/lib/browser-view/browser-tab-display";
import { compositeKey } from "@/lib/browser-view/tiles/browser-view-keys";

/** One host's `browser.sessions` inventory, as the panel holds it. */
export interface BrowserLiveInventory {
  readonly hostId: string | null;
  /**
   * The stream is connected and has delivered its full snapshot, so its list
   * is the whole truth about its host.
   */
  readonly isLive: boolean;
  readonly sessions: readonly BrowserSessionInfo[];
}

export interface BrowserPanelSessions {
  readonly live: readonly BrowserSessionInfo[];
  readonly replicas: readonly BrowserSessionReplica[];
}

/**
 * The panel's sessions: every live inventory it holds, plus the replicas of
 * sessions on other machines.
 *
 * A session in both is listed once, from its live inventory: live wins by
 * (hostId, sessionId), since it carries the tab state a replica cannot. A
 * replica whose host has a live inventory here is dropped even when that
 * inventory lacks it: a connected stream with its snapshot is the whole truth
 * about its host, so a replica it does not name is a session that closed
 * before the replica caught up. While that stream is not live, the replica
 * stays, because the stream's list may be stale or empty.
 */
export function unionBrowserPanelSessions(input: {
  readonly inventories: readonly BrowserLiveInventory[];
  readonly replicas: readonly BrowserSessionReplica[];
}): BrowserPanelSessions {
  const live: BrowserSessionInfo[] = [];
  const liveKeys = new Set<string>();
  const authoritativeHostIds = new Set<string>();
  const seenHostIds = new Set<string>();
  for (const inventory of input.inventories) {
    if (inventory.hostId === null || seenHostIds.has(inventory.hostId)) {
      continue;
    }
    seenHostIds.add(inventory.hostId);
    if (inventory.isLive) authoritativeHostIds.add(inventory.hostId);
    for (const session of inventory.sessions) {
      const key = compositeKey(session.hostId, session.sessionId);
      if (liveKeys.has(key)) continue;
      liveKeys.add(key);
      live.push(session);
    }
  }
  const replicas = input.replicas.filter(
    (replica) =>
      !authoritativeHostIds.has(replica.hostId) &&
      !liveKeys.has(compositeKey(replica.hostId, replica.sessionId)),
  );
  return { live, replicas };
}

/** A replica's tab as a panel row. */
export interface BrowserReplicaTabRow {
  readonly key: string;
  readonly replica: BrowserSessionReplica;
  readonly tab: BrowserReplicaTab;
}

export function browserReplicaTabRows(
  replicas: readonly BrowserSessionReplica[],
): readonly BrowserReplicaTabRow[] {
  return replicas.flatMap((replica) =>
    replica.tabs.map((tab) => ({
      key: compositeKey(replica.hostId, replica.sessionId, tab.tabId),
      replica,
      tab,
    })),
  );
}

/** Rows whose title or URL contains `query`, as the live rows are searched. */
export function filterBrowserReplicaTabRows(
  rows: readonly BrowserReplicaTabRow[],
  query: string,
): readonly BrowserReplicaTabRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter(({ tab }) =>
    `${resolveTabTitle(tab)} ${tab.url}`.toLocaleLowerCase().includes(needle),
  );
}

/** The refusal an open of an offline machine's browser gets. */
export function offlineBrowserRefusal(machineLabel: string): string {
  return `This browser is on ${machineLabel}, which is offline.`;
}

/** The directory's word on one host, as the panel needs it. */
export interface BrowserPanelHostFacts {
  /** The directory label, or `null` when the directory does not name it. */
  readonly label: string | null;
  /** The directory reports the host `offline`. */
  readonly offline: boolean;
}

/**
 * The rows on one machine. The group shape the Agents panel's host groups use
 * (`TaskHostGroup`: a key, a title, rows), with the machine's offline state.
 */
export interface BrowserMachineGroup<Row> {
  readonly key: string;
  readonly hostId: string;
  readonly title: string;
  readonly offline: boolean;
  readonly rows: readonly Row[];
}

/**
 * Rows grouped by the machine they run on: the panel's own host first, then
 * the rest by title. Rows keep their order inside a group. A host the
 * directory does not name reads as unnamed, as in the Agents panel.
 */
export function browserMachineGroups<Row>(input: {
  readonly rows: readonly Row[];
  readonly hostIdOf: (row: Row) => string;
  readonly panelHostId: string | null;
  readonly hostFacts: (hostId: string) => BrowserPanelHostFacts;
}): readonly BrowserMachineGroup<Row>[] {
  const rowsByHostId = new Map<string, Row[]>();
  for (const row of input.rows) {
    const hostId = input.hostIdOf(row);
    const rows = rowsByHostId.get(hostId) ?? [];
    rows.push(row);
    rowsByHostId.set(hostId, rows);
  }
  return [...rowsByHostId]
    .map(([hostId, rows]) => {
      const facts = input.hostFacts(hostId);
      return {
        key: hostId,
        hostId,
        title:
          facts.label === null || facts.label === hostId
            ? TASK_HOST_UNNAMED_LABEL
            : facts.label,
        offline: facts.offline,
        rows,
      };
    })
    .sort(
      (left, right) =>
        Number(right.hostId === input.panelHostId) -
          Number(left.hostId === input.panelHostId) ||
        left.title.localeCompare(right.title) ||
        left.hostId.localeCompare(right.hostId),
    );
}
