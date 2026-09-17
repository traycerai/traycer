import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  INotificationSystemSettingsHost,
  IPushPermissionHost,
  IRunnerHost,
  PushPermissionState,
} from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { assertSettingsSearchTargets } from "@/components/settings/__tests__/settings-search-targets";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import {
  isPushPermissionGroupAvailable,
  isSystemNotificationsGroupAvailable,
} from "@/lib/settings/settings-availability";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());
const playNotificationChimeSoundMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

vi.mock("@/lib/notifications/notification-chime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/notifications/notification-chime")
  >()),
  playNotificationChimeSound: playNotificationChimeSoundMock,
}));

afterEach(() => {
  cleanup();
  navigateToSettingsSectionMock.mockClear();
  playNotificationChimeSoundMock.mockClear();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

describe("<AppNotificationsSettingsPanel />", () => {
  it("owns the app-wide sound setting without host filtering", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    expect(screen.getByRole("heading", { name: "Sounds" })).toBeTruthy();
    expect(
      screen.getByText(
        "Which chime plays for each kind of alert, across hosts.",
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("notification-chime-section")).queryByRole(
        "heading",
      ),
    ).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Needs action sound" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Failure sound" }),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Done sound" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Info sound" })).toBeTruthy();
    expect(
      screen.getByText(
        "Sharing, comments, access changes, and other informational notifications.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Warm, calm, and deliberately subtle."),
    ).toBeNull();
    expect(screen.queryByTestId("notifications-severity-policy")).toBeNull();
  });

  it("previews a selected chime before persisting the setting", () => {
    const persistSelection = vi.fn();
    useSettingsStore.setState({
      setNotificationChimeSoundForEvent: persistSelection,
    });
    renderPanel({ pushPermission: null, systemSettings: null });

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Failure sound" }), {
      key: "ArrowDown",
    });
    const classicOption = screen.getByRole("option", { name: "Classic" });
    fireEvent.focus(classicOption);
    fireEvent.keyDown(classicOption, { key: "Enter" });

    expect(playNotificationChimeSoundMock).toHaveBeenCalledWith("classic");
    expect(persistSelection).toHaveBeenCalledWith("failure", "classic");
    expect(
      playNotificationChimeSoundMock.mock.invocationCallOrder[0],
    ).toBeLessThan(persistSelection.mock.invocationCallOrder[0]);
  });

  it("previews the currently selected chime when it is clicked again", () => {
    const persistSelection = vi.fn();
    useSettingsStore.setState({
      setNotificationChimeSoundForEvent: persistSelection,
    });
    renderPanel({ pushPermission: null, systemSettings: null });

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Failure sound" }), {
      key: "ArrowDown",
    });
    const selectedOption = screen.getByRole("option", { name: "Rift" });
    fireEvent.pointerDown(selectedOption, { pointerType: "mouse" });
    fireEvent.pointerUp(selectedOption, { pointerType: "mouse" });

    expect(playNotificationChimeSoundMock).toHaveBeenCalledWith("rift");
    expect(persistSelection).not.toHaveBeenCalled();
  });

  it("previews a chime activated by a synthesized click", () => {
    const persistSelection = vi.fn();
    useSettingsStore.setState({
      setNotificationChimeSoundForEvent: persistSelection,
    });
    renderPanel({ pushPermission: null, systemSettings: null });

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Failure sound" }), {
      key: "ArrowDown",
    });
    fireEvent.click(screen.getByRole("option", { name: "Classic" }), {
      detail: 0,
    });

    expect(playNotificationChimeSoundMock).toHaveBeenCalledWith("classic");
    expect(persistSelection).toHaveBeenCalledWith("failure", "classic");
  });

  it("owns this phone's OS push permission", async () => {
    renderPanel({
      pushPermission: fakePushPermission("denied"),
      systemSettings: null,
    });

    expect(await screen.findByText("This phone")).toBeTruthy();
    const action = await screen.findByTestId("push-permission-action");
    expect(action.textContent).toContain("Open Settings");
    expect(action.hasAttribute("disabled")).toBe(false);
  });

  it("points desktop users to native notification settings", async () => {
    const open = vi.fn(() => Promise.resolve());
    renderPanel({
      pushPermission: null,
      systemSettings: { open },
    });

    expect(screen.getByText("OS notifications")).toBeTruthy();
    fireEvent.click(screen.getByTestId("system-notification-settings-action"));

    await waitFor(() => {
      expect(open).toHaveBeenCalledOnce();
    });
  });

  it("points event-level controls to the selected host", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    fireEvent.click(
      screen.getByRole("button", { name: "Open Host Notifications" }),
    );

    expect(navigateToSettingsSectionMock).toHaveBeenCalledWith("notifications");
  });

  // The search index offers the System and This phone groups exactly where
  // they render: each bridge alone, both, and neither — the last is what
  // catches an entry left always-available while its group is gated.
  describe("search targets", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly capabilities: NotificationCapabilities;
      readonly system: boolean;
      readonly push: boolean;
    }> = [
      {
        name: "every bridge absent",
        capabilities: { pushPermission: null, systemSettings: null },
        system: false,
        push: false,
      },
      {
        name: "only the OS notification-settings bridge",
        capabilities: {
          pushPermission: null,
          systemSettings: { open: () => Promise.resolve() },
        },
        system: true,
        push: false,
      },
      {
        name: "only the push-permission bridge",
        capabilities: {
          pushPermission: fakePushPermission("granted"),
          systemSettings: null,
        },
        system: false,
        push: true,
      },
      {
        name: "both bridges",
        capabilities: {
          pushPermission: fakePushPermission("prompt"),
          systemSettings: { open: () => Promise.resolve() },
        },
        system: true,
        push: true,
      },
    ];

    for (const testCase of cases) {
      it(`matches the index with ${testCase.name}`, () => {
        const { container, runnerHost } = mountPanel(testCase.capabilities);
        const context = {
          runnerHost,
          featureSettings: null,
          mobileApp: false,
          mobileFooter: false,
        };
        expect(isSystemNotificationsGroupAvailable(context)).toBe(
          testCase.system,
        );
        expect(isPushPermissionGroupAvailable(context)).toBe(testCase.push);

        assertSettingsSearchTargets("app-notifications", context, container);
      });
    }
  });
});

