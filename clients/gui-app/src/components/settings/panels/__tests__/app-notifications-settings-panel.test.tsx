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
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { DEFAULT_NOTIFICATION_CHIME_SOUNDS } from "@/lib/notifications/notification-chime";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

afterEach(() => {
  cleanup();
  navigateToSettingsSectionMock.mockClear();
  useSettingsStore.setState({
    notificationChimeSounds: DEFAULT_NOTIFICATION_CHIME_SOUNDS,
  });
});

describe("<AppNotificationsSettingsPanel />", () => {
  it("owns the app-wide sound setting without host filtering", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    expect(
      within(screen.getByTestId("notification-chime-section")).getByRole(
        "heading",
        { name: "Sound" },
      ),
    ).toBeTruthy();
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
});

interface NotificationCapabilities {
  readonly pushPermission: IPushPermissionHost | null;
  readonly systemSettings: INotificationSystemSettingsHost | null;
}

function renderPanel(capabilities: NotificationCapabilities): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const baseRunnerHost = createFakeRunnerHost({});
  render(
    <Providers
      queryClient={queryClient}
      pushPermission={capabilities.pushPermission}
      systemSettings={capabilities.systemSettings}
      baseRunnerHost={baseRunnerHost}
    >
      <AppNotificationsSettingsPanel />
    </Providers>,
  );
}

function Providers(props: {
  readonly children: ReactNode;
  readonly pushPermission: IPushPermissionHost | null;
  readonly systemSettings: INotificationSystemSettingsHost | null;
  readonly queryClient: QueryClient;
  readonly baseRunnerHost: IRunnerHost;
}): ReactNode {
  return (
    <QueryClientProvider client={props.queryClient}>
      <RunnerHostProvider
        runnerHost={createFakeRunnerHost({
          pushPermission: props.pushPermission,
          notifications: {
            ...props.baseRunnerHost.notifications,
            systemSettings: props.systemSettings,
          },
        })}
      >
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
