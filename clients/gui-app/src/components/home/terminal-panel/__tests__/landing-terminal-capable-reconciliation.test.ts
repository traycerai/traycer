import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ImportLegacyPlainTerminalRequest,
  PlainTerminalProjection,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  deletePlainTerminal,
  replacePlainTerminalSnapshot,
  setPlainTerminalStreamStatus,
  settlePlainTerminalSnapshot,
  type PlainTerminalCollection,
} from "@/lib/terminals/plain-terminal-authority";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import { reconcileCapableLandingTerminals } from "@/components/home/terminal-panel/use-landing-terminal-reconciliation";

const HOST_ID = "host-a";
const LANDING_PAGE_ID = "landing-a";
const SCOPE = { kind: "independent" } as const;
const CAPABILITY = {
  status: "capable",
  schemaVersion: { major: 1, minor: 0 },
} as const;

function tab(input: {
  readonly instanceId: string;
  readonly terminalId: string;
  readonly name: string;
}): LandingTerminalTabRef {
  return {
    instanceId: input.instanceId,
    sessionId: input.terminalId,
    hostId: HOST_ID,
    cwd: "/legacy/launch",
    name: input.name,
    titleSource: "manual",
  };
}

function terminal(input: {
  readonly terminalId: string;
  readonly manualTitle: string | null;
  readonly revision: number;
  readonly runtime: "running" | "dormant";
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: input.terminalId,
      hostId: HOST_ID,
      scope: SCOPE,
      launch: {
        cwd: "/host/launch",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: input.manualTitle,
      revision: input.revision,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:01:00.000Z",
    },
    runtime:
      input.runtime === "dormant"
        ? { status: "dormant" }
        : {
            status: "running",
            sessionId: input.terminalId,
            currentCwd: "/host/live",
            activeProcessName: "bun",
            cols: 100,
            rows: 30,
          },
  };
}

function freshCollection(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    settlePlainTerminalSnapshot(
      replacePlainTerminalSnapshot(undefined, terminals),
    ),
    "open",
  );
}

