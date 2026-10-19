import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  SimulatorPackState,
  SimulatorState,
} from "@traycer/protocol/host/simulator/schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SimulatorSessionsState } from "@/lib/simulator-view/simulator-sessions-coordinator";
import type { SimulatorStreamState } from "@/lib/simulator-view/simulator-stream-controller";
import { makeSimulatorTileRef } from "@/stores/epics/canvas/tile-schema/simulator-tile";

/**
 * The tile's states, one per host condition: the host that cannot run
 * simulators says why per platform; one with them off shows the switch; one
 * installing shows progress; one with the simulator open shows the surface
 * and the platform's buttons. Every host-facing hook is a fake, so each case
 * is one published state and the words it produces.
 */

const HOST = "host-1";
const EPIC = "epic-1";
const UDID = "udid-1";

const fakes = vi.hoisted(() => ({
  reachability: "reachable",
  sessions: null as SimulatorSessionsState | null,
  configSet: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  shutdown: vi.fn(),
  action: vi.fn(),
  closeTile: vi.fn(),
  openTile: vi.fn(),
  refresh: vi.fn(),
  retry: vi.fn(),
  screenshot: vi.fn(),
  streamState: null as SimulatorStreamState | null,
  restart: vi.fn(),
  pressButton: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => HOST,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: fakes.reachability,
    hostLabel: "Studio Mac",
  }),
}));
vi.mock("@/lib/simulator-view/use-simulator-sessions", () => ({
  useSimulatorSessionsForHost: () => fakes.sessions,
}));
vi.mock("@/hooks/simulator/use-simulator-mutations", () => {
  const gated = (mutate: unknown) => ({
    mutation: { mutate, isPending: false, variables: undefined },
    supported: true,
  });
  return {
    useSimulatorConfigQuery: () => ({
      data: { enabled: false, agentAccess: false },
    }),
    useSimulatorConfigSetMutation: () => gated(fakes.configSet),
    useSimulatorOpenMutation: () => gated(fakes.open),
    useSimulatorCloseMutation: () => gated(fakes.close),
    useSimulatorShutdownMutation: () => gated(fakes.shutdown),
    useSimulatorActionMutation: () => gated(fakes.action),
    useSimulatorScreenshotMutation: () => gated(vi.fn()),
  };
});
vi.mock(
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  () => ({ useCloseCanvasTileWithNestedFocus: () => fakes.closeTile }),
);
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: fakes.openTile }),
}));
vi.mock("@/components/epic-canvas/hooks/use-tile-body-visible", () => ({
  useTileBodyVisible: () => true,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  useHostStreamClientFor: () => null,
}));
vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));
vi.mock("@/components/simulator-tile/use-simulator-screenshot", () => ({
  useSimulatorScreenshot: () => ({ take: fakes.screenshot, isPending: false }),
}));
vi.mock("@/components/simulator-tile/use-simulator-stream", () => ({
  useSimulatorStream: () => ({
    controller: {
      restart: fakes.restart,
      pressButton: fakes.pressButton,
      rotate: fakes.rotate,
    },
    state: fakes.streamState,
    sink: { attachCanvas: () => undefined, attachImage: () => undefined },
  }),
}));

import { SimulatorTile } from "@/components/simulator-tile/simulator-tile";

const READY_STATE: SimulatorState = {
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
      simulatorId: UDID,
      platform: "ios",
      name: "iPhone 16",
      version: "18.0",
      booted: false,
      physical: false,
    },
    {
      simulatorId: "udid-2",
      platform: "ios",
      name: "iPad Air",
      version: "18.0",
      booted: true,
      physical: false,
    },
  ],
  sessions: [],
  booting: [],
};

const STREAMING: SimulatorStreamState = {
  lifecycle: "streaming",
  detail: null,
  terminal: false,
  config: {
    platform: "ios",
    codec: "avcc",
    width: 1179,
    height: 2556,
    orientation: "portrait",
    inputAvailable: true,
  },
  plane: "canvas",
  frameSize: { width: 1179, height: 2556 },
  input: { connected: true, detail: null },
};

function sessions(
  overrides: Partial<SimulatorSessionsState>,
): SimulatorSessionsState {
  return {
    hostId: HOST,
    lifecycle: "live",
    state: READY_STATE,
    errorMessage: null,
    refresh: fakes.refresh,
    retry: fakes.retry,
    ...overrides,
  };
}

function withPack(packState: SimulatorPackState): SimulatorState {
  return { ...READY_STATE, packState };
}

