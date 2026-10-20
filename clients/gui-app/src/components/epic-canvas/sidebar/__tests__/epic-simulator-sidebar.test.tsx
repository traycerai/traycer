import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SimulatorState } from "@traycer/protocol/host/simulator/schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";

/**
 * The Simulators group under the browser rows: booted simulators first, a
 * row click places the tile at once (the tile connects and boots on its own),
 * a row the task holds a session on is marked and ends that session from the
 * row, and a host with simulators off gets the one control that turns them on.
 */

const HOST = "host-1";
const EPIC = "epic-1";

const fakes = vi.hoisted(() => ({
  sessions: null as SimulatorSessionsState | null,
  openTile: vi.fn(),
  configSet: vi.fn(),
  close: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/simulator-view/use-simulator-sessions", () => ({
  useSimulatorSessionsForHost: () => fakes.sessions,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: fakes.openTile }),
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: "reachable", hostLabel: "Studio Mac" }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/simulator/use-simulator-mutations", () => ({
  useSimulatorConfigQuery: () => ({
    data: { enabled: false, agentAccess: false },
  }),
  useSimulatorConfigSetMutation: () => ({
    mutation: { mutate: fakes.configSet, isPending: false },
    supported: true,
  }),
  useSimulatorCloseMutation: () => ({
    mutation: { mutate: fakes.close, isPending: false },
    supported: true,
  }),
}));
vi.mock("@/stores/epics/canvas/store", () => ({
  useIsActiveTile: () => false,
}));
vi.mock("@/stores/epics/sidebar-node-reveal-store", () => ({
  useSidebarNodeRevealRequest: () => null,
  clearSidebarNodeRevealRequest: () => undefined,
}));

import { SimulatorsSidebarGroup } from "@/components/epic-canvas/sidebar/epic-simulator-sidebar";
import {
  pendingSimulatorConnectRequest,
  resetSimulatorConnectRequestsForTests,
} from "@/lib/simulator-view/simulator-connect-requests";

const STATE: SimulatorState = {
  revision: 1,
  hostId: HOST,
  platforms: [
    { platform: "ios", available: true, reason: null },
    { platform: "android", available: false, reason: "No Android SDK." },
  ],
  packState: { kind: "ready", reason: null, progress: null },
  hubState: { kind: "running", lastError: null },
  simulators: [
    {
      simulatorId: "udid-cold",
      platform: "ios",
      name: "iPhone 15",
      version: "17.5",
      booted: false,
      physical: false,
    },
    {
      simulatorId: "udid-hot",
      platform: "ios",
      name: "iPhone 16",
      version: "18.0",
      booted: true,
      physical: false,
    },
  ],
  sessions: [],
  booting: [],
};

function sessions(
  state: SimulatorState | null,
  lifecycle: SimulatorSessionsState["lifecycle"],
): SimulatorSessionsState {
  return {
    hostId: HOST,
    lifecycle,
    state,
    errorMessage: null,
    refresh: fakes.refresh,
    retry: () => undefined,
  };
}

function renderGroup(): () => void {
  const group = () => (
    <TooltipProvider>
      <SimulatorsSidebarGroup epicId={EPIC} tabId="tab-1" hostId={HOST} />
    </TooltipProvider>
  );
  const { rerender } = render(group());
  return () => rerender(group());
}

beforeEach(() => {
  fakes.sessions = sessions(STATE, "live");
});

afterEach(() => {
  cleanup();
  resetSimulatorConnectRequestsForTests();
  vi.clearAllMocks();
});

