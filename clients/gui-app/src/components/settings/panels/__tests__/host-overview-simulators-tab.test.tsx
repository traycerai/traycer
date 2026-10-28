import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type {
  SimulatorHostInstance,
  SimulatorPackState,
  SimulatorPowerOffRequest,
  SimulatorPowerOffResponse,
  SimulatorStatusResponse,
} from "@traycer/protocol/host/simulator/schemas";
import { HostOverviewSimulatorsTab } from "@/components/settings/panels/host-overview-simulators-tab";
import { HostOverviewSimulatorsCount } from "@/components/settings/panels/host-overview-simulator-instances";

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
  config: { enabled: boolean; idleMinutes?: number };
  negotiated: SchemaVersion | false | null;
  instances: SimulatorHostInstance[];
  powerOff: Mock<
    (request: SimulatorPowerOffRequest) => Promise<SimulatorPowerOffResponse>
  >;
  status: SimulatorStatusResponse;
  write: Mock;
  remove: Mock;
  removePending: boolean;
  titles: Map<string, string>;
  openTask: Mock<(epicId: string) => void>;
}

const fakes = vi.hoisted((): TabFakes => ({
  methodSupport: {},
  config: { enabled: false },
  negotiated: null,
  instances: [],
  powerOff: vi.fn(),
  status: {
    platforms: [],
    packState: { kind: "off", reason: null, progress: null },
    packVersion: null,
    installed: null,
  },
  write: vi.fn(),
  remove: vi.fn(),
  removePending: false,
  titles: new Map(),
  openTask: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/lib/tab-navigation", () => ({
  openOrFocusEpicIntent: (intent: { readonly epicId: string }) => intent,
  navigateToTabIntent: (
    _navigate: unknown,
    intent: { readonly epicId: string },
  ) => fakes.openTask(intent.epicId),
}));
vi.mock("@/components/settings/panels/use-simulator-task-titles", () => ({
  useSimulatorTaskTitles: () => fakes.titles,
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (_hostId: string | null, method: string) =>
    fakes.methodSupport[method] ?? null,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => fakes.negotiated,
}));
vi.mock("@/hooks/simulator/use-simulator-mutations", async () => {
  const { useMutation } = await import("@tanstack/react-query");
  return {
    useSimulatorInstancesQuery: () => ({
      data: { instances: fakes.instances },
      isError: false,
    }),
    useSimulatorPowerOffMutation: () => ({
      mutation: useMutation({
        mutationFn: (request: SimulatorPowerOffRequest) =>
          fakes.powerOff(request),
      }),
      supported: true,
    }),
    useSimulatorSetKeepRunningMutation: () => ({
      mutation: { mutate: vi.fn(), isPending: false },
      supported: true,
    }),
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
      mutation: { mutate: fakes.remove, isPending: fakes.removePending },
      supported: fakes.methodSupport["simulator.removeTools"] === true,
    }),
  };
});

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
  fakes.negotiated = null;
  fakes.instances = [];
  fakes.powerOff.mockReset();
  fakes.removePending = false;
  fakes.titles = new Map();
  fakes.openTask.mockReset();
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
    <QueryClientProvider client={new QueryClient()}>
      <HostOverviewSimulatorsTab
        client={null}
        hostId={HOST}
        hostName="Studio Mac"
      />
    </QueryClientProvider>,
  );
}

