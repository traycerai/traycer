import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SimulatorState } from "@traycer/protocol/host/simulator/schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";

/**
 * The Simulators group under the browser rows: booted simulators first, a
 * row click opens (booting when needed) the tile, and a host with
 * simulators off gets the one control that turns them on.
 */

const HOST = "host-1";
const EPIC = "epic-1";

const fakes = vi.hoisted(() => ({
  sessions: null as SimulatorSessionsState | null,
  open: vi.fn(),
  openTile: vi.fn(),
  configSet: vi.fn(),
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
vi.mock("@/components/simulator-tile/use-open-simulator-tile", () => ({
  useOpenSimulatorTile: () => ({
    open: fakes.open,
    supported: true,
    openingSimulatorId: null,
  }),
}));
vi.mock("@/hooks/simulator/use-simulator-mutations", () => ({
  useSimulatorConfigQuery: () => ({
    data: { enabled: false, agentAccess: false },
  }),
  useSimulatorConfigSetMutation: () => ({
    mutation: { mutate: fakes.configSet, isPending: false },
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
    refresh: () => undefined,
    retry: () => undefined,
  };
}

function renderGroup(): void {
  render(
    <TooltipProvider>
      <SimulatorsSidebarGroup epicId={EPIC} tabId="tab-1" hostId={HOST} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  fakes.sessions = sessions(STATE, "live");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SimulatorsSidebarGroup", () => {
  it("lists the host's simulators, booted first, and opens the one clicked", () => {
    renderGroup();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("iPhone 16"),
      expect.stringContaining("iPhone 15"),
    ]);
    expect(rows[0].textContent).toContain("Running");
    fireEvent.click(screen.getByTestId("epic-simulator-sidebar-row-udid-cold"));
    expect(fakes.open).toHaveBeenCalledTimes(1);
    expect(fakes.open.mock.calls[0][0]).toMatchObject({
      simulatorId: "udid-cold",
    });
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
