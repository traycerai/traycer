import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SimulatorState } from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/**
 * The Simulators section under the phone switcher's browser rows: booted
 * simulators first, a tap placing the tile and closing the sheet at once, a
 * row that is booting not acted on, a row the task holds a session on marked
 * and ended from its action, and the one control that turns simulators on for
 * a host that has them off.
 */

const HOST = "host-1";
const EPIC = "epic-1";
const TAB = "tab-1";

const fakes = vi.hoisted(() => ({
  sessions: null as SimulatorSessionsState | null,
  configSet: vi.fn(),
  close: vi.fn(),
  activated: [] as EpicCanvasTileRef[],
}));

vi.mock("@/lib/simulator-view/use-simulator-sessions", () => ({
  useSimulatorSessionsForHost: () => fakes.sessions,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
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
vi.mock("@/components/epic-canvas/mobile/use-switcher-activate", () => ({
  useSwitcherActivate:
    (_tabId: string, onClose: () => void) =>
    (buildRef: () => EpicCanvasTileRef) => {
      fakes.activated.push(buildRef());
      onClose();
    },
}));
// The real spinner is an aria-hidden glyph with no handle to query it by.
vi.mock("@/components/ui/agent-spinning-dots", () => ({
  AgentSpinningDots: () => <span data-testid="spinner" />,
}));

import { SwitcherSimulatorsSection } from "@/components/epic-canvas/mobile/switcher-simulators-section";

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

function renderSection(onClose: () => void): void {
  render(
    <SwitcherSimulatorsSection
      epicId={EPIC}
      tabId={TAB}
      hostId={HOST}
      onClose={onClose}
    />,
  );
}

beforeEach(() => {
  fakes.sessions = sessions(STATE, "live");
  fakes.activated.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SwitcherSimulatorsSection", () => {
  it("lists booted simulators first and places a cold one's tile at once, closing the sheet", () => {
    const onClose = vi.fn();
    renderSection(onClose);
    const rows = screen
      .getAllByTestId(/^switcher-simulator-row-/)
      .map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining("iPhone 16"),
      expect.stringContaining("iPhone 15"),
    ]);
    expect(rows[0]).toContain("iOS 18.0");
    expect(rows[0]).toContain("Running");
    expect(rows[1]).not.toContain("Running");

    fireEvent.click(screen.getByTestId("switcher-simulator-row-udid-cold"));
    // Nothing waits on `simulator.open`: the tile boots the simulator itself.
    expect(fakes.activated).toEqual([
      expect.objectContaining({
        type: "simulator",
        hostId: HOST,
        simulatorId: "udid-cold",
        platform: "ios",
        name: "iPhone 15",
      }),
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("spins on a simulator that is booting and does not open it on a tap", () => {
    fakes.sessions = sessions({ ...STATE, booting: ["udid-cold"] }, "live");
    renderSection(vi.fn());
    const cold = screen.getByTestId("switcher-simulator-row-udid-cold");
    expect(cold.querySelector("[data-testid='spinner']")).not.toBeNull();
    expect(
      screen
        .getByTestId("switcher-simulator-row-udid-hot")
        .querySelector("[data-testid='spinner']"),
    ).toBeNull();

    fireEvent.click(cold);
    expect(fakes.activated).toEqual([]);
  });

  it("marks a simulator the task holds a session on and ends it from the row's action", () => {
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
    renderSection(vi.fn());
    expect(
      screen.getByTestId("switcher-simulator-row-udid-hot").textContent,
    ).toContain("Open");
    expect(
      screen.queryByTestId("switcher-simulator-close-udid-cold"),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("switcher-simulator-close-udid-hot"));
    expect(fakes.close).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: "udid-hot",
      shutdown: false,
    });
    expect(fakes.activated).toEqual([]);
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
    renderSection(vi.fn());
    expect(screen.getByText("Simulators are off on this host.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("switcher-simulators-turn-on"));
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
    renderSection(vi.fn());
    expect(screen.queryByTestId("switcher-simulators-section")).toBeNull();
    cleanup();
    fakes.sessions = sessions(null, "unsupported");
    renderSection(vi.fn());
    expect(screen.queryByTestId("switcher-simulators-section")).toBeNull();
  });
});
