import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  SimulatorPackState,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { HostOverviewSimulatorsTab } from "@/components/settings/panels/host-overview-simulators-tab";

/**
 * The Host panel's Mobile simulators tab: one switch that gates the rest.
 * Off: the switch with the platform status folded into its description, and
 * the tools row only while the tools are still downloaded; on: Platforms and
 * the tools row. Never an agent row. Every host-facing hook is a fake, so
 * each case is one published state.
 */

const HOST = "host-1";

interface TabFakes {
  methodSupport: Record<string, boolean | null>;
  config: { enabled: boolean };
  status: SimulatorStatusResponse;
  write: Mock;
  remove: Mock;
}

const fakes = vi.hoisted((): TabFakes => ({
  methodSupport: {},
  config: { enabled: false },
  status: {
    platforms: [],
    packState: { kind: "off", reason: null, progress: null },
    packVersion: null,
    installed: null,
  },
  write: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    fakes.methodSupport[method] ?? null,
}));
vi.mock("@/hooks/simulator/use-simulator-mutations", () => ({
  useSimulatorConfigQuery: () => ({
    data: fakes.config,
    isPending: false,
    isError: false,
  }),
  useSimulatorStatusQuery: () => ({ data: fakes.status, isError: false }),
  useSimulatorConfigSetMutation: () => ({
    mutation: { mutate: fakes.write, isPending: false },
    supported: true,
  }),
  useSimulatorRemoveToolsMutation: (
    _client: unknown,
    _hostId: string | null,
  ) => ({
    mutation: { mutate: fakes.remove, isPending: false },
    supported: fakes.methodSupport["simulator.removeTools"] === true,
  }),
}));

const OFF: SimulatorPackState = { kind: "off", reason: null, progress: null };

function withPack(
  packState: SimulatorPackState,
  packVersion: string | null,
): SimulatorStatusResponse {
  return { ...fakes.status, packState, packVersion };
}

beforeEach(() => {
  fakes.methodSupport = {
    "config.simulator.get": true,
    "config.simulator.set": true,
    "simulator.status": true,
    "simulator.removeTools": true,
  };
  fakes.config = { enabled: true };
  fakes.status = {
    platforms: [
      { platform: "ios", available: true, reason: null },
      { platform: "android", available: false, reason: "No Android SDK." },
    ],
    packState: { kind: "ready", reason: null, progress: null },
    packVersion: "0.15.3-0.21.25.22.23.3",
    installed: {
      version: "0.15.3-0.21.25.22.23.3",
      sizeBytes: 216 * 1024 ** 2,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTab(): void {
  render(
    <HostOverviewSimulatorsTab
      client={null}
      hostId={HOST}
      hostName="Studio Mac"
    />,
  );
}

function switchRow(): HTMLElement {
  return screen.getByTestId("settings-simulators-enabled");
}

describe("HostOverviewSimulatorsTab", () => {
  it("replaces the switch with one sentence while the host's methods are unknown or missing, and never draws an agent row", () => {
    fakes.methodSupport["config.simulator.set"] = null;
    renderTab();
    const card = screen.getByTestId("host-overview-mobile-simulators");
    expect(card.textContent).toContain("Asking Studio Mac");
    expect(screen.queryByTestId("settings-simulators-enabled")).toBeNull();
    cleanup();

    fakes.methodSupport["config.simulator.set"] = false;
    renderTab();
    expect(
      screen.getByTestId("host-overview-mobile-simulators").textContent,
    ).toContain("Studio Mac needs an update");
    expect(screen.queryByTestId("settings-simulators-enabled")).toBeNull();
    expect(screen.queryByTestId("settings-simulators-agent-access")).toBeNull();
  });

  it("off: shows the switch with the platform status folded in, no Platforms row, and no tools row when nothing is downloaded", () => {
    fakes.config = { enabled: false };
    fakes.status = { ...withPack(OFF, null), installed: null };
    renderTab();
    const card = screen.getByTestId("host-overview-mobile-simulators");
    expect(card.textContent).toContain("Use mobile simulators");
    expect(card.textContent).toContain("let agents drive them");
    expect(card.textContent).toContain(
      "iOS available. Android: No Android SDK.",
    );
    expect(screen.queryByTestId("settings-simulator-platform-ios")).toBeNull();
    expect(screen.queryByTestId("settings-simulator-tools-off")).toBeNull();
    expect(screen.queryByTestId("settings-simulators-agent-access")).toBeNull();
    fireEvent.click(switchRow());
    expect(fakes.write).toHaveBeenCalledWith({ enabled: true });
  });

  it("off with downloaded tools: keeps the tools row so Remove stays reachable, and sends it only after confirm", () => {
    fakes.config = { enabled: false };
    fakes.status = withPack(OFF, null);
    renderTab();
    expect(screen.queryByTestId("settings-simulator-platform-ios")).toBeNull();
    expect(
      screen.getByTestId("settings-simulator-tools-downloaded").textContent,
    ).toBe("Downloaded, 216 MB. Mobile simulators are off.");
    fireEvent.click(screen.getByTestId("settings-simulators-remove-tools"));
    expect(fakes.remove).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("confirm-destructive-dialog").textContent,
    ).toContain("Remove the simulator tools from Studio Mac?");
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(fakes.remove).toHaveBeenCalledTimes(1);
    expect(fakes.remove).toHaveBeenCalledWith({});
  });

  it("on: shows Platforms with each reason and the tools row, and never Remove", () => {
    renderTab();
    expect(
      screen.getByTestId("settings-simulator-platform-ios").textContent,
    ).toContain("Available");
    expect(
      screen.getByTestId("settings-simulator-platform-android").textContent,
    ).toContain("No Android SDK.");
    const ready = screen.getByTestId("settings-simulator-tools-ready");
    expect(ready.textContent).toContain("Installed.");
    expect(ready.textContent).toContain("0.15.3-0.21.25.22.23.3");
    expect(screen.queryByTestId("settings-simulators-remove-tools")).toBeNull();
    // The switch's description carries no platform status while on: the
    // Platforms row says it.
    expect(
      screen.getByTestId("host-overview-mobile-simulators").textContent,
    ).not.toContain("iOS available.");
    fireEvent.click(switchRow());
    expect(fakes.write).toHaveBeenCalledWith({ enabled: false });
  });

  it("shows download progress while installing, and Try again re-asserts the switch after a failure", () => {
    fakes.status = withPack(
      { kind: "installing", reason: null, progress: 0.42 },
      null,
    );
    renderTab();
    expect(
      screen.getByTestId("settings-simulator-tools-installing").textContent,
    ).toContain("42% done");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "42",
    );
    cleanup();

    fakes.status = withPack(
      {
        kind: "failed",
        reason: "The download was interrupted.",
        progress: null,
      },
      null,
    );
    renderTab();
    expect(
      screen.getByTestId("settings-simulator-tools-failed").textContent,
    ).toContain("The download was interrupted.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fakes.write).toHaveBeenCalledWith({ enabled: true });
  });

  it("keeps the switch off-limits on a host that can run neither platform", () => {
    fakes.config = { enabled: false };
    fakes.status = {
      ...withPack({ kind: "unsupported", reason: null, progress: null }, null),
      installed: null,
      platforms: [
        { platform: "ios", available: false, reason: "No Xcode." },
        { platform: "android", available: false, reason: "No Android SDK." },
      ],
    };
    renderTab();
    expect(switchRow().hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByTestId("host-overview-mobile-simulators").textContent,
    ).toContain("iOS: No Xcode. Android: No Android SDK.");
  });
});
