import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import type {
  EpicCanvasTileRef,
  SimulatorTileRef,
} from "@/stores/epics/canvas/types";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";

/**
 * The Simulators section under the phone switcher's browser rows: booted
 * simulators first, the sheet staying up until the host has answered the open,
 * a row that is booting not acted on, and the one control that turns
 * simulators on for a host that has them off.
 */

const HOST = "host-1";
const EPIC = "epic-1";
const TAB = "tab-1";

type PlaceTile = (ref: SimulatorTileRef) => void;

const fakes = vi.hoisted(() => ({
  sessions: null as SimulatorSessionsState | null,
  open: vi.fn<(simulator: SimulatorSummary, place: PlaceTile) => void>(),
  configSet: vi.fn(),
  activated: [] as EpicCanvasTileRef[],
}));

vi.mock("@/lib/simulator-view/use-simulator-sessions", () => ({
  useSimulatorSessionsForHost: () => fakes.sessions,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
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
  it("lists booted simulators first and keeps the sheet up until the host has answered the open", () => {
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
    expect(fakes.open).toHaveBeenCalledTimes(1);
    expect(fakes.open.mock.calls[0][0]).toMatchObject({
      simulatorId: "udid-cold",
    });
    expect(fakes.activated).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    // The host answered with the id the stream will answer to.
    const ref = makeSimulatorTileRef({
      hostId: HOST,
      simulatorId: "udid-cold",
      platform: "ios",
      name: "iPhone 15",
    });
    fakes.open.mock.calls[0][1](ref);
    expect(fakes.activated).toEqual([ref]);
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
    expect(fakes.open).not.toHaveBeenCalled();
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
