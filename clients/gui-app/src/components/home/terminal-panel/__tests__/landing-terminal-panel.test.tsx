import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";

const mocks = vi.hoisted(() => ({
  activeHostId: null as string | null,
  probeData: undefined as
    | { readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo> }
    | undefined,
  freshProbeData: undefined as
    | { readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo> }
    | undefined,
  probeError: null,
  dataUpdatedAt: 1,
  primaryWorkspacePath: null as string | null,
  kill: vi.fn(),
  killAsync: vi.fn(() => Promise.resolve({ killed: true })),
  queryClient: {
    cancelQueries: vi.fn(() => Promise.resolve()),
    fetchQuery: vi.fn(),
  },
  defaultClient: {
    getActiveHostId: () => mocks.activeHostId,
    onChange: () => () => undefined,
  },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => mocks.queryClient };
});

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mocks.activeHostId,
}));
vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => ({
    data: mocks.probeData,
    error: mocks.probeError,
    dataUpdatedAt: mocks.dataUpdatedAt,
  }),
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.defaultClient,
}));
vi.mock(
  "@/components/home/host-workspace-selector/use-home-workspace-source",
  () => ({
    useHomeWorkspaceSource: () => ({
      primaryWorkspacePath: mocks.primaryWorkspacePath,
    }),
  }),
);
vi.mock("@/components/epic-canvas/canvas/use-pointer-drag-commit", () => ({
  pointerDragHandleAxisClassName: () => "",
  usePointerDragCommit: () => ({
    role: "slider",
    tabIndex: 0,
    "aria-orientation": "vertical",
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onPointerCancel: () => undefined,
    onDoubleClick: () => undefined,
    onKeyDown: () => undefined,
  }),
}));
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => ({
      mutate: mocks.kill,
      mutateAsync: mocks.killAsync,
    }),
  }),
);
vi.mock("@/components/home/terminal-panel/landing-terminal-tile", () => ({
  LandingTerminalTile: () => <div data-testid="landing-terminal-tile" />,
}));

import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";

function runningSession(sessionId: string): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: { kind: "independent" },
    sessionKind: "terminal",
    cwd: "/workspace/project",
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
}

describe("<LandingTerminalPanel />", () => {
  beforeEach(() => {
    mocks.activeHostId = null;
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    mocks.probeError = null;
    mocks.dataUpdatedAt = 1;
    mocks.primaryWorkspacePath = null;
    mocks.kill.mockReset();
    mocks.killAsync.mockClear();
    mocks.queryClient.cancelQueries.mockClear();
    mocks.queryClient.fetchQuery.mockReset();
    mocks.queryClient.fetchQuery.mockImplementation(() =>
      Promise.resolve(mocks.freshProbeData ?? mocks.probeData),
    );
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useLandingTerminalStore.getState().resetForTests();
  });

  it("hides while no host is selected, preserving an open panel until selection", async () => {
    useLandingTerminalStore.getState().setPanelOpen(true);
    const view = render(<LandingTerminalPanel draftId={null} />);
    expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();
    expect(useLandingTerminalStore.getState().panelOpen).toBe(true);

    mocks.activeHostId = "host-a";
    mocks.probeData = { sessions: [] };
    mocks.dataUpdatedAt += 1;
    view.rerender(<LandingTerminalPanel draftId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("landing-terminal-toggle")).toBeTruthy();
      expect(useLandingTerminalStore.getState().panelOpen).toBe(true);
    });
  });

  it("adopts the probe result before considering an auto-spawn", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [runningSession("orphan")] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(<LandingTerminalPanel draftId={null} />);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
      expect(useLandingTerminalStore.getState().tabs[0]?.sessionId).toBe(
        "orphan",
      );
    });
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("uses the fresh list to adopt an orphan before auto-spawn", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [runningSession("fresh-orphan")] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(<LandingTerminalPanel draftId={null} />);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
      expect(useLandingTerminalStore.getState().tabs[0]?.sessionId).toBe(
        "fresh-orphan",
      );
    });
  });

  it("does not clear a close tombstone from a stale empty list", async () => {
    mocks.activeHostId = "host-a";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = {
      sessions: [runningSession("still-running")],
    };
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "still-running",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("tab-1");
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(<LandingTerminalPanel draftId={null} />);

    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        sessionId: "still-running",
      });
    });
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      { hostId: "host-a", sessionId: "still-running" },
    ]);
  });

  it("reruns an empty reconciliation after a workspace becomes available", async () => {
    mocks.activeHostId = "host-a";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    const view = render(<LandingTerminalPanel draftId={null} />);

    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });
    expect(useLandingTerminalStore.getState().tabs).toEqual([]);

    mocks.primaryWorkspacePath = "/workspace/project";
    view.rerender(<LandingTerminalPanel draftId={null} />);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
  });
});
