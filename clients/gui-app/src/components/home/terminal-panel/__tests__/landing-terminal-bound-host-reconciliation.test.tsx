import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  ImportLegacyPlainTerminalRequest,
  PlainTerminalProjection,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
import {
  LandingTerminalBoundHostReconciliationFleet,
  type LandingTerminalBoundHostAuthorityEntry,
} from "@/components/home/terminal-panel/landing-terminal-bound-host-reconciliation";

const SCOPE = { kind: "independent" } as const;
const CAPABILITY = {
  status: "capable",
  schemaVersion: { major: 1, minor: 0 },
} as const;

function terminal(input: {
  readonly hostId: string;
  readonly terminalId: string;
  readonly title: string | null;
  readonly revision: number;
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: input.terminalId,
      hostId: input.hostId,
      scope: SCOPE,
      launch: {
        cwd: `/${input.hostId}/launch`,
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: input.title,
      revision: input.revision,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:01:00.000Z",
    },
    runtime: {
      status: "running",
      sessionId: input.terminalId,
      currentCwd: `/${input.hostId}/live`,
      activeProcessName: "bun",
      cols: 100,
      rows: 30,
    },
  };
}

function freshCollection(
  terminals: readonly PlainTerminalProjection[],
  current: PlainTerminalCollection | undefined,
): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(current, terminals),
    ),
    "open",
  );
}

function authorityEntry(input: {
  readonly collection: PlainTerminalCollection;
  readonly importLegacy: (
    request: ImportLegacyPlainTerminalRequest,
  ) => Promise<{
    readonly status: "existing";
    readonly terminal: PlainTerminalProjection;
  }>;
  readonly close: () => Promise<void>;
}): LandingTerminalBoundHostAuthorityEntry {
  return {
    authority: {
      capability: CAPABILITY,
      collection: input.collection,
      canMutate: true,
    },
    mutations: {
      importLegacy: { mutateAsync: input.importLegacy },
      close: { mutateAsync: input.close },
    },
  };
}

