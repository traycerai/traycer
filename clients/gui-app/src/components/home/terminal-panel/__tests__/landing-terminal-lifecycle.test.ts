import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  parsePersistedLandingTerminalState,
  terminalSessionKey,
  useLandingTerminalStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-terminal-store";
import { reconcileLandingTerminalTabs } from "@/components/home/terminal-panel/landing-terminal-reconciliation";
import { resolveLandingTerminalAvailability } from "@/components/home/terminal-panel/landing-terminal-availability";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

const HOST_A = "host-a";
const HOST_B = "host-b";

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
    useLandingTerminalStore.getState().setPanelOpen(true);

    expect(resolveLandingTerminalAvailability(null, undefined, null)).toBe(
      "no-active-host",
    );
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().panelOpen).toBe(true);
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
      tab({
        instanceId: "adopted-instance",
        sessionId: "orphan",
        hostId: HOST_A,
      }),
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
    const closed = useLandingTerminalStore.getState().closeTab("closed");
    expect(closed?.sessionId).toBe("session-close");

    const restored = parsePersistedLandingTerminalState({
      tabs: [],
      activeInstanceId: null,
      panelOpen: false,
      panelWidthFraction: 0.36,
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
});

describe("closeAllTabs", () => {
  beforeEach(() => {
    useLandingTerminalStore.getState().resetForTests();
  });

  it("tombstones every tab in one write and returns them for killing", () => {
    const store = useLandingTerminalStore.getState();
    store.addTab(tab({ instanceId: "a", sessionId: "s-a", hostId: HOST_A }));
    store.addTab(tab({ instanceId: "b", sessionId: "s-b", hostId: HOST_B }));

    const closed = useLandingTerminalStore.getState().closeAllTabs();

    // Tombstone-first durability: the refs are gone AND every session is
    // tombstoned by the time the caller gets them back to kill, so a reload
    // racing the kills can never re-adopt a closed shell as an orphan.
    expect(closed.map((entry) => entry.instanceId)).toEqual(["a", "b"]);
    const state = useLandingTerminalStore.getState();
    expect(state.tabs).toEqual([]);
    expect(state.activeInstanceId).toBeNull();
    expect(state.panelOpen).toBe(false);
    expect(state.pendingKills).toEqual([
      { hostId: HOST_A, sessionId: "s-a" },
      { hostId: HOST_B, sessionId: "s-b" },
    ]);
  });

  it("is a no-op with no tabs open", () => {
    useLandingTerminalStore.getState().setPanelOpen(true);

    expect(useLandingTerminalStore.getState().closeAllTabs()).toEqual([]);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
    expect(useLandingTerminalStore.getState().panelOpen).toBe(true);
  });
});