function renderTile(): void {
  const node = makeSimulatorTileRef({
    hostId: HOST,
    simulatorId: UDID,
    platform: "ios",
    name: "iPhone 16",
  });
  render(
    <TooltipProvider>
      <SimulatorTile
        node={node}
        viewTabId="tab-1"
        tileId="pane-1"
        epicId={EPIC}
        isActive
      />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  fakes.reachability = "reachable";
  fakes.sessions = sessions({});
  fakes.streamState = STREAMING;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SimulatorTile", () => {
  it("shows the ordinary host-disconnected notice when the tab host is unreachable", () => {
    fakes.reachability = "unreachable";
    renderTile();
    expect(
      screen.getByTestId("simulator-host-unreachable").textContent,
    ).toContain("Host is unreachable");
  });

  it("says the host needs an update when it cannot serve the stream", () => {
    fakes.sessions = sessions({
      lifecycle: "unsupported",
      state: null,
      errorMessage: "This host needs an update before it can show simulators.",
    });
    renderTile();
    expect(screen.getByTestId("simulator-unavailable").textContent).toContain(
      "needs an update",
    );
  });

  it("lists each platform's reason when the host can run neither", () => {
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        platforms: [
          {
            platform: "ios",
            available: false,
            reason: "Xcode is not installed.",
          },
          { platform: "android", available: false, reason: "No Android SDK." },
        ],
        packState: { kind: "unsupported", reason: null, progress: null },
      },
    });
    renderTile();
    expect(
      screen.getByTestId("simulator-platform-reason-ios").textContent,
    ).toContain("Xcode is not installed.");
    expect(
      screen.getByTestId("simulator-platform-reason-android").textContent,
    ).toContain("No Android SDK.");
  });

  it("shows the setup view with the switch while simulators are off, and turns them on", () => {
    fakes.sessions = sessions({
      state: withPack({ kind: "off", reason: null, progress: null }),
    });
    renderTile();
    expect(screen.getByTestId("simulator-setup").textContent).toContain(
      "Simulators are off on Studio Mac",
    );
    fireEvent.click(screen.getByTestId("simulator-enable-switch"));
    expect(fakes.configSet).toHaveBeenCalledWith({
      enabled: true,
      agentAccess: false,
    });
  });

  it("shows download progress while the host installs the tools", () => {
    fakes.sessions = sessions({
      state: withPack({ kind: "installing", reason: null, progress: 0.42 }),
    });
    renderTile();
    expect(screen.getByTestId("simulator-installing").textContent).toContain(
      "42% done",
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "42",
    );
  });

  it("shows the host's reason and a retry when setup failed", () => {
    fakes.sessions = sessions({
      state: withPack({
        kind: "failed",
        reason: "The download was interrupted.",
        progress: null,
      }),
    });
    renderTile();
    expect(screen.getByTestId("simulator-failed").textContent).toContain(
      "The download was interrupted.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fakes.refresh).toHaveBeenCalledTimes(1);
  });

  it("offers to boot a cold simulator, and opens another row as its own tile", () => {
    renderTile();
    expect(screen.getByTestId("simulator-inventory").textContent).toContain(
      "Powered off",
    );
    fireEvent.click(screen.getByTestId("simulator-connect"));
    expect(fakes.open).toHaveBeenCalledWith(
      { epicId: EPIC, simulatorId: UDID, platform: "ios", boot: true },
      expect.anything(),
    );
    expect(
      screen.getByTestId("simulator-inventory-row-udid-2").textContent,
    ).toContain("iPad Air");
  });

  it("attaches a booted simulator on its own, without a click", () => {
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        simulators: READY_STATE.simulators.map((simulator) =>
          simulator.simulatorId === UDID
            ? { ...simulator, booted: true }
            : simulator,
        ),
      },
    });
    renderTile();
    expect(fakes.open).toHaveBeenCalledTimes(1);
    expect(fakes.open.mock.calls[0][0]).toMatchObject({ simulatorId: UDID });
  });

  it("shows the live surface with the platform's buttons once the task holds a session", () => {
    fakes.sessions = sessions({
      state: {
        ...READY_STATE,
        sessions: [
          {
            epicId: EPIC,
            ownerUserId: "user-1",
            hostId: HOST,
            simulatorId: UDID,
            platform: "ios",
            openedAt: "2026-10-18T00:00:00.000Z",
          },
        ],
      },
    });
    renderTile();
    expect(screen.getByTestId("simulator-toolbar").textContent).toContain(
      "iPhone 16",
    );
    expect(screen.getByTestId("simulator-button-home")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByTestId("simulator-button-appSwitcher")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByTestId("simulator-button-back")).toBeNull();
    expect(
      screen.getByTestId("simulator-surface").getAttribute("data-lifecycle"),
    ).toBe("streaming");
    fireEvent.click(screen.getByTestId("simulator-button-home"));
    expect(fakes.pressButton).toHaveBeenCalledWith("home");
    fireEvent.click(screen.getByTestId("simulator-rotate"));
    expect(fakes.rotate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("simulator-screenshot"));
    expect(fakes.screenshot).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("simulator-close"));
    expect(fakes.closeTile).toHaveBeenCalledTimes(1);
    expect(fakes.close).toHaveBeenCalledWith({
      epicId: EPIC,
      simulatorId: UDID,
      shutdown: false,
    });
  });

  it("offers Reconnect when the video stopped, and nothing when the session is gone", () => {
    const withSession: SimulatorState = {
      ...READY_STATE,
      sessions: [
        {
          epicId: EPIC,
          ownerUserId: "user-1",
          hostId: HOST,
          simulatorId: UDID,
          platform: "ios",
          openedAt: "2026-10-18T00:00:00.000Z",
        },
      ],
    };
    fakes.sessions = sessions({ state: withSession });
    fakes.streamState = {
      ...STREAMING,
      lifecycle: "error",
      detail: "No video arrived from the simulator.",
      terminal: false,
    };
    renderTile();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(fakes.restart).toHaveBeenCalledTimes(1);

    cleanup();
    fakes.streamState = {
      ...STREAMING,
      lifecycle: "error",
      detail: "This simulator was closed.",
      terminal: true,
    };
    renderTile();
    expect(
      screen.getByTestId("simulator-surface-overlay").textContent,
    ).toContain("This simulator was closed.");
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
