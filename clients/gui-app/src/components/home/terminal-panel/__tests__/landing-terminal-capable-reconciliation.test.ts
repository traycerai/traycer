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
  type LandingTerminalPendingKill,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import {
  drainLegacyLandingTombstones,
  reconcileCapableLandingTerminals,
} from "@/components/home/terminal-panel/use-landing-terminal-reconciliation";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";

const HOST_ID = "host-a";
const LANDING_PAGE_ID = "landing-a";
const SCOPE = { kind: "independent" } as const;
const CAPABILITY = {
  status: "capable",
  schemaVersion: { major: 2, minor: 1 },
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

  it("joins an in-flight close instead of racing the recovery bridge", async () => {
    // A retained tombstone whose create lands late wakes BOTH this pass and
    // `LandingTerminalTombstoneRecoveryBridge` on the same collection update.
    // `terminal.plain.close` is fifo rather than coalescing, so going straight
    // at the mutation is two real RPCs: the loser finds a terminal the winner
    // already removed and raises "Couldn't close the terminal." for a close
    // that succeeded.
    const canonical = {
      ...tab({
        instanceId: "shared-close-instance",
        terminalId: "terminal-shared-close",
        name: "Host title",
      }),
      hostAuthorityAcknowledged: true,
    };
    const projection = terminal({
      terminalId: "terminal-shared-close",
      manualTitle: "Host title",
      revision: 4,
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

    // Stand in for the bridge's close, already in flight for this identity.
    const bridgeGate = deferred<void>();
    const bridgeClose = vi.fn(() => bridgeGate.promise);
    void requestLandingTerminalClose({
      hostId: HOST_ID,
      sessionId: "terminal-shared-close",
      close: bridgeClose,
    });
    // The coordinator dispatches in a microtask, so wait for the request to be
    // genuinely in flight before the reconcile pass looks for it to join.
    await waitFor(() => expect(bridgeClose).toHaveBeenCalledTimes(1));

    const closeTerminal = vi.fn(() => Promise.resolve());
    const pass = reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal,
      importLegacyTerminal: () =>
        Promise.reject(new Error("unexpected import")),
      queryClient,
    });

    // The bridge's request is the only one on the wire.
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );
    bridgeGate.resolve(undefined);
    await pass;

    expect(bridgeClose).toHaveBeenCalledTimes(1);
    expect(closeTerminal).not.toHaveBeenCalled();
    // And it does NOT retire the record. The coordinator keys by the terminal's
    // lifetime rather than by RPC, so a joined promise may belong to a
    // `terminal.kill` - which answers an already-gone session with
    // `killed: false` as data, the one answer a `pendingCreate` tombstone is
    // deliberately kept for. Whoever owns the request owns that decision.
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("joins an in-flight kill on the legacy arm too", async () => {
    // Same class as the capable arm above, different RPC. `terminal.kill` does
    // not throw for a session the winner already removed - it answers
    // `killed: false`, which is the exact answer a `pendingCreate` reprieve has
    // to keep treating as ambiguous, so an unmediated duplicate is both two
    // `terminal.list` invalidations and a wasted reprieve answer.
    const pending: LandingTerminalPendingKill = {
      hostId: HOST_ID,
      sessionId: "terminal-legacy-shared",
      hostAuthorityAcknowledged: false,
      pendingCreate: true,
    };

    const bridgeGate = deferred<void>();
    const bridgeKill = vi.fn(() => bridgeGate.promise);
    void requestLandingTerminalClose({
      hostId: pending.hostId,
      sessionId: pending.sessionId,
      close: bridgeKill,
    });
    await waitFor(() => expect(bridgeKill).toHaveBeenCalledTimes(1));

    const killTerminal = vi.fn(() => Promise.resolve());
    const drain = drainLegacyLandingTombstones({
      hostTombstones: [pending],
      listedSessionIds: new Set([pending.sessionId]),
      killTerminal,
    });
    bridgeGate.resolve(undefined);
    await drain;

    expect(bridgeKill).toHaveBeenCalledTimes(1);
    expect(killTerminal).not.toHaveBeenCalled();
  });

  it("retains an unacknowledged tombstone the host's list does not mention", async () => {
    // The other half of the legacy arm, and the rule the whole PR turns on:
    // absence from the list retires an ACKNOWLEDGED record and nothing else.
    const acknowledged: LandingTerminalPendingKill = {
      hostId: HOST_ID,
      sessionId: "terminal-legacy-acked",
      hostAuthorityAcknowledged: true,
      pendingCreate: false,
    };
    const unsettledCreate: LandingTerminalPendingKill = {
      hostId: HOST_ID,
      sessionId: "terminal-legacy-creating",
      hostAuthorityAcknowledged: false,
      pendingCreate: true,
    };
    useLandingTerminalStore.setState({
      pendingKills: [acknowledged, unsettledCreate],
    });

    const killTerminal = vi.fn(() => Promise.resolve());
    await drainLegacyLandingTombstones({
      hostTombstones: [acknowledged, unsettledCreate],
      listedSessionIds: new Set(),
      killTerminal,
    });

    expect(killTerminal).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      unsettledCreate,
    ]);
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
      deletePlainTerminal(
        freshCollection([]),
        { hostId: HOST_ID, terminalId: "terminal-1" },
        2,
      ),
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
      )?.deletedRevisionByIdentity[JSON.stringify([HOST_ID, "terminal-1"])],
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
