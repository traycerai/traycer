import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

const mocks = vi.hoisted(() => ({
  entries: [] as readonly HostDirectoryEntry[],
  kill: vi.fn(),
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

import { LandingTerminalTombstoneRecoveryBridge } from "@/providers/landing-terminal-tombstone-recovery-bridge";

const offlineHost: HostDirectoryEntry = {
  hostId: "host-b",
  label: "Host B",
  kind: "remote",
  websocketUrl: null,
  version: "1.0.0",
  status: "unavailable",
};

describe("<LandingTerminalTombstoneRecoveryBridge />", () => {
  beforeEach(() => {
    mocks.entries = [offlineHost];
    mocks.kill.mockReset();
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
    useLandingTerminalStore.getState().closeTab("closed-tab");
    const view = render(<LandingTerminalTombstoneRecoveryBridge />);

    expect(mocks.kill).not.toHaveBeenCalled();

    mocks.entries = [
      { ...offlineHost, websocketUrl: "ws://host-b/rpc", status: "available" },
    ];
    view.rerender(<LandingTerminalTombstoneRecoveryBridge />);

    await waitFor(() => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: "host-b",
        sessionId: "session-b",
      });
    });
  });
});