interface NotificationCapabilities {
  readonly pushPermission: IPushPermissionHost | null;
  readonly systemSettings: INotificationSystemSettingsHost | null;
}

function renderPanel(capabilities: NotificationCapabilities): void {
  mountPanel(capabilities);
}

/** Mounts the panel and returns the runner host it was mounted under. */
function mountPanel(capabilities: NotificationCapabilities): {
  readonly container: HTMLElement;
  readonly runnerHost: IRunnerHost;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const baseRunnerHost = createFakeRunnerHost({});
  const runnerHost = createFakeRunnerHost({
    pushPermission: capabilities.pushPermission,
    notifications: {
      ...baseRunnerHost.notifications,
      systemSettings: capabilities.systemSettings,
    },
  });
  const { container } = render(
    <Providers queryClient={queryClient} runnerHost={runnerHost}>
      <AppNotificationsSettingsPanel />
    </Providers>,
  );
  return { container, runnerHost };
}

function Providers(props: {
  readonly children: ReactNode;
  readonly queryClient: QueryClient;
  readonly runnerHost: IRunnerHost;
}): ReactNode {
  return (
    <QueryClientProvider client={props.queryClient}>
      <RunnerHostProvider runnerHost={props.runnerHost}>
        {props.children}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

function fakePushPermission(state: PushPermissionState): IPushPermissionHost {
  return {
    get: () => Promise.resolve(state),
    request: () => Promise.resolve(state),
    openSettings: () => Promise.resolve(),
    onChange: () => ({ dispose: () => undefined }),
  };
}
