import { describe, expect, it } from "vitest";
import type { BrowserSessionReplica } from "@traycer/protocol/host/browser/replicas";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  browserMachineGroups,
  unionBrowserPanelSessions,
} from "@/components/epic-canvas/sidebar/browser-panel-union";
import { TASK_HOST_UNNAMED_LABEL } from "@/components/epic-canvas/sidebar/task-host-groups-model";

function replica(
  overrides: Pick<BrowserSessionReplica, "hostId" | "sessionId">,
): BrowserSessionReplica {
  return {
    profile: "primary",
    lastActivityAt: 1,
    tabs: [{ tabId: "tab-1", url: "https://replica.example", title: null }],
    ...overrides,
  };
}

describe("unionBrowserPanelSessions", () => {
  it("lists a session in both a live inventory and the replicas once, from the live inventory", () => {
    const live = sessionInfo({
      sessionId: "sess-1",
      hostId: "host-t",
      tabs: [tabInfo({ tabId: "tab-live", url: "https://live.example" })],
    });

    const result = unionBrowserPanelSessions({
      inventories: [{ hostId: "host-t", isLive: false, sessions: [live] }],
      replicas: [replica({ hostId: "host-t", sessionId: "sess-1" })],
    });

    expect(result.live).toEqual([live]);
    expect(result.replicas).toEqual([]);
  });

  it("drops a replica its host's live inventory lacks, and keeps it while that inventory is not live", () => {
    const orphan = replica({ hostId: "host-t", sessionId: "sess-closed" });

    const whileLive = unionBrowserPanelSessions({
      inventories: [{ hostId: "host-t", isLive: true, sessions: [] }],
      replicas: [orphan],
    });
    const whileNotLive = unionBrowserPanelSessions({
      inventories: [{ hostId: "host-t", isLive: false, sessions: [] }],
      replicas: [orphan],
    });

    expect(whileLive.replicas).toEqual([]);
    expect(whileNotLive.replicas).toEqual([orphan]);
  });
});

describe("browserMachineGroups", () => {
  const facts: Record<string, { label: string | null; offline: boolean }> = {
    "host-panel": { label: "Zeta Mac", offline: false },
    "host-b": { label: "Beta Mac", offline: true },
    "host-a": { label: "Alpha Mac", offline: false },
    "host-unnamed": { label: null, offline: false },
    "host-label-is-id": { label: "host-label-is-id", offline: false },
  };

  it("puts the panel host first, sorts the rest by title, and names unlabelled hosts as unnamed", () => {
    const groups = browserMachineGroups({
      rows: [
        "host-b",
        "host-unnamed",
        "host-a",
        "host-panel",
        "host-label-is-id",
      ],
      hostIdOf: (row) => row,
      panelHostId: "host-panel",
      hostFacts: (hostId) => facts[hostId],
    });

    expect(
      groups.map((group) => ({
        hostId: group.hostId,
        title: group.title,
        offline: group.offline,
      })),
    ).toEqual([
      { hostId: "host-panel", title: "Zeta Mac", offline: false },
      { hostId: "host-a", title: "Alpha Mac", offline: false },
      { hostId: "host-b", title: "Beta Mac", offline: true },
      {
        hostId: "host-label-is-id",
        title: TASK_HOST_UNNAMED_LABEL,
        offline: false,
      },
      {
        hostId: "host-unnamed",
        title: TASK_HOST_UNNAMED_LABEL,
        offline: false,
      },
    ]);
  });
});
