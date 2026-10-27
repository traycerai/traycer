import { useCallback, useMemo } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostUnavailability } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { BrowserSessionReplica } from "@traycer/protocol/host/browser/replicas";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useBrowserSessionsForHost } from "@/components/epic-canvas/renderers/use-browser-sessions";
import {
  unionBrowserPanelSessions,
  type BrowserPanelHostFacts,
  type BrowserPanelSessions,
} from "@/components/epic-canvas/sidebar/browser-panel-union";
import { useBrowserReplicasQuery } from "@/hooks/browser/use-browser-replicas-query";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";

const NO_REPLICAS: readonly BrowserSessionReplica[] = [];
const NO_DIRECTORY: readonly HostDirectoryEntry[] = [];

type CloseTab = BrowserSessionsState["closeTab"];

export interface BrowserPanelSources {
  readonly sessions: BrowserPanelSessions;
  readonly hostFacts: (hostId: string) => BrowserPanelHostFacts;
  /** The close of the live stream that holds `hostId`'s sessions. */
  readonly closeTabOn: (hostId: string) => CloseTab;
}

function isInventoryLive(sessions: BrowserSessionsState): boolean {
  return sessions.lifecycle === "live" && sessions.inventoryReady;
}

/**
 * Everything the Browsers panel lists: the panel host's live stream, the
 * canvas host's live stream when the panel shows another machine, and the
 * canvas host's replicas of the person's sessions on their other machines.
 *
 * The canvas host serves the replicas because it holds the task open, which
 * is what keeps its copies current. Its own sessions are never among them, so
 * its live stream is read as well, through the stream the canvas already
 * holds.
 */
export function useBrowserPanelSessions(args: {
  readonly epicId: string;
  readonly panelSessions: BrowserSessionsState;
  readonly panelHostId: string | null;
}): BrowserPanelSources {
  const { panelSessions } = args;
  const canvasHostId = useCanvasHostId();
  const canvasSessions = useBrowserSessionsForHost({
    hostId: canvasHostId === args.panelHostId ? null : canvasHostId,
    scope: { kind: "epic", epicId: args.epicId },
  });
  const replicas =
    useBrowserReplicasQuery({ epicId: args.epicId, hostId: canvasHostId }).data
      ?.sessions ?? NO_REPLICAS;
  const sessions = useMemo(
    () =>
      unionBrowserPanelSessions({
        inventories: [
          {
            hostId: panelSessions.hostId,
            isLive: isInventoryLive(panelSessions),
            sessions: panelSessions.items,
          },
          {
            hostId: canvasSessions.hostId,
            isLive: isInventoryLive(canvasSessions),
            sessions: canvasSessions.items,
          },
        ],
        replicas,
      }),
    [canvasSessions, panelSessions, replicas],
  );
  const directory = useHostDirectoryList().data ?? NO_DIRECTORY;
  const hostFacts = useCallback(
    (hostId: string): BrowserPanelHostFacts => {
      const entry = directory.find((row) => row.hostId === hostId) ?? null;
      return {
        label: entry?.label ?? null,
        offline: entry !== null && hostUnavailability(entry) === "offline",
      };
    },
    [directory],
  );
  const closeTabOn = useCallback(
    (hostId: string): CloseTab =>
      hostId === canvasSessions.hostId
        ? canvasSessions.closeTab
        : panelSessions.closeTab,
    [canvasSessions, panelSessions],
  );
  return { sessions, hostFacts, closeTabOn };
}