/** An open stream that has not yet settled a snapshot in this connection episode. */
function staleCollection(
  terminals: readonly PlainTerminalProjection[],
): PlainTerminalCollection {
  return setPlainTerminalStreamStatus(
    replacePlainTerminalSnapshot(undefined, terminals),
    "open",
  );
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

describe("capable landing-terminal reconciliation", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    window.localStorage.clear();
    useLandingTerminalStore.getState().resetForTests();
  });

  it("imports legacy evidence once and adopts the host's canonical winner", async () => {
    const legacy = tab({
      instanceId: "local-instance",
      terminalId: "terminal-1",
      name: "Local losing title",
    });
    const winner = terminal({
      terminalId: "terminal-1",
      manualTitle: "Remote winner",
      revision: 4,
      runtime: "running",
    });
    useLandingTerminalStore.getState().addTab(legacy);
    useLandingTerminalStore
      .getState()
      .setPanelWidthFraction(LANDING_PAGE_ID, 0.51);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );
    const importLegacy = vi.fn((request: ImportLegacyPlainTerminalRequest) => {
      expect(request).toMatchObject({
        terminalId: "terminal-1",
        hostId: HOST_ID,
        cwd: "/legacy/launch",
        name: "Local losing title",
        titleSource: "manual",
        sourceStoreVersion: 1,
      });
      queryClient.setQueryData(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
        freshCollection([winner]),
      );
      return Promise.resolve({ status: "existing" as const, terminal: winner });
    });

    await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal: () => Promise.resolve(),
      importLegacyTerminal: importLegacy,
      queryClient,
    });

    expect(importLegacy).toHaveBeenCalledTimes(1);
    const state = useLandingTerminalStore.getState();
    expect(state.tabs).toEqual([
      {
        ...legacy,
        cwd: "/host/launch",
        name: "Remote winner",
        hostAuthorityAcknowledged: true,
        pendingCreate: false,
        sourceStoreVersion: 1,
      },
    ]);
    expect(state.activeInstanceId).toBe("local-instance");
    expect(landingTerminalLayoutFor(state, LANDING_PAGE_ID)).toMatchObject({
      panelWidthFraction: 0.51,
    });
  });

  it("preserves unacknowledged evidence when import fails", async () => {
    const legacy = tab({
      instanceId: "local-instance",
      terminalId: "terminal-failure",
      name: "Keep me",
    });
    useLandingTerminalStore.getState().addTab(legacy);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );

    await expect(
      reconcileCapableLandingTerminals({
        activeHostId: HOST_ID,
        landingPageId: LANDING_PAGE_ID,
        capability: CAPABILITY,
        canMutate: true,
        closeTerminal: () => Promise.resolve(),
        importLegacyTerminal: () => Promise.reject(new Error("offline")),
        queryClient,
      }),
    ).rejects.toThrow("offline");

    expect(useLandingTerminalStore.getState().tabs).toEqual([legacy]);
  });

  it("retires a capable-host pending kill only after close acknowledgement", async () => {
    const canonical = {
      ...tab({
        instanceId: "local-instance",
        terminalId: "terminal-close",
        name: "Host title",
      }),
      hostAuthorityAcknowledged: true,
    };
    const projection = terminal({
      terminalId: "terminal-close",
      manualTitle: "Host title",
      revision: 3,
      runtime: "running",
    });
    useLandingTerminalStore.getState().addTab(canonical);
    useLandingTerminalStore
      .getState()
      .closeTab(LANDING_PAGE_ID, canonical.instanceId);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([projection]),
    );
    const closeTerminal = vi.fn(() => {
      queryClient.setQueryData(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
        freshCollection([]),
      );
      return Promise.resolve();
    });

    await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal,
      importLegacyTerminal: () =>
        Promise.reject(new Error("unexpected import")),
      queryClient,
    });

    expect(closeTerminal).toHaveBeenCalledWith({
      terminalId: "terminal-close",
    });
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
    expect(useLandingTerminalStore.getState().tabs).toEqual([]);
  });

  it("removes late-hydrated legacy evidence against a retained tombstone without importing", async () => {
    const legacy = tab({
      instanceId: "late-legacy",
      terminalId: "terminal-1",
      name: "Late evidence",
    });
    useLandingTerminalStore.getState().addTab(legacy);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      deletePlainTerminal(freshCollection([]), "terminal-1", 2),
    );
    const importLegacy = vi.fn(() =>
      Promise.reject(new Error("unexpected import")),
    );

    await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal: () => Promise.resolve(),
      importLegacyTerminal: importLegacy,
      queryClient,
    });

    expect(importLegacy).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().tabs).toEqual([]);
    expect(
      queryClient.getQueryData<PlainTerminalCollection>(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      )?.deletedRevisionById["terminal-1"],
    ).toBe(2);
  });

  it("returns snapshot-not-fresh instead of throwing while the stream has not settled", async () => {
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      staleCollection([]),
    );

    await expect(
      reconcileCapableLandingTerminals({
        activeHostId: HOST_ID,
        landingPageId: LANDING_PAGE_ID,
        capability: CAPABILITY,
        canMutate: true,
        closeTerminal: () => Promise.resolve(),
        importLegacyTerminal: () =>
          Promise.reject(new Error("unexpected import")),
        queryClient,
      }),
    ).resolves.toBe("snapshot-not-fresh");
    // A wait, not a failure: nothing in the store should be touched.
    expect(useLandingTerminalStore.getState().tabs).toEqual([]);
  });

  it("returns snapshot-not-fresh before closing a pending kill against a stale collection", async () => {
    const canonical = {
      ...tab({
        instanceId: "local-instance",
        terminalId: "terminal-close",
        name: "Host title",
      }),
      hostAuthorityAcknowledged: true,
    };
    const projection = terminal({
      terminalId: "terminal-close",
      manualTitle: "Host title",
      revision: 3,
      runtime: "running",
    });
    useLandingTerminalStore.getState().addTab(canonical);
    useLandingTerminalStore
      .getState()
      .closeTab(LANDING_PAGE_ID, canonical.instanceId);
    const tabsBefore = useLandingTerminalStore.getState().tabs;
    const pendingKillsBefore = useLandingTerminalStore.getState().pendingKills;
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      staleCollection([projection]),
    );
    const closeTerminal = vi.fn(() => Promise.resolve());

    await expect(
      reconcileCapableLandingTerminals({
        activeHostId: HOST_ID,
        landingPageId: LANDING_PAGE_ID,
        capability: CAPABILITY,
        canMutate: true,
        closeTerminal,
        importLegacyTerminal: () =>
          Promise.reject(new Error("unexpected import")),
        queryClient,
      }),
    ).resolves.toBe("snapshot-not-fresh");

    expect(closeTerminal).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().tabs).toEqual(tabsBefore);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual(
      pendingKillsBefore,
    );
  });

  it("returns snapshot-not-fresh before importing legacy evidence against a stale collection", async () => {
    const legacy = tab({
      instanceId: "local-instance",
      terminalId: "terminal-1",
      name: "Local title",
    });
    useLandingTerminalStore.getState().addTab(legacy);
    const tabsBefore = useLandingTerminalStore.getState().tabs;
    const pendingKillsBefore = useLandingTerminalStore.getState().pendingKills;
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      staleCollection([]),
    );
    const importLegacy = vi.fn(() =>
      Promise.reject(new Error("unexpected import")),
    );

    await expect(
      reconcileCapableLandingTerminals({
        activeHostId: HOST_ID,
        landingPageId: LANDING_PAGE_ID,
        capability: CAPABILITY,
        canMutate: true,
        closeTerminal: () => Promise.resolve(),
        importLegacyTerminal: importLegacy,
        queryClient,
      }),
    ).resolves.toBe("snapshot-not-fresh");

    expect(importLegacy).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().tabs).toEqual(tabsBefore);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual(
      pendingKillsBefore,
    );
  });

  it("does not import legacy evidence when freshness is lost during a pending close", async () => {
    const canonical = {
      ...tab({
        instanceId: "canonical-instance",
        terminalId: "terminal-close",
        name: "Host title",
      }),
      hostAuthorityAcknowledged: true,
    };
    const legacy = tab({
      instanceId: "legacy-instance",
      terminalId: "terminal-import",
      name: "Local title",
    });
    const projection = terminal({
      terminalId: "terminal-close",
      manualTitle: "Host title",
      revision: 3,
      runtime: "running",
    });
    const store = useLandingTerminalStore.getState();
    store.addTab(canonical);
    store.addTab(legacy);
    store.closeTab(LANDING_PAGE_ID, canonical.instanceId);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([projection]),
    );
    const pendingClose = deferred<unknown>();
    const closeTerminal = vi.fn(() => pendingClose.promise);
    const importLegacy = vi.fn(() =>
      Promise.reject(new Error("unexpected import")),
    );

    const reconciliation = reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal,
      importLegacyTerminal: importLegacy,
      queryClient,
    });
    await waitFor(() => expect(closeTerminal).toHaveBeenCalledTimes(1));

    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      staleCollection([projection]),
    );
    pendingClose.resolve(undefined);

    await expect(reconciliation).resolves.toBe("snapshot-not-fresh");
    expect(importLegacy).not.toHaveBeenCalled();
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.find((candidate) => candidate.instanceId === legacy.instanceId)
        ?.hostAuthorityAcknowledged,
    ).not.toBe(true);
  });

  it("returns reconciled after a successful pass", async () => {
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );

    await expect(
      reconcileCapableLandingTerminals({
        activeHostId: HOST_ID,
        landingPageId: LANDING_PAGE_ID,
        capability: CAPABILITY,
        canMutate: true,
        closeTerminal: () => Promise.resolve(),
        importLegacyTerminal: () =>
          Promise.reject(new Error("unexpected import")),
        queryClient,
      }),
    ).resolves.toBe("reconciled");
  });
});