const RUNNING: SimulatorHostInstance = {
  instanceKey: "udid-1",
  name: "iPhone 16",
  booted: true,
  cloneOf: null,
  drivenByAgent: true,
  keepRunning: false,
  idleUntil: null,
  simulatorId: "udid-1",
  platform: "ios",
  version: "18.0",
  cloneOfName: null,
  bootedByTraycer: true,
  tasks: [{ epicId: "epic-1" }],
  otherTaskCount: 1,
};

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

  it("off with downloaded tools: holds the switch while the tools are being removed", () => {
    fakes.config = { enabled: false };
    fakes.status = withPack(OFF, null);
    fakes.removePending = true;
    renderTab();
    expect(switchRow()).toHaveProperty("disabled", true);
    fireEvent.click(switchRow());
    expect(fakes.write).not.toHaveBeenCalled();
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

  describe("on a @1.1 host", () => {
    beforeEach(() => {
      fakes.negotiated = { major: 1, minor: 1 };
      fakes.methodSupport["simulator.instances"] = true;
      fakes.config = { enabled: true, idleMinutes: 15 };
      fakes.instances = [RUNNING];
    });

    it("lists what runs now with the Agent badge and the tasks holding it", () => {
      renderTab();
      const row = screen.getByTestId("host-overview-simulator-udid-1");
      expect(within(row).getByText("Agent")).toBeTruthy();
      expect(row.textContent).toContain("iOS 18.0");
      expect(
        screen.getByTestId("host-overview-simulator-tasks-udid-1").textContent,
      ).toBe("Open inepic-1+1 other");
    });

    it("links each task it can see by title, falling back to the short id", () => {
      fakes.instances = [
        {
          ...RUNNING,
          tasks: [{ epicId: "epic-1" }, { epicId: "01JABCDEFGHJKMNP" }],
          otherTaskCount: 0,
        },
      ];
      fakes.titles = new Map([["epic-1", "Checkout flow"]]);
      renderTab();
      const tasks = screen.getByTestId("host-overview-simulator-tasks-udid-1");
      expect(tasks.textContent).not.toContain("other");
      fireEvent.click(
        within(tasks).getByRole("button", { name: "Open task Checkout flow" }),
      );
      expect(fakes.openTask).toHaveBeenCalledWith("epic-1");
      fireEvent.click(
        within(tasks).getByRole("button", { name: "Open task 01JABCDE" }),
      );
      expect(fakes.openTask).toHaveBeenLastCalledWith("01JABCDEFGHJKMNP");
    });

    it("powers off with confirm false first and closes nothing more when the host just does it", async () => {
      fakes.powerOff.mockResolvedValueOnce({
        kind: "powered-off",
        instanceKey: "udid-1",
      });
      renderTab();

      fireEvent.click(
        screen.getByTestId("host-overview-simulator-power-off-udid-1"),
      );

      await waitFor(() => {
        expect(fakes.powerOff).toHaveBeenCalledTimes(1);
      });
      expect(fakes.powerOff).toHaveBeenCalledWith({
        instanceKey: "udid-1",
        confirm: false,
      });
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });

    it("asks when the host answers confirm-required, and its confirm sends confirm: true", async () => {
      fakes.powerOff
        .mockResolvedValueOnce({
          kind: "confirm-required",
          instanceKey: "udid-1",
        })
        .mockResolvedValueOnce({ kind: "powered-off", instanceKey: "udid-1" });
      renderTab();

      fireEvent.click(
        screen.getByTestId("host-overview-simulator-power-off-udid-1"),
      );

      const dialog = await screen.findByTestId("confirm-destructive-dialog");
      expect(dialog.textContent).toContain("Power off iPhone 16?");
      expect(fakes.powerOff).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("confirm-action"));

      await waitFor(() => {
        expect(fakes.powerOff).toHaveBeenCalledTimes(2);
      });
      expect(fakes.powerOff).toHaveBeenNthCalledWith(2, {
        instanceKey: "udid-1",
        confirm: true,
      });
    });

    it("writes the idle window as { enabled: null, idleMinutes } so it never touches the switch", () => {
      renderTab();
      const input = screen.getByTestId("settings-simulators-idle-minutes");
      expect(input).toHaveProperty("value", "15");

      fireEvent.change(input, { target: { value: "45" } });
      fireEvent.blur(input);

      expect(fakes.write).toHaveBeenCalledTimes(1);
      expect(fakes.write).toHaveBeenCalledWith({
        enabled: null,
        idleMinutes: 45,
      });
    });

    it("writes nothing for an unchanged or out-of-range idle window", () => {
      renderTab();
      const input = screen.getByTestId("settings-simulators-idle-minutes");

      fireEvent.change(input, { target: { value: "15" } });
      fireEvent.blur(input);
      fireEvent.change(input, { target: { value: "0" } });
      fireEvent.blur(input);
      fireEvent.change(input, { target: { value: "99999" } });
      fireEvent.blur(input);

      expect(fakes.write).not.toHaveBeenCalled();
    });

    it("counts the running instances on the tab trigger", () => {
      fakes.instances = [RUNNING, { ...RUNNING, instanceKey: "udid-2" }];
      render(<HostOverviewSimulatorsCount client={null} hostId={HOST} />);
      expect(
        screen
          .getByTestId("host-overview-simulators-count")
          .getAttribute("data-count"),
      ).toBe("2");
    });
  });

  it("draws neither Running now nor the idle window on a host that is not @1.1", () => {
    fakes.config = { enabled: true, idleMinutes: 15 };
    fakes.instances = [RUNNING];
    fakes.negotiated = { major: 1, minor: 0 };
    renderTab();
    expect(screen.queryByTestId("host-overview-simulator-udid-1")).toBeNull();
    expect(screen.queryByTestId("settings-simulators-idle-minutes")).toBeNull();
  });
});
