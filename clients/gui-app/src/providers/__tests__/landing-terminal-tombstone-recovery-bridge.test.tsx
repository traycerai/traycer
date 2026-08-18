import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

const mocks = vi.hoisted(() => {
  const initialAuthorityStatus = (): "legacy" | "capable" | "unknown" =>
    "legacy";
  const terminalsById: Readonly<Record<string, unknown>> = {};
  return {
    entries: [] as readonly HostDirectoryEntry[],
    kill: vi.fn(),
    readySessionHosts: new Set<string>(),
    authorityStatus: initialAuthorityStatus(),
    canMutate: false,
    terminalsById,
    closeAsync: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: mocks.entries }),
}));
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => ({ mutate: mocks.kill }),
  }),
);
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-authority-fleet",
  async () => {
    const { useEffect } = await import("react");
    return {
      LandingTerminalAuthorityFleet: (props: {
        readonly hostIds: readonly string[];
        readonly onEntry: (hostId: string, entry: unknown) => void;
      }) => {
        const { onEntry } = props;
        const hostKey = props.hostIds.join("\u0000");
        useEffect(() => {
          const hostIds = hostKey.length === 0 ? [] : hostKey.split("\u0000");
          hostIds.forEach((hostId) => {
            onEntry(hostId, {
              authority: {
                capability:
                  mocks.authorityStatus === "capable"
                    ? {
                        status: "capable",
                        schemaVersion: { major: 1, minor: 0 },
                      }
                    : { status: mocks.authorityStatus },
                canMutate: mocks.canMutate,
                collection: { terminalsById: mocks.terminalsById },
              },
              mutations: { close: { mutateAsync: mocks.closeAsync } },
            });
          });
          return () => {
            hostIds.forEach((hostId) => onEntry(hostId, null));
          };
        }, [hostKey, onEntry]);
        return null;
      },
    };
  },
);
// The ready-session evidence the bridge now subscribes to; the poll hook
// re-reads it on its tick, so tests drive it with fake timers.
vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    return {
      ...actual,
      hasReadyRemoteSession: (hostId: string) =>
        mocks.readySessionHosts.has(hostId),
    };
  },
);

import { LandingTerminalTombstoneRecoveryBridge } from "@/providers/landing-terminal-tombstone-recovery-bridge";

const offlineHost: HostDirectoryEntry = {
  hostId: "host-b",
  label: "Host B",
  kind: "remote",
  websocketUrl: null,
  version: "1.0.0",
  transportDialability: "not-dialable",
};

