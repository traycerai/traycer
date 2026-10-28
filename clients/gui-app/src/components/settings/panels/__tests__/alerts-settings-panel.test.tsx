import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { AlertsSettingsPanel } from "@/components/settings/panels/alerts-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const navigateToSettingsSectionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: navigateToSettingsSectionMock,
}));

afterEach(() => {
  cleanup();
  navigateToSettingsSectionMock.mockClear();
});

const SEVERITY_SWITCHES = [
  "Needs action push notifications",
  "Failure push notifications",
  "Done push notifications",
  "Info push notifications",
];

describe("<AlertsSettingsPanel />", () => {
  it("titles the page Alerts and always draws the Notification events row", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    expect(screen.getByRole("heading", { name: "Alerts" })).toBeTruthy();
    expect(
      screen.getByText("How this app alerts you across hosts."),
    ).toBeTruthy();
    expect(screen.getByTestId("alerts-notifications-section")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Notifications" }),
    ).toBeTruthy();
    expect(screen.getByText("Notification events")).toBeTruthy();
    expect(screen.queryByText("OS notifications")).toBeNull();
    expect(screen.queryByText("Push notifications on this phone")).toBeNull();
  });

  it("draws the OS row on the desktop and never the push rows", () => {
    renderPanel({
      pushPermission: null,
      systemSettings: { open: () => Promise.resolve() },
    });

    const section = screen.getByTestId("alerts-notifications-section");
    expect(section.contains(screen.getByText("OS notifications"))).toBe(true);
    expect(screen.getByText("Notification events")).toBeTruthy();
    expect(screen.queryByText("Push notifications on this phone")).toBeNull();
    expect(screen.queryAllByRole("switch")).toEqual([]);
  });

  it("draws the push rows on the phone and never the OS row", async () => {
    renderPanel({
      pushPermission: fakePushPermission("granted"),
      systemSettings: null,
    });

    const section = screen.getByTestId("alerts-notifications-section");
    expect(
      section.contains(
        await screen.findByText("Push notifications on this phone"),
      ),
    ).toBe(true);
    for (const name of SEVERITY_SWITCHES) {
      expect(section.contains(screen.getByRole("switch", { name }))).toBe(true);
    }
    expect(screen.getByText("Notification events")).toBeTruthy();
    expect(screen.queryByText("OS notifications")).toBeNull();
  });

  it("offers Open Settings on the phone once push is turned off in the OS", async () => {
    renderPanel({
      pushPermission: fakePushPermission("denied"),
      systemSettings: null,
    });

    const action = await screen.findByTestId("push-permission-action");
    expect(action.textContent).toContain("Open Settings");
    expect(action.hasAttribute("disabled")).toBe(false);
  });

  it("points desktop users to native notification settings", async () => {
    const open = vi.fn(() => Promise.resolve());
    renderPanel({ pushPermission: null, systemSettings: { open } });

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
  const runnerHost = createFakeRunnerHost({
    pushPermission: capabilities.pushPermission,
    notifications: {
      ...baseRunnerHost.notifications,
      systemSettings: capabilities.systemSettings,
    },
  });
  render(
    <Providers queryClient={queryClient} runnerHost={runnerHost}>
      <AlertsSettingsPanel />
    </Providers>,
  );
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
    getMutedSeverities: () => Promise.resolve([]),
    setMutedSeverities: () => Promise.resolve(),
    onChange: () => ({ dispose: () => undefined }),
  };
}
