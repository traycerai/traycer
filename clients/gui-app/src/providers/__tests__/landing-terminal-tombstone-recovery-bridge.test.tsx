import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type {
  HostConnectivity,
  HostListItem,
} from "@traycer/protocol/host/host-status";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

const mocks = vi.hoisted(() => ({
  entries: [] as readonly HostDirectoryEntry[],
  kill: vi.fn(),
  readySessionHosts: new Set<string>(),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: mocks.entries }),
}));
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => ({ mutate: mocks.kill }),
  }),
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
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
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
