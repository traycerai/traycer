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
import { reconcileLandingTerminalTabs } from "@/components/home/terminal-panel/landing-terminal-reconciliation";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";

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
      providerLoginProviderFor: () => null,
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

  it("never imports a tab the sign-in registry claims, even though its ref lost the marker", async () => {
    // The shape this arm cannot otherwise tell from legacy evidence: adopted
    // while the host still read `legacy` (so no marker), and after the
    // capability switch unacknowledged AND unprojected. `importLegacy` under
    // its id would hand the plain registry a session the host's provider-login
    // manager owns and it never spawned; the ref left unmarked then routes its
    // tile to the durable bootstrap, which `terminal.plain.create`s a bare
    // shell with none of the provider's spawn env.
    const unmarked = tab({
      instanceId: "local-instance",
      terminalId: "signin-terminal",
      name: "legacy · New Terminal",
    });
    useLandingTerminalStore.getState().addTab(unmarked);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );
    const importLegacy = vi.fn(() => {
      throw new Error("importLegacy must never run for a sign-in session");
    });

    const outcome = await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal: () => Promise.resolve(),
      importLegacyTerminal: importLegacy,
      providerLoginProviderFor: (sessionId) =>
        sessionId === "signin-terminal" ? "reasonix" : null,
      queryClient,
    });

    expect(outcome).toBe("reconciled");
    expect(importLegacy).not.toHaveBeenCalled();
    // Reclassified in the store too, so every downstream reader - the tile's
    // adopt-only branch, the panel's kill-instead-of-close path - agrees.
    expect(useLandingTerminalStore.getState().tabs).toEqual([
      {
        ...unmarked,
        name: "Reasonix sign-in",
        titleSource: "manual",
        origin: "provider-login",
        originProviderId: "reasonix",
      },
    ]);
  });

  it("still imports an unacknowledged tab the sign-in registry does not claim", async () => {
    // The control for the test above: identical tab and identical snapshot,
    // only the registry's answer differs.
    const legacy = tab({
      instanceId: "local-instance",
      terminalId: "signin-terminal",
      name: "legacy · New Terminal",
    });
    useLandingTerminalStore.getState().addTab(legacy);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );
    const imported = terminal({
      terminalId: "signin-terminal",
      manualTitle: "Imported",
      revision: 3,
      runtime: "dormant",
    });
    const importLegacy = vi.fn(() => {
      queryClient.setQueryData(
        hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
        freshCollection([imported]),
      );
      return Promise.resolve({
        status: "existing" as const,
        terminal: imported,
      });
    });

    await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal: () => Promise.resolve(),
      importLegacyTerminal: importLegacy,
      providerLoginProviderFor: () => null,
      queryClient,
    });

    expect(importLegacy).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      instanceId: "local-instance",
      hostAuthorityAcknowledged: true,
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.origin).toBeUndefined();
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
        providerLoginProviderFor: () => null,
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
      providerLoginProviderFor: () => null,
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
      providerLoginProviderFor: () => null,
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
      providerLoginProviderFor: () => null,
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
        providerLoginProviderFor: () => null,
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
        providerLoginProviderFor: () => null,
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
        providerLoginProviderFor: () => null,
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
      providerLoginProviderFor: () => null,
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

  it("never imports a provider-login tab as legacy evidence, while an ordinary unacknowledged tab still is", async () => {
    const ordinary = tab({
      instanceId: "ordinary-instance",
      terminalId: "terminal-ordinary",
      name: "Ordinary title",
    });
    const signIn: LandingTerminalTabRef = {
      ...tab({
        instanceId: "sign-in-instance",
        terminalId: "terminal-signin",
        name: "Reasonix sign-in",
      }),
      origin: "provider-login",
      originProviderId: "reasonix",
    };
    useLandingTerminalStore.getState().addTab(ordinary);
    useLandingTerminalStore.getState().addTab(signIn);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );
    const importLegacy = vi.fn((request: ImportLegacyPlainTerminalRequest) => {
      expect(request.terminalId).toBe("terminal-ordinary");
      return Promise.resolve({
        status: "existing" as const,
        terminal: terminal({
          terminalId: "terminal-ordinary",
          manualTitle: "Ordinary title",
          revision: 1,
          runtime: "running",
        }),
      });
    });

    await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal: () => Promise.resolve(),
      importLegacyTerminal: importLegacy,
      providerLoginProviderFor: () => null,
      queryClient,
    });

    // The provider-login sign-in tab is manager-owned - it must never reach
    // `importLegacyTerminal`, however many ordinary legacy tabs get imported.
    expect(importLegacy).toHaveBeenCalledTimes(1);
    expect(importLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "terminal-ordinary" }),
    );
    const signInAfter = useLandingTerminalStore
      .getState()
      .tabs.find((candidate) => candidate.instanceId === signIn.instanceId);
    expect(signInAfter).toEqual(signIn);
  });

  it("never imports an ADOPTED provider-login tab as legacy evidence either", async () => {
    // Built the way reconciliation actually produces one - through
    // `reconcileLandingTerminalTabs`'s adoption path (an unmatched running
    // session whose `providerLoginProviderFor` resolves a provider) - rather
    // than hand-assembling the `origin`/`originProviderId` shape as the test
    // above does. This is the tab a real reload-then-reconnect sequence would
    // hand to this function: adopted while the host was legacy, then reaching
    // the capable importLegacy pass on a later, capable reconciliation.
    const signInSession: CanonicalTerminalSessionInfo = {
      sessionId: "terminal-signin-adopted",
      scope: { kind: "independent" },
      sessionKind: "terminal",
      cwd: "/host/launch",
      shellCommand: "zsh",
      shellArgs: [],
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      exitReason: null,
      createdAt: 1,
      title: null,
      activeProcessName: null,
    };
    const adoption = reconcileLandingTerminalTabs({
      tabs: [],
      activeInstanceId: null,
      activeHostId: HOST_ID,
      sessions: [signInSession],
      excludedSessionKeys: new Set(),
      mintInstanceId: () => "sign-in-adopted-instance",
      providerLoginProviderFor: () => "reasonix",
    });
    const signIn = adoption.adoptedTabs.at(0);
    if (signIn === undefined) {
      throw new Error(
        "expected reconcileLandingTerminalTabs to adopt a sign-in tab",
      );
    }
    expect(signIn.origin).toBe("provider-login");

    const ordinary = tab({
      instanceId: "ordinary-instance-2",
      terminalId: "terminal-ordinary-2",
      name: "Ordinary title",
    });
    useLandingTerminalStore.getState().addTab(ordinary);
    useLandingTerminalStore.getState().addTab(signIn);
    queryClient.setQueryData(
      hostQueryKeys.plainTerminals(HOST_ID, SCOPE),
      freshCollection([]),
    );
    const importLegacy = vi.fn((request: ImportLegacyPlainTerminalRequest) => {
      expect(request.terminalId).toBe("terminal-ordinary-2");
      return Promise.resolve({
        status: "existing" as const,
        terminal: terminal({
          terminalId: "terminal-ordinary-2",
          manualTitle: "Ordinary title",
          revision: 1,
          runtime: "running",
        }),
      });
    });

    await reconcileCapableLandingTerminals({
      activeHostId: HOST_ID,
      landingPageId: LANDING_PAGE_ID,
      capability: CAPABILITY,
      canMutate: true,
      closeTerminal: () => Promise.resolve(),
      importLegacyTerminal: importLegacy,
      providerLoginProviderFor: () => null,
      queryClient,
    });

    // Same guarantee as the hand-built case above, now proven for the shape
    // adoption actually produces.
    expect(importLegacy).toHaveBeenCalledTimes(1);
    expect(importLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "terminal-ordinary-2" }),
    );
    const signInAfterAdoption = useLandingTerminalStore
      .getState()
      .tabs.find((candidate) => candidate.instanceId === signIn.instanceId);
    expect(signInAfterAdoption).toEqual(signIn);
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
        providerLoginProviderFor: () => null,
        queryClient,
      }),
    ).resolves.toBe("reconciled");
  });
});