describe("SimulatorsSidebarGroup", () => {
  it("lists the host's simulators, booted first, and places a cold one's tile at once", () => {
    renderGroup();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("iPhone 16"),
      expect.stringContaining("iPhone 15"),
    ]);
    expect(rows[0].textContent).toContain("Running");
    fireEvent.click(screen.getByTestId("epic-simulator-sidebar-row-udid-cold"));
    // Synchronous: no `simulator.open` answer is awaited, so a boot that
    // outlasts the RPC timeout still shows the tile.
    expect(fakes.openTile).toHaveBeenCalledTimes(1);
    expect(fakes.openTile.mock.calls[0][0]).toMatchObject({
      node: {
        type: "simulator",
        hostId: HOST,
        simulatorId: "udid-cold",
        platform: "ios",
        name: "iPhone 15",
      },
      target: { tabId: "tab-1" },
      gesture: "explicit",
    });
    // The click said "boot this": the tile's gate finds the request and sends
    // the one `simulator.open` itself.
    expect(
      pendingSimulatorConnectRequest(`simulator:${HOST}:udid-cold`),
    ).not.toBeNull();
    expect(screen.queryByTestId(/^epic-simulator-sidebar-close-/)).toBeNull();
  });

  it("marks a simulator the task holds a session on, attaches to it on click, and ends it from the row", () => {
    fakes.sessions = sessions(
      {
        ...STATE,
        sessions: [
          {
            epicId: EPIC,
            ownerUserId: "user-1",
            hostId: HOST,
            simulatorId: "udid-hot",
            platform: "ios",
            openedAt: "2026-10-19T00:00:00.000Z",
          },
        ],
      },
      "live",
    );
    renderGroup();
    const row = screen.getByTestId("epic-simulator-sidebar-row-udid-hot");
    expect(row.textContent).toContain("Open");
    expect(row.textContent).not.toContain("Running");
    expect(row.getAttribute("aria-label")).toContain("open in this task");
    expect(
      screen.getByTestId("epic-simulator-sidebar-row-udid-cold").textContent,
    ).not.toContain("Open");

    // The tile placed for the row is the same tile id the session's tile has,
    // so it attaches to the existing session instead of opening a second one.
    fireEvent.click(row);
    expect(fakes.openTile).toHaveBeenCalledTimes(1);
    expect(fakes.openTile.mock.calls[0][0]).toMatchObject({
      node: { id: `simulator:${HOST}:udid-hot`, simulatorId: "udid-hot" },
      dedupe: true,
    });

    fireEvent.click(
      screen.getByTestId("epic-simulator-sidebar-close-udid-hot"),
    );
    expect(fakes.close).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: "udid-hot",
      shutdown: false,
    });
    expect(
      screen.queryByTestId("epic-simulator-sidebar-close-udid-cold"),
    ).toBeNull();
  });

  it("asks the host for its inventory once when it mounts with simulators on, and not while they are off", () => {
    const rerender = renderGroup();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    cleanup();
    fakes.refresh.mockClear();
    fakes.sessions = sessions(
      {
        ...STATE,
        packState: { kind: "off", reason: null, progress: null },
        simulators: [],
      },
      "live",
    );
    renderGroup();
    expect(fakes.refresh).not.toHaveBeenCalled();
  });

  it("asks again when the sessions stream comes back after a drop, and not on a mere re-render", () => {
    const rerender = renderGroup();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    // A host restart takes the stream down under a panel that stays mounted;
    // the hub it had started is gone with the host.
    fakes.sessions = sessions(STATE, "reconnecting");
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
    fakes.sessions = sessions(STATE, "live");
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(2);
    rerender();
    expect(fakes.refresh).toHaveBeenCalledTimes(2);
  });

  it("offers Turn on while simulators are off, writing both switches", () => {
    fakes.sessions = sessions(
      {
        ...STATE,
        packState: { kind: "off", reason: null, progress: null },
        simulators: [],
      },
      "live",
    );
    renderGroup();
    fireEvent.click(screen.getByTestId("epic-simulators-turn-on"));
    expect(fakes.configSet).toHaveBeenCalledWith({
      enabled: true,
      agentAccess: false,
    });
  });

  it("renders nothing for a host that can run neither platform, or cannot show simulators", () => {
    fakes.sessions = sessions(
      {
        ...STATE,
        platforms: STATE.platforms.map((platform) => ({
          ...platform,
          available: false,
        })),
      },
      "live",
    );
    renderGroup();
    expect(screen.queryByTestId("epic-simulators-group")).toBeNull();
    cleanup();
    fakes.sessions = sessions(null, "unsupported");
    renderGroup();
    expect(screen.queryByTestId("epic-simulators-group")).toBeNull();
  });
});
