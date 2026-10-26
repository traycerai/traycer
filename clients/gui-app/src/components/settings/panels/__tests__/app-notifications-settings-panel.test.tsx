import {
  cleanup,
  fireEvent,
  render,
  screen,
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

const playNotificationChimeSoundMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notifications/notification-chime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/notifications/notification-chime")
  >()),
  playNotificationChimeSound: playNotificationChimeSoundMock,
}));

afterEach(() => {
  cleanup();
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

  // The OS and push rows and the Notification events pointer live on Alerts;
  // with every bridge present, none of them is drawn here.
  it("draws only the chimes, whatever bridges the shell carries", () => {
    renderPanel({
      pushPermission: fakePushPermission("granted"),
      systemSettings: { open: () => Promise.resolve() },
    });

    expect(screen.getAllByRole("combobox")).toHaveLength(4);
    expect(screen.queryByText("OS notifications")).toBeNull();
    expect(screen.queryByText("Push notifications on this phone")).toBeNull();
    expect(screen.queryByText("Notification events")).toBeNull();
    expect(screen.queryAllByRole("switch")).toEqual([]);
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
      <AppNotificationsSettingsPanel />
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
