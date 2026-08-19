import { beforeEach, describe, expect, it } from "vitest";
import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import {
  landingTerminalLayoutFor,
  parsePersistedLandingTerminalState,
  terminalSessionKey,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import {
  reconcileHostAuthoritativeLandingTerminalTabs,
  reconcileLandingTerminalTabs,
  resolveLandingTerminalSyncedTitle,
  resolveLandingTerminalTitleCwd,
} from "@/components/home/terminal-panel/landing-terminal-reconciliation";
import { resolveLandingTerminalAvailability } from "@/components/home/terminal-panel/landing-terminal-availability";
import {
  resolveLandingTerminalLaunchCwd,
  type LandingTerminalHostContext,
} from "@/components/home/terminal-panel/landing-terminal-host-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

const HOST_A = "host-a";
const HOST_B = "host-b";
const LANDING_PAGE_ID = "landing-page";

function tab(input: {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly hostId: string;
}): LandingTerminalTabRef {
  return {
    instanceId: input.instanceId,
    sessionId: input.sessionId,
    hostId: input.hostId,
    cwd: "/workspace/project",
    name: "project",
    titleSource: "default",
  };
}

function session(input: {
  readonly sessionId: string;
  readonly status: "running" | "exited";
}): CanonicalTerminalSessionInfo {
  return {
    sessionId: input.sessionId,
    scope: { kind: "independent" },
    sessionKind: "terminal",
    cwd: "/workspace/project",
    shellCommand: "zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: input.status,
    exitCode: input.status === "running" ? null : 0,
    exitReason: input.status === "running" ? null : "process-exit",
    createdAt: 1,
    title: null,
    activeProcessName: null,
  };
}

function liveSession(input: {
  readonly sessionId: string;
  readonly currentCwd: string;
  readonly activeProcessName: string | null;
}): CanonicalTerminalSessionInfoWithCurrentCwd {
  return {
    ...session({ sessionId: input.sessionId, status: "running" }),
    currentCwd: input.currentCwd,
    activeProcessName: input.activeProcessName,
  };
}

function plainTerminal(input: {
  readonly terminalId: string;
  readonly hostId: string;
  readonly launchCwd: string;
  readonly manualTitle: string | null;
  readonly runtime:
    | { readonly status: "dormant" }
    | {
        readonly status: "running";
        readonly currentCwd: string;
        readonly activeProcessName: string | null;
      };
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: input.terminalId,
      hostId: input.hostId,
      scope: { kind: "independent" },
      launch: {
        cwd: input.launchCwd,
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: input.manualTitle,
      revision: 2,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:01:00.000Z",
    },
    runtime:
      input.runtime.status === "dormant"
        ? { status: "dormant" }
        : {
            status: "running",
            sessionId: input.terminalId,
            currentCwd: input.runtime.currentCwd,
            activeProcessName: input.runtime.activeProcessName,
            cols: 100,
            rows: 30,
          },
  };
}

describe("landing terminal lifecycle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLandingTerminalStore.getState().resetForTests();
  });

  it("keeps probe capability states distinct", () => {
    expect(resolveLandingTerminalAvailability(null, undefined, null)).toBe(
      "no-active-host",
    );
    expect(resolveLandingTerminalAvailability(HOST_A, undefined, null)).toBe(
      "unknown",
    );
    expect(
      resolveLandingTerminalAvailability(
        HOST_A,
        undefined,
        new HostRpcError({
          code: "DOWNGRADE_UNSUPPORTED",
          message: "old host",
          requestId: "probe",
          method: "terminal.list",
          fatalDetails: null,
        }),
      ),
    ).toBe("unsupported");
    expect(
      resolveLandingTerminalAvailability(HOST_A, { sessions: [] }, null),
    ).toBe("supported");
  });

  it("preserves persisted state while no active host is selected", () => {
    useLandingTerminalStore
      .getState()
      .addTab(tab({ instanceId: "a", sessionId: "session-a", hostId: HOST_A }));
    useLandingTerminalStore.getState().setPanelOpen(LANDING_PAGE_ID, true);

    expect(resolveLandingTerminalAvailability(null, undefined, null)).toBe(
      "no-active-host",
    );
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(
      landingTerminalLayoutFor(
        useLandingTerminalStore.getState(),
        LANDING_PAGE_ID,
      ).panelOpen,
    ).toBe(true);
  });

  it("parses capable-host acknowledgement without discarding legacy import evidence", () => {
    expect(
      parsePersistedLandingTerminalState({
        tabs: [
          {
            ...tab({
              instanceId: "canonical",
              sessionId: "terminal-1",
              hostId: HOST_A,
            }),
            hostAuthorityAcknowledged: true,
            pendingCreate: true,
            sourceStoreVersion: 1,
          },
        ],
        activeInstanceId: "canonical",
        pendingKills: [],
      }).tabs,
    ).toEqual([
      {
        ...tab({
          instanceId: "canonical",
          sessionId: "terminal-1",
          hostId: HOST_A,
        }),
        hostAuthorityAcknowledged: true,
        pendingCreate: true,
        sourceStoreVersion: 1,
      },
    ]);
  });

  it("keeps local presentation order and selection while replacing capable-host semantics", () => {
    const first = {
      ...tab({
        instanceId: "first",
        sessionId: "terminal-1",
        hostId: HOST_A,
      }),
      cwd: "/stale/cwd",
      name: "Stale local name",
      titleSource: "default" as const,
    };
    const otherHost = tab({
      instanceId: "other-host",
      sessionId: "terminal-b",
      hostId: HOST_B,
    });
    const canonical = plainTerminal({
      terminalId: "terminal-1",
      hostId: HOST_A,
      launchCwd: "/canonical/launch",
      manualTitle: "Host title",
      runtime: {
        status: "running",
        currentCwd: "/canonical/live",
        activeProcessName: "vitest",
      },
    });
    const discovered = plainTerminal({
      terminalId: "terminal-2",
      hostId: HOST_A,
      launchCwd: "/discovered",
      manualTitle: null,
      runtime: { status: "dormant" },
    });

    const result = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [first, otherHost],
      activeInstanceId: "other-host",
      hostId: HOST_A,
      terminals: [canonical, discovered],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "discovered-instance",
    });

    expect(result.tabs.map((entry) => entry.instanceId)).toEqual([
      "first",
      "other-host",
      "discovered-instance",
    ]);
    expect(result.activeInstanceId).toBe("other-host");
    expect(result.tabs[0]).toMatchObject({
      instanceId: "first",
      sessionId: "terminal-1",
      hostId: HOST_A,
      cwd: "/canonical/launch",
      name: "Host title",
      titleSource: "manual",
      hostAuthorityAcknowledged: true,
      pendingCreate: false,
    });
    expect(result.tabs[1]).toEqual(otherHost);
    expect(result.tabs[2]).toMatchObject({
      sessionId: "terminal-2",
      cwd: "/discovered",
      name: "discovered · New Terminal",
      hostAuthorityAcknowledged: true,
    });
  });

  it("removes only acknowledged refs omitted by a capable host snapshot", () => {
    const acknowledged = {
      ...tab({
        instanceId: "acknowledged",
        sessionId: "deleted",
        hostId: HOST_A,
      }),
      hostAuthorityAcknowledged: true,
    };
    const legacyEvidence = tab({
      instanceId: "legacy",
      sessionId: "not-imported",
      hostId: HOST_A,
    });
    const result = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [acknowledged, legacyEvidence],
      activeInstanceId: "acknowledged",
      hostId: HOST_A,
      terminals: [],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    expect(result.tabs).toEqual([legacyEvidence]);
    expect(result.activeInstanceId).toBe("legacy");
    expect(result.exitedInstanceIds).toEqual(["acknowledged"]);
  });

  it("converges two client presentations on host rename and close without sharing order or selection", () => {
    const renamed = plainTerminal({
      terminalId: "shared-terminal",
      hostId: HOST_A,
      launchCwd: "/host/launch",
      manualTitle: "Renamed on host",
      runtime: {
        status: "running",
        currentCwd: "/host/live",
        activeProcessName: "bun",
      },
    });
    const clientAOther = tab({
      instanceId: "a-other",
      sessionId: "a-other-terminal",
      hostId: HOST_B,
    });
    const clientAShared = {
      ...tab({
        instanceId: "a-shared",
        sessionId: "shared-terminal",
        hostId: HOST_A,
      }),
      hostAuthorityAcknowledged: true,
    };
    const clientBShared = {
      ...tab({
        instanceId: "b-shared",
        sessionId: "shared-terminal",
        hostId: HOST_A,
      }),
      hostAuthorityAcknowledged: true,
    };
    const clientA = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [clientAOther, clientAShared],
      activeInstanceId: "a-other",
      hostId: HOST_A,
      terminals: [renamed],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused-a",
    });
    const clientB = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [clientBShared],
      activeInstanceId: "b-shared",
      hostId: HOST_A,
      terminals: [renamed],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused-b",
    });

    expect(clientA.tabs.map((entry) => entry.instanceId)).toEqual([
      "a-other",
      "a-shared",
    ]);
    expect(clientA.activeInstanceId).toBe("a-other");
    expect(clientB.activeInstanceId).toBe("b-shared");
    expect(clientA.tabs[1]?.name).toBe("Renamed on host");
    expect(clientB.tabs[0]?.name).toBe("Renamed on host");

    const closedA = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: clientA.tabs,
      activeInstanceId: clientA.activeInstanceId,
      hostId: HOST_A,
      terminals: [],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused-a-close",
    });
    const closedB = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: clientB.tabs,
      activeInstanceId: clientB.activeInstanceId,
      hostId: HOST_A,
      terminals: [],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused-b-close",
    });
    expect(closedA.tabs).toEqual([clientAOther]);
    expect(closedA.activeInstanceId).toBe("a-other");
    expect(closedB.tabs).toEqual([]);
    expect(closedB.activeInstanceId).toBeNull();
  });

  it("restores collapse, width, and fullscreen independently by landing page", () => {
    const restored = parsePersistedLandingTerminalState({
      tabs: [],
      activeInstanceId: null,
      layoutsByLandingPageId: {
        "draft-a": {
          panelOpen: false,
          panelWidthFraction: 0.3,
          maximized: false,
        },
        "draft-b": {
          panelOpen: true,
          panelWidthFraction: 0.48,
          maximized: true,
        },
      },
      pendingKills: [],
    });

    expect(landingTerminalLayoutFor(restored, "draft-a")).toEqual({
      panelOpen: false,
      panelWidthFraction: 0.3,
      maximized: false,
    });
    expect(landingTerminalLayoutFor(restored, "draft-b")).toEqual({
      panelOpen: true,
      panelWidthFraction: 0.48,
      maximized: true,
    });
  });

  it("collapses every open layout when the shared terminal set becomes empty", () => {
    const store = useLandingTerminalStore.getState();
    store.setPanelOpen("draft-a", true);
    store.setPanelOpen("draft-b", true);
    store.addTab(
      tab({ instanceId: "only", sessionId: "s-only", hostId: HOST_A }),
    );

    store.closeTab("draft-b", "only");

    const state = useLandingTerminalStore.getState();
    expect(landingTerminalLayoutFor(state, "draft-a").panelOpen).toBe(false);
    expect(landingTerminalLayoutFor(state, "draft-b").panelOpen).toBe(false);
  });

  it("preserves a v1 layout without coupling later page changes", () => {
    const restored = parsePersistedLandingTerminalState({
      tabs: [],
      activeInstanceId: null,
      panelOpen: true,
      panelWidthFraction: 0.48,
      pendingKills: [],
    });
    useLandingTerminalStore.setState(restored);

    expect(landingTerminalLayoutFor(restored, "draft-a")).toEqual({
      panelOpen: true,
      panelWidthFraction: 0.48,
      maximized: false,
    });

    useLandingTerminalStore.getState().setPanelOpen("draft-a", false);

    expect(
      landingTerminalLayoutFor(useLandingTerminalStore.getState(), "draft-a"),
    ).toMatchObject({ panelOpen: false, panelWidthFraction: 0.48 });
    expect(
      landingTerminalLayoutFor(useLandingTerminalStore.getState(), "draft-b"),
    ).toMatchObject({ panelOpen: true, panelWidthFraction: 0.48 });
  });

  it("adopts a running host session before any auto-spawn decision", () => {
    const result = reconcileLandingTerminalTabs({
      tabs: [],
      activeInstanceId: null,
      activeHostId: HOST_A,
      sessions: [session({ sessionId: "orphan", status: "running" })],
      excludedSessionKeys: new Set(),
      mintInstanceId: () => "adopted-instance",
    });

    expect(result.tabs).toEqual([
      {
        ...tab({
          instanceId: "adopted-instance",
          sessionId: "orphan",
          hostId: HOST_A,
        }),
        name: "project · New Terminal",
      },
    ]);
    expect(result.adoptedTabs).toHaveLength(1);
    // The panel uses this non-empty result to skip its final auto-spawn step.
    expect(result.tabs.length === 0).toBe(false);
  });

  it("suppresses adoption after an offline close and across a reload", () => {
    useLandingTerminalStore.getState().addTab(
      tab({
        instanceId: "closed",
        sessionId: "session-close",
        hostId: HOST_A,
      }),
    );
    const closed = useLandingTerminalStore
      .getState()
      .closeTab(LANDING_PAGE_ID, "closed");
    expect(closed?.sessionId).toBe("session-close");

    const restored = parsePersistedLandingTerminalState({
      tabs: [],
      activeInstanceId: null,
      layoutsByLandingPageId: {
        [LANDING_PAGE_ID]: {
          panelOpen: false,
          panelWidthFraction: 0.36,
          maximized: false,
        },
      },
      pendingKills: [{ hostId: HOST_A, sessionId: "session-close" }],
    });
    const result = reconcileLandingTerminalTabs({
      tabs: restored.tabs,
      activeInstanceId: restored.activeInstanceId,
      activeHostId: HOST_A,
      sessions: [session({ sessionId: "session-close", status: "running" })],
      excludedSessionKeys: new Set([
        terminalSessionKey(HOST_A, "session-close"),
      ]),
      mintInstanceId: () => "would-be-adopted",
    });

    expect(restored.pendingKills).toEqual([
      { hostId: HOST_A, sessionId: "session-close" },
    ]);
    expect(result.tabs).toEqual([]);
    expect(result.adoptedTabs).toEqual([]);
  });

  it("drops an exited session during restore instead of recreating it", () => {
    const result = reconcileLandingTerminalTabs({
      tabs: [tab({ instanceId: "exit", sessionId: "ended", hostId: HOST_A })],
      activeInstanceId: "exit",
      activeHostId: HOST_A,
      sessions: [session({ sessionId: "ended", status: "exited" })],
      excludedSessionKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    expect(result.tabs).toEqual([]);
    expect(result.exitedInstanceIds).toEqual(["exit"]);
    expect(result.collapseWhenEmpty).toBe(true);
  });

  it("re-keys a terminal-id collision without changing its bound host or cwd", () => {
    useLandingTerminalStore
      .getState()
      .addTab(
        tab({ instanceId: "collision", sessionId: "taken", hostId: HOST_A }),
      );
    useLandingTerminalStore.getState().rekeyTab("collision", "fresh");

    expect(useLandingTerminalStore.getState().tabs).toEqual([
      tab({ instanceId: "collision", sessionId: "fresh", hostId: HOST_A }),
    ]);
  });

  it("leaves other-host refs untouched while reconciling the active host", () => {
    const result = reconcileLandingTerminalTabs({
      tabs: [
        tab({ instanceId: "dead-host", sessionId: "remote", hostId: HOST_B }),
        tab({ instanceId: "active", sessionId: "current", hostId: HOST_A }),
      ],
      activeInstanceId: "dead-host",
      activeHostId: HOST_A,
      sessions: [session({ sessionId: "current", status: "running" })],
      excludedSessionKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    expect(result.tabs.map((entry) => entry.instanceId)).toEqual([
      "dead-host",
      "active",
    ]);
    expect(result.activeInstanceId).toBe("dead-host");
  });

  it("refreshes default titles from live metadata without overwriting manual names", () => {
    const defaultTab = tab({
      instanceId: "default",
      sessionId: "default-session",
      hostId: HOST_A,
    });
    const manualTab = {
      ...tab({
        instanceId: "manual",
        sessionId: "manual-session",
        hostId: HOST_A,
      }),
      name: "Pinned name",
      titleSource: "manual" as const,
    };
    useLandingTerminalStore.getState().addTab(defaultTab);
    useLandingTerminalStore.getState().addTab(manualTab);

    useLandingTerminalStore.getState().syncDefaultTitle("default", "gui · vim");
    useLandingTerminalStore.getState().syncDefaultTitle("manual", "gui · vim");

    expect(useLandingTerminalStore.getState().tabs).toEqual([
      { ...defaultTab, name: "gui · vim" },
      manualTab,
    ]);
  });

  it("falls back only until the live cwd field has been reported", () => {
    expect(
      resolveLandingTerminalTitleCwd({
        currentCwd: null,
        currentCwdReported: false,
        launchCwd: "/workspace/project",
      }),
    ).toBe("/workspace/project");
    expect(
      resolveLandingTerminalTitleCwd({
        currentCwd: null,
        currentCwdReported: true,
        launchCwd: "/workspace/project",
      }),
    ).toBeNull();
  });

  it("waits for the first stream snapshot before syncing a default title", () => {
    const streamState = {
      title: null,
      activeProcessName: "vim",
      currentCwd: "/workspace/project/packages/gui",
      currentCwdReported: true,
      launchCwd: "/workspace/project",
    };

    expect(
      resolveLandingTerminalSyncedTitle({
        ...streamState,
        snapshotLoaded: false,
      }),
    ).toBeNull();
    expect(
      resolveLandingTerminalSyncedTitle({
        ...streamState,
        snapshotLoaded: true,
      }),
    ).toBe("gui · vim");
  });

  it("reconciles default titles from the latest cwd and active process", () => {
    const defaultTab = tab({
      instanceId: "default",
      sessionId: "default-session",
      hostId: HOST_A,
    });
    const manualTab = {
      ...tab({
        instanceId: "manual",
        sessionId: "manual-session",
        hostId: HOST_A,
      }),
      name: "Pinned name",
      titleSource: "manual" as const,
    };
    const result = reconcileLandingTerminalTabs({
      tabs: [defaultTab, manualTab],
      activeInstanceId: "default",
      activeHostId: HOST_A,
      sessions: [
        liveSession({
          sessionId: "default-session",
          currentCwd: "/workspace/project/packages/gui",
          activeProcessName: "vim",
        }),
        liveSession({
          sessionId: "manual-session",
          currentCwd: "/workspace/project/packages/host",
          activeProcessName: "bun",
        }),
      ],
      excludedSessionKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    expect(result.tabs).toEqual([
      { ...defaultTab, name: "gui · vim" },
      manualTab,
    ]);
  });

  it("does not restore a launch-directory prefix for an explicit empty cwd", () => {
    const defaultTab = tab({
      instanceId: "default",
      sessionId: "default-session",
      hostId: HOST_A,
    });
    const result = reconcileLandingTerminalTabs({
      tabs: [defaultTab],
      activeInstanceId: "default",
      activeHostId: HOST_A,
      sessions: [
        liveSession({
          sessionId: "default-session",
          currentCwd: "",
          activeProcessName: "vim",
        }),
      ],
      excludedSessionKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    expect(result.tabs).toEqual([{ ...defaultTab, name: "vim" }]);
  });
});

describe("resolveLandingTerminalLaunchCwd", () => {
  const hostAHome: LandingTerminalHostContext = {
    hostId: HOST_A,
    homeCwd: "/Users/dev",
  };
  const hostANullHome: LandingTerminalHostContext = {
    hostId: HOST_A,
    homeCwd: null,
  };
  const hostBHome: LandingTerminalHostContext = {
    hostId: HOST_B,
    homeCwd: "/Users/other",
  };

  it("prefers the primary workspace over host home", () => {
    expect(
      resolveLandingTerminalLaunchCwd("/workspace/project", hostAHome, HOST_A),
    ).toBe("/workspace/project");
  });

  it("falls back to the reconciled active host home", () => {
    expect(resolveLandingTerminalLaunchCwd(null, hostAHome, HOST_A)).toBe(
      "/Users/dev",
    );
  });

  it("never returns another host's home path", () => {
    expect(resolveLandingTerminalLaunchCwd(null, hostBHome, HOST_A)).toBeNull();
    expect(resolveLandingTerminalLaunchCwd(null, hostAHome, HOST_B)).toBeNull();
  });

  it("returns null when homeCwd is bridged null or context is missing", () => {
    expect(
      resolveLandingTerminalLaunchCwd(null, hostANullHome, HOST_A),
    ).toBeNull();
    expect(resolveLandingTerminalLaunchCwd(null, null, HOST_A)).toBeNull();
    expect(resolveLandingTerminalLaunchCwd(null, hostAHome, null)).toBeNull();
  });
});

describe("closeAllTabs", () => {
  beforeEach(() => {
    useLandingTerminalStore.getState().resetForTests();
  });

  it("tombstones every tab in one write and returns them for killing", () => {
    const store = useLandingTerminalStore.getState();
    store.addTab(tab({ instanceId: "a", sessionId: "s-a", hostId: HOST_A }));
    store.addTab(tab({ instanceId: "b", sessionId: "s-b", hostId: HOST_B }));

    const closed = useLandingTerminalStore
      .getState()
      .closeAllTabs(LANDING_PAGE_ID);

    // Tombstone-first durability: the refs are gone AND every session is
    // tombstoned by the time the caller gets them back to kill, so a reload
    // racing the kills can never re-adopt a closed shell as an orphan.
    expect(closed.map((entry) => entry.instanceId)).toEqual(["a", "b"]);
    const state = useLandingTerminalStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeInstanceId).toBeNull();
    expect(landingTerminalLayoutFor(state, LANDING_PAGE_ID).panelOpen).toBe(
      false,
    );
    expect(state.pendingKills).toEqual([
      { hostId: HOST_A, sessionId: "s-a" },
      { hostId: HOST_B, sessionId: "s-b" },
    ]);
  });

  it("is a no-op with no tabs open", () => {
    useLandingTerminalStore.getState().setPanelOpen(LANDING_PAGE_ID, true);

    expect(
      useLandingTerminalStore.getState().closeAllTabs(LANDING_PAGE_ID),
    ).toEqual([]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
    expect(
      landingTerminalLayoutFor(
        useLandingTerminalStore.getState(),
        LANDING_PAGE_ID,
      ).panelOpen,
    ).toBe(true);
  });
});

describe("adoptHostTerminal", () => {
  beforeEach(() => {
    useLandingTerminalStore.getState().resetForTests();
  });

  it("rekeys a tab to the canonical terminal id returned by a capable host", () => {
    useLandingTerminalStore.getState().addTab(
      tab({
        instanceId: "local",
        sessionId: "legacy-evidence",
        hostId: HOST_A,
      }),
    );
    const canonical = plainTerminal({
      terminalId: "canonical-terminal",
      hostId: HOST_A,
      launchCwd: "/host/launch",
      manualTitle: "Host title",
      runtime: {
        status: "running",
        currentCwd: "/host/live",
        activeProcessName: "bun",
      },
    });

    // Matched on instanceId + hostId only: importLegacy's canonical winner may
    // carry a different terminalId than the legacy evidence sent, and this is
    // exactly the pointer swap `adoptHostTerminal` must still perform.
    useLandingTerminalStore.getState().adoptHostTerminal("local", canonical);

    expect(useLandingTerminalStore.getState().tabs).toEqual([
      {
        instanceId: "local",
        sessionId: "canonical-terminal",
        hostId: HOST_A,
        cwd: "/host/launch",
        name: "Host title",
        titleSource: "manual",
        hostAuthorityAcknowledged: true,
        pendingCreate: false,
        sourceStoreVersion: 1,
      },
    ]);
  });

  it("leaves a tab bound to a different host untouched", () => {
    const otherHostTab = tab({
      instanceId: "local",
      sessionId: "legacy-evidence",
      hostId: HOST_B,
    });
    useLandingTerminalStore.getState().addTab(otherHostTab);
    const canonical = plainTerminal({
      terminalId: "canonical-terminal",
      hostId: HOST_A,
      launchCwd: "/host/launch",
      manualTitle: null,
      runtime: { status: "dormant" },
    });

    useLandingTerminalStore.getState().adoptHostTerminal("local", canonical);

    expect(useLandingTerminalStore.getState().tabs).toEqual([otherHostTab]);
  });
});

describe("reconcileHostAuthoritativeLandingTerminalTabs identity reuse", () => {
  it("returns the original tab reference when acknowledged fields are unchanged", () => {
    const seed = tab({
      instanceId: "shared",
      sessionId: "terminal-1",
      hostId: HOST_A,
    });
    const projection = plainTerminal({
      terminalId: "terminal-1",
      hostId: HOST_A,
      launchCwd: "/host/launch",
      manualTitle: "Host title",
      runtime: {
        status: "running",
        currentCwd: "/host/live",
        activeProcessName: "bun",
      },
    });
    const first = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [seed],
      activeInstanceId: "shared",
      hostId: HOST_A,
      terminals: [projection],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused",
    }).tabs[0];

    const second = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [first],
      activeInstanceId: "shared",
      hostId: HOST_A,
      terminals: [projection],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    // Stream frames bump `projectionSequence` constantly, so an object
    // rebuilt on every pass would re-render every tab consumer for data that
    // never actually changed.
    expect(second.tabs[0]).toBe(first);

    const renamed = plainTerminal({
      terminalId: "terminal-1",
      hostId: HOST_A,
      launchCwd: "/host/launch",
      manualTitle: "Renamed on host",
      runtime: {
        status: "running",
        currentCwd: "/host/live",
        activeProcessName: "bun",
      },
    });
    const afterRename = reconcileHostAuthoritativeLandingTerminalTabs({
      tabs: [first],
      activeInstanceId: "shared",
      hostId: HOST_A,
      terminals: [renamed],
      excludedTerminalKeys: new Set(),
      mintInstanceId: () => "unused",
    });

    expect(afterRename.tabs[0]).not.toBe(first);
    expect(afterRename.tabs[0]?.name).toBe("Renamed on host");
  });
});
