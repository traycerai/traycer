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
  within,
} from "@testing-library/react";
import type {
  SimulatorAction,
  SimulatorDetail,
  SimulatorSettings,
} from "@traycer/protocol/host/simulator/actions";
import type { SimulatorPlatform } from "@traycer/protocol/host/simulator/schemas";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { SimulatorSettingsDrawer } from "@/components/simulator-tile/simulator-settings-drawer";

/**
 * The live tile's settings drawer: every control is one `simulator.action`
 * sent as `{ epicId, simulatorId, action }`, a control the platform lacks is
 * not drawn, and a refusal prints under the control that sent it. The detail
 * query and the action mutation are fakes, so each case is one published
 * state and the one `mutate` call it produces.
 */

const HOST = "host-1";
const EPIC = "epic-1";
const UDID = "udid-1";

interface DrawerFakes {
  detail: SimulatorDetail;
  mutate: Mock;
  mutation: {
    isPending: boolean;
    isError: boolean;
    error: HostRpcError | null;
    variables: { action: SimulatorAction } | undefined;
  };
}

const fakes = vi.hoisted((): DrawerFakes => ({
  detail: {
    simulatorId: "udid-1",
    platform: "ios",
    settings: {
      appearance: "light",
      textSize: "default",
      reduceMotion: false,
      increaseContrast: false,
      reduceTransparency: false,
      showBorders: false,
      voiceOver: false,
      liquidGlass: "clear",
      colorFilter: "none",
      networkEnabled: null,
      location: null,
    },
    foregroundApp: null,
    readAt: "2026-10-18T00:00:00.000Z",
  },
  mutate: vi.fn(),
  mutation: {
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  },
}));

vi.mock("@/hooks/simulator/use-simulator-mutations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/simulator/use-simulator-mutations")
    >();
  return {
    ...actual,
    useSimulatorDetailQuery: () => ({
      data: fakes.detail,
      isFetching: false,
      isError: false,
      error: null,
    }),
    useSimulatorDrawerActionMutation: () => ({
      mutation: { ...fakes.mutation, mutate: fakes.mutate },
      supported: true,
    }),
  };
});

/** `withSettings` replaces `fakes.detail` and never mutates it. */
const BASELINE_DETAIL = fakes.detail;

function withSettings(overrides: Partial<SimulatorSettings>): void {
  fakes.detail = {
    ...fakes.detail,
    settings: { ...fakes.detail.settings, ...overrides },
  };
}

function renderDrawer(platform: SimulatorPlatform): void {
  render(
    <SimulatorSettingsDrawer
      client={null}
      hostId={HOST}
      epicId={EPIC}
      simulatorId={UDID}
      platform={platform}
      onClose={vi.fn()}
    />,
  );
}

function expectSent(action: SimulatorAction): void {
  expect(fakes.mutate).toHaveBeenCalledTimes(1);
  expect(fakes.mutate).toHaveBeenCalledWith({
    epicId: EPIC,
    simulatorId: UDID,
    action,
  });
}

function typeInto(name: string, value: string): void {
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
}

beforeEach(() => {
  fakes.detail = BASELINE_DETAIL;
  fakes.mutation = {
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SimulatorSettingsDrawer", () => {
  it("sends the segment pressed in Appearance and Text size", () => {
    renderDrawer("ios");
    fireEvent.click(
      within(screen.getByRole("group", { name: "Appearance" })).getByRole(
        "button",
        { name: "Dark" },
      ),
    );
    expectSent({ type: "setAppearance", value: "dark" });

    fakes.mutate.mockClear();
    fireEvent.click(
      within(screen.getByRole("group", { name: "Text size" })).getByRole(
        "button",
        { name: "Large" },
      ),
    );
    expectSent({ type: "setTextSize", value: "large" });
  });

  it("sends an accessibility toggle's new value", () => {
    renderDrawer("ios");
    fireEvent.click(screen.getByTestId("simulator-toggle-reduceMotion"));
    expectSent({ type: "setToggle", setting: "reduceMotion", value: true });
  });

  it("sets a typed location", () => {
    renderDrawer("ios");
    typeInto("Latitude", "37.33");
    typeInto("Longitude", "-122.03");
    fireEvent.click(screen.getByRole("button", { name: "Set location" }));
    expectSent({ type: "setLocation", latitude: 37.33, longitude: -122.03 });
  });

  it("opens a typed URL", () => {
    renderDrawer("ios");
    typeInto("URL", "https://example.com");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expectSent({ type: "openUrl", url: "https://example.com" });
  });

  it("launches and terminates the app named in the bundle id field", () => {
    renderDrawer("ios");
    typeInto("Bundle ID", "com.example.app");
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expectSent({ type: "launchApp", appId: "com.example.app" });

    fakes.mutate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    expectSent({ type: "terminateApp", appId: "com.example.app" });
  });

  it("grants the default permission to the named app", () => {
    renderDrawer("ios");
    typeInto("Bundle ID", "com.example.app");
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    expectSent({
      type: "setPermission",
      appId: "com.example.app",
      permission: "camera",
      decision: "grant",
    });
  });

  it("sends a push message to the named app on iOS", () => {
    renderDrawer("ios");
    typeInto("Bundle ID", "com.example.app");
    typeInto("Push message", "Hello");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expectSent({
      type: "sendPush",
      appId: "com.example.app",
      payload: "Hello",
    });
  });

  it("draws only the iOS controls on iOS", () => {
    renderDrawer("ios");
    expect(screen.queryByTestId("simulator-toggle-networkEnabled")).toBeNull();
    expect(screen.getByRole("group", { name: "Liquid Glass" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Push message" })).toBeTruthy();
  });

  it("draws only the Android controls on Android", () => {
    withSettings({ networkEnabled: true });
    renderDrawer("android");
    expect(screen.getByTestId("simulator-toggle-networkEnabled")).toBeTruthy();
    expect(screen.queryByTestId("simulator-toggle-voiceOver")).toBeNull();
    expect(
      screen.queryByTestId("simulator-toggle-increaseContrast"),
    ).toBeNull();
    expect(screen.queryByRole("group", { name: "Liquid Glass" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Color filter" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Push message" })).toBeNull();
  });

  it("prints the host's refusal under the control that sent it, and nowhere else", () => {
    fakes.mutation = {
      isPending: false,
      isError: true,
      error: new HostRpcError({
        code: "RPC_ERROR",
        message:
          "simulator action unavailable (operation=setToggle platform=ios reason=helper_missing): a helper this needs is missing from the installed simulator tools. Turn simulator support off and on again to reinstall them.",
        requestId: "request-1",
        method: "simulator.action",
        fatalDetails: null,
      }),
      variables: {
        action: { type: "setToggle", setting: "reduceMotion", value: true },
      },
    };
    renderDrawer("ios");
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain(
      "A helper this needs is missing from the installed simulator tools.",
    );
    const reduceMotionRow = screen
      .getByTestId("simulator-toggle-reduceMotion")
      .closest("label")?.parentElement;
    expect(reduceMotionRow?.contains(alerts[0])).toBe(true);
  });

  it("presses no segment for an unread value, and keeps an unread toggle inert", () => {
    withSettings({ appearance: null, reduceMotion: null });
    renderDrawer("ios");
    const appearance = screen.getByRole("group", { name: "Appearance" });
    for (const segment of within(appearance).getAllByRole("button")) {
      expect(segment.getAttribute("aria-pressed")).toBe("false");
    }
    expect(
      screen
        .getByTestId("simulator-toggle-reduceMotion")
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
