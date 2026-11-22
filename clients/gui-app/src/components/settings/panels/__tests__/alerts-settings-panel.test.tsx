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
} from "@traycer-clients/shared/platform/runner-host";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { doubleFor } from "./push-permission-double";
import { AlertsSettingsPanel } from "@/components/settings/panels/alerts-settings-panel";
import { setMobileApp } from "@/lib/mobile-app";
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
  setMobileApp(false);
  playNotificationChimeSoundMock.mockClear();
  window.localStorage.clear();
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
});

const KINDS = ["Needs action", "Failure", "Done", "Info"] as const;

describe("<AlertsSettingsPanel />", () => {
  it("draws one table of kinds with a Notify switch and a chime each, and no events pointer", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    expect(screen.getByRole("heading", { name: "Alerts" })).toBeTruthy();
    expect(
      screen.getByText(
        "What interrupts you on this computer. Every notification still appears in the bell.",
      ),
    ).toBeTruthy();
    const table = screen.getByTestId("alerts-notification-kinds");
    for (const kind of KINDS) {
      expect(
        within(table).getByRole("switch", { name: `${kind} notifications` }),
      ).toBeTruthy();
      expect(
        within(table).getByRole("combobox", { name: `${kind} sound` }),
      ).toBeTruthy();
    }
    expect(within(table).getByText("Notify")).toBeTruthy();
    expect(within(table).queryByText("Push")).toBeNull();
    expect(screen.queryByText("Notification events")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Notifications" })).toBe(
      null,
    );
  });

  it("anchors each kind's row for settings search", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    const table = screen.getByTestId("alerts-notification-kinds");
    for (const anchor of [
      "alerts-needs-action",
      "alerts-failure",
      "alerts-done",
      "alerts-info",
    ]) {
      expect(
        table.querySelector(`[data-settings-anchor="${anchor}"]`),
      ).not.toBe(null);
    }
  });

  it("shows the defaults: Info is quiet, the other kinds notify", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    const checked = (kind: string): string | null =>
      screen
        .getByRole("switch", { name: `${kind} notifications` })
        .getAttribute("aria-checked");
    expect(checked("Needs action")).toBe("true");
    expect(checked("Failure")).toBe("true");
    expect(checked("Done")).toBe("true");
    expect(checked("Info")).toBe("false");
  });

  it("writes a Notify switch to the settings store", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    fireEvent.click(screen.getByRole("switch", { name: "Info notifications" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Failure notifications" }),
    );

    expect(useSettingsStore.getState().notificationNotify).toEqual({
      needs_action: true,
      failure: false,
      done: true,
      info: true,
    });
  });

  it("draws no System card where the shell has neither OS settings nor push", () => {
    renderPanel({ pushPermission: null, systemSettings: null });

    expect(screen.queryByTestId("alerts-system-section")).toBeNull();
    expect(screen.queryByText("OS notifications")).toBeNull();
    expect(screen.queryByText("Push notifications")).toBeNull();
  });

  it("puts the OS row in a System card after the table on the desktop", () => {
    renderPanel({
      pushPermission: null,
      systemSettings: { open: () => Promise.resolve() },
    });

    const system = screen.getByTestId("alerts-system-section");
    expect(within(system).getByText("OS notifications")).toBeTruthy();
    expect(screen.queryByText("Push notifications")).toBeNull();
    const table = screen.getByTestId("alerts-notification-kinds");
    expect(
      table.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("points desktop users to native notification settings", async () => {
    const open = vi.fn(() => Promise.resolve());
    renderPanel({ pushPermission: null, systemSettings: { open } });

    fireEvent.click(screen.getByTestId("system-notification-settings-action"));

    await waitFor(() => {
      expect(open).toHaveBeenCalledOnce();
    });
  });

  it("puts the push permission row before a Push column on the phone", async () => {
    setMobileApp(true);
    renderPanel({
      pushPermission: doubleFor("granted").host,
      systemSettings: null,
    });

    const system = screen.getByTestId("alerts-system-section");
    expect(within(system).getByText("Push notifications")).toBeTruthy();
    expect(screen.queryByText("OS notifications")).toBeNull();
    expect(
      screen.getByText(
        "What interrupts you on this device. Every notification still appears in the bell.",
      ),
    ).toBeTruthy();
    const table = screen.getByTestId("alerts-notification-kinds");
    expect(within(table).getByText("Push")).toBeTruthy();
    expect(within(table).queryByText("Notify")).toBeNull();
    expect(
      within(table).queryByRole("switch", { name: "Info notifications" }),
    ).toBeNull();
    expect(
      within(table).getByRole("switch", { name: "Info push notifications" }),
    ).toBeTruthy();
    expect(
      system.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    await waitFor(() => {
      expect(screen.getByTestId("push-permission-state").dataset.state).toBe(
        "registered",
      );
    });
  });

  it("offers Open Settings on the phone once push is turned off in the OS", async () => {
    renderPanel({
      pushPermission: doubleFor("denied").host,
      systemSettings: null,
    });

    const action = await screen.findByTestId("push-permission-action");
    expect(action.textContent).toContain("Open Settings");
    expect(action.hasAttribute("disabled")).toBe(false);
  });
});

describe("<AlertsSettingsPanel /> chimes", () => {
  it("shows the chime a persisted blob chose for a kind, and writes the same key on a change", async () => {
    window.localStorage.setItem(
      "traycer-gui-app:settings",
      JSON.stringify({
        state: { notificationChimeSounds: { failure: "classic" } },
        version: 1,
      }),
    );
    await useSettingsStore.persist.rehydrate();
    renderPanel({ pushPermission: null, systemSettings: null });

    const failure = screen.getByRole("combobox", { name: "Failure sound" });
    expect(failure.textContent).toContain("Classic");

    fireEvent.keyDown(failure, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("option", { name: "Coin" }), {
      key: "Enter",
    });

    expect(useSettingsStore.getState().notificationChimeSounds.failure).toBe(
      "coin",
    );
    const stored = JSON.parse(
      window.localStorage.getItem("traycer-gui-app:settings") ?? "{}",
    ) as { state?: { notificationChimeSounds?: { failure?: string } } };
    expect(stored.state?.notificationChimeSounds?.failure).toBe("coin");
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