describe("<LandingTerminalBoundHostReconciliationFleet />", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    window.localStorage.clear();
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    useLandingTerminalStore.getState().resetForTests();
  });

  it("converges an inactive bound host without moving another host's presentation", async () => {
    const hostA = terminal({
      hostId: "host-a",
      terminalId: "terminal-a",
      title: "A",
      revision: 1,
    });
    const hostBWinner = terminal({
      hostId: "host-b",
      terminalId: "legacy-b",
      title: "Host B winner",
      revision: 2,
    });
    const hostBDiscovered = terminal({
      hostId: "host-b",
      terminalId: "discovered-b",
      title: "Discovered B",
      revision: 1,
    });
    const store = useLandingTerminalStore.getState();
    store.addTab({
      instanceId: "instance-a",
      sessionId: "terminal-a",
      hostId: "host-a",
      cwd: "/host-a/launch",
      name: "A",
      titleSource: "manual",
      hostAuthorityAcknowledged: true,
    });
    store.addTab({
      instanceId: "legacy-instance-b",
      sessionId: "legacy-b",
      hostId: "host-b",
      cwd: "/legacy/b",
      name: "Local B",
      titleSource: "manual",
    });
    store.activateTab("instance-a");
    store.setPanelOpen("landing-a", true);
    store.setPanelWidthFraction("landing-a", 0.43);

    const hostACollection = freshCollection([hostA], undefined);
    const initialHostBCollection = freshCollection(
      [hostBDiscovered],
      undefined,
    );
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals("host-a", SCOPE),
      hostACollection,
    );
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals("host-b", SCOPE),
      initialHostBCollection,
    );
    const importA = vi.fn(() => Promise.reject(new Error("wrong host")));
    const closeA = vi.fn(() => Promise.resolve());
    const closeB = vi.fn(() => Promise.resolve());
    // Recorded rather than asserted inline: a thrown assertion inside the
    // mock would surface as a rejected `importLegacy`, which the component
    // reads as a host failure and reports much later as "importB not called
    // once" instead of naming the field that broke.
    const importBRequests: ImportLegacyPlainTerminalRequest[] = [];
    const importB = vi.fn((request: ImportLegacyPlainTerminalRequest) => {
      importBRequests.push(request);
      queryClient.setQueryData(
        hostQueryKeys.plainTerminals("host-b", SCOPE),
        freshCollection([hostBWinner, hostBDiscovered], undefined),
      );
      return Promise.resolve({
        status: "existing" as const,
        terminal: hostBWinner,
      });
    });
    const entries = {
      "host-a": authorityEntry({
        collection: hostACollection,
        importLegacy: importA,
        close: closeA,
      }),
      "host-b": authorityEntry({
        collection: initialHostBCollection,
        importLegacy: importB,
        close: closeB,
      }),
    };
    const ui = (selectedHostId: string): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <LandingTerminalBoundHostReconciliationFleet
          landingPageId="landing-a"
          selectedHostId={selectedHostId}
          entries={entries}
        />
      </QueryClientProvider>
    );
    const view = render(ui("host-a"));

    await waitFor(() => {
      expect(importB).toHaveBeenCalledTimes(1);
      expect(
        useLandingTerminalStore.getState().tabs.map((tab) => tab.sessionId),
      ).toEqual(["terminal-a", "legacy-b", "discovered-b"]);
    });
    expect(importBRequests[0]).toMatchObject({
      hostId: "host-b",
      terminalId: "legacy-b",
      cwd: "/legacy/b",
      name: "Local B",
    });
    let state = useLandingTerminalStore.getState();
    expect(state.tabs[1]).toMatchObject({
      hostId: "host-b",
      name: "Host B winner",
      hostAuthorityAcknowledged: true,
    });
    expect(state.activeInstanceId).toBe("instance-a");
    expect(landingTerminalLayoutFor(state, "landing-a")).toMatchObject({
      panelOpen: true,
      panelWidthFraction: 0.43,
    });
    expect(importA).not.toHaveBeenCalled();
    expect(closeA).not.toHaveBeenCalled();

    const renamedWinner = terminal({
      hostId: "host-b",
      terminalId: "legacy-b",
      title: "Renamed on client B",
      revision: 3,
    });
    const renamedCollection = freshCollection(
      [renamedWinner, hostBDiscovered],
      queryClient.getQueryData(hostQueryKeys.plainTerminals("host-b", SCOPE)),
    );
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals("host-b", SCOPE),
      renamedCollection,
    );
    entries["host-b"] = authorityEntry({
      collection: renamedCollection,
      importLegacy: importB,
      close: closeB,
    });
    view.rerender(ui("host-a"));
    await waitFor(() => {
      expect(
        useLandingTerminalStore
          .getState()
          .tabs.find((tab) => tab.sessionId === "legacy-b")?.name,
      ).toBe("Renamed on client B");
    });

    const deletionCollection = freshCollection(
      [hostBDiscovered],
      renamedCollection,
    );
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals("host-b", SCOPE),
      deletionCollection,
    );
    entries["host-b"] = authorityEntry({
      collection: deletionCollection,
      importLegacy: importB,
      close: closeB,
    });
    view.rerender(ui("host-a"));
    await waitFor(() => {
      expect(
        useLandingTerminalStore.getState().tabs.map((tab) => tab.sessionId),
      ).toEqual(["terminal-a", "discovered-b"]);
    });

    act(() => view.rerender(ui("host-b")));
    state = useLandingTerminalStore.getState();
    expect(state.tabs.map((tab) => tab.hostId)).toEqual(["host-a", "host-b"]);
    expect(state.activeInstanceId).toBe("instance-a");
    expect(landingTerminalLayoutFor(state, "landing-a")).toMatchObject({
      panelOpen: true,
      panelWidthFraction: 0.43,
    });
    expect(importA).not.toHaveBeenCalled();
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
  });
});