describe("<LandingTerminalTombstoneRecoveryBridge />", () => {
  beforeEach(() => {
    mocks.entries = [offlineHost];
    mocks.kill.mockReset();
    mocks.readySessionHosts = new Set();
    mocks.authorityStatus = "legacy";
    mocks.canMutate = false;
    mocks.terminalsById = {};
    mocks.closeAsync.mockReset();
    mocks.closeAsync.mockImplementation(() => Promise.resolve());
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useLandingTerminalStore.getState().resetForTests();
  });

  it("drains an offline close after navigation leaves the landing page", async () => {
    useLandingTerminalStore.getState().addTab({
      instanceId: "closed-tab",
      sessionId: "session-b",
      hostId: "host-b",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "closed-tab");
    const view = render(<LandingTerminalTombstoneRecoveryBridge />);

    expect(mocks.kill).not.toHaveBeenCalled();

    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-b",
      });
    });
  });

  it("retries an acknowledged capable-host close only through shared authority", async () => {
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-capable": {} };
    useLandingTerminalStore.getState().addTab({
      instanceId: "capable-tab",
      sessionId: "session-capable",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "capable-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.closeAsync).toHaveBeenCalledWith({
        terminalId: "session-capable",
      });
      expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
    });
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("does not drain capable-host tombstones while authority is stale", async () => {
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = false;
    mocks.terminalsById = { "session-stale": {} };
    useLandingTerminalStore.getState().addTab({
      instanceId: "stale-tab",
      sessionId: "session-stale",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Legacy",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "stale-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());

    expect(mocks.closeAsync).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      { hostId: "host-b", sessionId: "session-stale" },
    ]);
  });

  it("retries a capable close after rejection and retires on acknowledgement", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-retry": {} };
    mocks.closeAsync
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    useLandingTerminalStore.getState().addTab({
      instanceId: "retry-tab",
      sessionId: "session-retry",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Retry",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "retry-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
  });

  it("backs off repeated capable close failures without concurrent retries", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-backoff": {} };
    mocks.closeAsync.mockRejectedValue(new Error("still unavailable"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "backoff-tab",
      sessionId: "session-backoff",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Backoff",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "backoff-tab");

    render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(499);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(999);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(3);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("cancels capable retries when the bound host route disappears", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-host-change": {} };
    mocks.closeAsync.mockRejectedValue(new Error("transient"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "host-change-tab",
      sessionId: "session-host-change",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Host change",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore
      .getState()
      .closeTab("landing-page", "host-change-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);

    mocks.entries = [offlineHost];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("cancels capable retries when the bridge unmounts", async () => {
    vi.useFakeTimers();
    mocks.entries = [
      {
        ...offlineHost,
        websocketUrl: "ws://host-b/rpc",
        transportDialability: "dialable",
      },
    ];
    mocks.authorityStatus = "capable";
    mocks.canMutate = true;
    mocks.terminalsById = { "session-unmount": {} };
    mocks.closeAsync.mockRejectedValue(new Error("transient"));
    useLandingTerminalStore.getState().addTab({
      instanceId: "unmount-tab",
      sessionId: "session-unmount",
      hostId: "host-b",
      cwd: "/legacy",
      name: "Unmount",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().closeTab("landing-page", "unmount-tab");

    const view = render(<LandingTerminalTombstoneRecoveryBridge />);
    await act(async () => Promise.resolve());
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mocks.closeAsync).toHaveBeenCalledTimes(1);
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("fires the kill on offline -> connectable even when the offline stretch sat inside the relay-fuse window", async () => {
    // Production-shaped entries: a registry-`offline` REMOTE host carries the
    // shared relay `websocketUrl`, and inside the fuse window
    // `dialableHostEndpoint` is non-null - PERMISSION to attempt a recovery
    // dial, not availability. Recording that permission as "available" made
    // the later genuine offline -> connectable recovery a `true -> true`
    // non-edge: `terminal.kill` never fired and the supposedly-closed PTY
    // stayed alive until relaunch (only mutation success clears a tombstone).
    const remoteItem = (
      connectivity: HostConnectivity,
      lastSeenAt: string,
    ): HostListItem => ({
      hostId: "host-b",
      displayName: "Host B",
      platform: "Ubuntu",
      kind: "personal",
      publicKey: "pubkey-b",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatePolicy: "manual",
      status: {
        connectivity,
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.0.0",
        lastSeenAt,
      },
    });
    const relayUrl = "wss://relay.example/attach";
    const recentLastSeen = new Date(Date.now() - 60_000).toISOString();

    // Bridge is mounted while the host is genuinely attached.
    mocks.entries = [
      hostListItemToDirectoryEntry(
        remoteItem("connectable", recentLastSeen),
        relayUrl,
      ),
    ];
    const view = render(<LandingTerminalTombstoneRecoveryBridge />);

    // The host drops to `offline` with a recent lastSeenAt - the fuse window.
    mocks.entries = [
      hostListItemToDirectoryEntry(
        remoteItem("offline", recentLastSeen),
        relayUrl,
      ),
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    // A terminal on it is closed during that window.
    act(() => {
      useLandingTerminalStore.getState().addTab({
        instanceId: "fuse-tab",
        sessionId: "session-fuse",
        hostId: "host-b",
        cwd: "/workspace/project",
        name: "project",
        titleSource: "default",
      });
      useLandingTerminalStore.getState().closeTab("landing-page", "fuse-tab");
    });
    expect(mocks.kill).not.toHaveBeenCalled();

    // The genuine recovery edge: the relay re-attaches the host.
    mocks.entries = [
      hostListItemToDirectoryEntry(
        remoteItem("connectable", new Date().toISOString()),
        relayUrl,
      ),
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-fuse",
      });
    });
  });

  it("treats a READY remote session as confirmed recovery while the registry stays offline", () => {
    // The registry never leaves `offline` for the whole credential-plane
    // incident, so the directory alone can never provide the recovery edge.
    // The recovery dial the fuse window kept open SUCCEEDS instead - the
    // resulting ready session is both the proof of recovery and the route the
    // kill travels, and the bridge learns about it through its readiness
    // subscription (the session cache is pull-only and emits nothing).
    vi.useFakeTimers();
    try {
      const remoteItem = (lastSeenAt: string): HostListItem => ({
        hostId: "host-b",
        displayName: "Host B",
        platform: "Ubuntu",
        kind: "personal",
        publicKey: "pubkey-b",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatePolicy: "manual",
        status: {
          connectivity: "offline",
          viewerReachability: "unknown",
          clientCloud: "ok",
          updateState: "current",
          appVersion: "1.0.0",
          lastSeenAt,
        },
      });
      const recentLastSeen = new Date(Date.now() - 60_000).toISOString();
      mocks.entries = [
        hostListItemToDirectoryEntry(
          remoteItem(recentLastSeen),
          "wss://relay.example/attach",
        ),
      ];
      const view = render(<LandingTerminalTombstoneRecoveryBridge />);

      act(() => {
        useLandingTerminalStore.getState().addTab({
          instanceId: "incident-tab",
          sessionId: "session-incident",
          hostId: "host-b",
          cwd: "/workspace/project",
          name: "project",
          titleSource: "default",
        });
        useLandingTerminalStore
          .getState()
          .closeTab("landing-page", "incident-tab");
      });
      expect(mocks.kill).not.toHaveBeenCalled();

      // The recovery dial succeeds; the registry row is unchanged.
      mocks.readySessionHosts = new Set(["host-b"]);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-incident",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
