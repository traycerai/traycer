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
import { SimulatorSettingsGroup } from "@/components/settings/simulator-settings-section";

/**
 * The Settings > Browser > Simulators group: it appears only when the host
 * advertises both config methods, shows what the host's status read says
 * about the install and each platform, and writes both switches on every flip.
 * Every host-facing hook is a fake, so each case is one published state.
 */

const HOST = "host-1";

interface SectionFakes {
  methodSupport: Record<string, boolean | null>;
  config: { enabled: boolean; agentAccess: boolean };
  status: SimulatorStatusResponse;
  write: Mock;
  remove: Mock;
}

const fakes = vi.hoisted((): SectionFakes => ({
  methodSupport: {},
  config: { enabled: false, agentAccess: false },
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
vi.mock("@/lib/host", () => ({ useHostClient: () => null }));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => ({ label: "Studio Mac" }),
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

function withPack(
  packState: SimulatorPackState,
  packVersion: string | null,
): SimulatorStatusResponse {
  return { ...fakes.status, packState, packVersion };
}

function isSwitchDisabled(testId: string): boolean {
  return screen.getByTestId(testId).hasAttribute("disabled");
}

beforeEach(() => {
  fakes.methodSupport = {
    "config.simulator.get": true,
    "config.simulator.set": true,
    "simulator.status": true,
    "simulator.removeTools": true,
  };
  fakes.config = { enabled: true, agentAccess: false };
  fakes.status = {
    platforms: [
      { platform: "ios", available: true, reason: null },
      { platform: "android", available: true, reason: null },
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

function renderGroup(): void {
  render(<SimulatorSettingsGroup hostId={HOST} />);
}

describe("SimulatorSettingsGroup", () => {
  it.each([false, null])(
    "renders nothing when the host's config.simulator.set support is %s",
    (support) => {
      fakes.methodSupport["config.simulator.set"] = support;
      renderGroup();
      expect(screen.queryByTestId("settings-browser-simulators")).toBeNull();
    },
  );

  it("renders nothing when the host does not advertise config.simulator.get", () => {
    fakes.methodSupport["config.simulator.get"] = false;
    renderGroup();
    expect(screen.queryByTestId("settings-browser-simulators")).toBeNull();
  });

  it("says the tools are not downloaded while simulators are off and the store is empty", () => {
    fakes.config = { enabled: false, agentAccess: false };
    fakes.status = {
      ...withPack({ kind: "off", reason: null, progress: null }, null),
      installed: null,
    };
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-tools-off").textContent,
    ).toContain("Not downloaded");
    expect(screen.queryByTestId("settings-simulators-remove-tools")).toBeNull();
  });

  it("offers Remove for downloaded tools while simulators are off, and sends it only after confirm", () => {
    fakes.config = { enabled: false, agentAccess: false };
    fakes.status = withPack(
      { kind: "off", reason: null, progress: null },
      null,
    );
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-tools-downloaded").textContent,
    ).toBe("Downloaded, 216 MB. Simulators are off.");
    fireEvent.click(screen.getByTestId("settings-simulators-remove-tools"));
    expect(fakes.remove).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      "Remove the simulator tools from Studio Mac?",
    );
    fireEvent.click(screen.getByTestId("confirm-action"));
    expect(fakes.remove).toHaveBeenCalledTimes(1);
    expect(fakes.remove).toHaveBeenCalledWith({});
  });

  it("never offers Remove while simulators are on, or when the host lacks the verb", () => {
    // On: the tools are in use or about to be.
    renderGroup();
    expect(screen.queryByTestId("settings-simulators-remove-tools")).toBeNull();
    cleanup();
    // Off with bytes, but a host that predates the verb.
    fakes.methodSupport["simulator.removeTools"] = false;
    fakes.config = { enabled: false, agentAccess: false };
    fakes.status = withPack(
      { kind: "off", reason: null, progress: null },
      null,
    );
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-tools-downloaded").textContent,
    ).toContain("Downloaded");
    expect(screen.queryByTestId("settings-simulators-remove-tools")).toBeNull();
  });

  it("shows download progress and a bar while the host installs the tools", () => {
    fakes.status = withPack(
      { kind: "installing", reason: null, progress: 0.42 },
      null,
    );
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-tools-installing").textContent,
    ).toContain("42% done");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "42",
    );
  });

  it("shows the installed pack version once the tools are ready", () => {
    renderGroup();
    const ready = screen.getByTestId("settings-simulator-tools-ready");
    expect(ready.textContent).toContain("Installed.");
    expect(ready.textContent).toContain("0.15.3-0.21.25.22.23.3");
  });

  it("shows the host's reason when setup failed, and Try again re-asserts the switches", () => {
    fakes.config = { enabled: true, agentAccess: true };
    fakes.status = withPack(
      {
        kind: "failed",
        reason: "The download was interrupted.",
        progress: null,
      },
      null,
    );
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-tools-failed").textContent,
    ).toContain("The download was interrupted.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fakes.write).toHaveBeenCalledWith({
      enabled: true,
      agentAccess: true,
    });
  });

  it("says the tools are not needed on a host that can run neither platform", () => {
    fakes.status = withPack(
      { kind: "unsupported", reason: null, progress: null },
      null,
    );
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-tools-unsupported").textContent,
    ).toContain("Not needed");
  });

  it("lists each platform's reason, and Available for one that can run", () => {
    fakes.status = {
      ...fakes.status,
      platforms: [
        {
          platform: "ios",
          available: false,
          reason: "iOS Simulators need macOS with Xcode.",
        },
        { platform: "android", available: true, reason: null },
      ],
    };
    renderGroup();
    expect(
      screen.getByTestId("settings-simulator-platform-ios").textContent,
    ).toContain("iOS Simulators need macOS with Xcode.");
    expect(
      screen.getByTestId("settings-simulator-platform-android").textContent,
    ).toContain("Available");
  });

  it("keeps agent access inert until simulators are on, then writes both switches", () => {
    fakes.config = { enabled: false, agentAccess: false };
    renderGroup();
    expect(isSwitchDisabled("settings-simulators-agent-access")).toBe(true);

    cleanup();
    fakes.config = { enabled: true, agentAccess: false };
    renderGroup();
    expect(isSwitchDisabled("settings-simulators-agent-access")).toBe(false);
    fireEvent.click(screen.getByTestId("settings-simulators-agent-access"));
    expect(fakes.write).toHaveBeenCalledWith({
      enabled: true,
      agentAccess: true,
    });
  });

  it("withdraws agent access when simulators are turned off", () => {
    fakes.config = { enabled: true, agentAccess: true };
    renderGroup();
    fireEvent.click(screen.getByTestId("settings-simulators-enabled"));
    expect(fakes.write).toHaveBeenCalledWith({
      enabled: false,
      agentAccess: false,
    });
  });

  it("keeps the enable switch off-limits on a host that can run neither platform", () => {
    fakes.config = { enabled: false, agentAccess: false };
    fakes.status = withPack(
      { kind: "unsupported", reason: null, progress: null },
      null,
    );
    renderGroup();
    expect(isSwitchDisabled("settings-simulators-enabled")).toBe(true);
  });
});
