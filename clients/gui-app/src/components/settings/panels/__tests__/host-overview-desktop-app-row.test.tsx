import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostOverviewDesktopAppRow } from "@/components/settings/panels/host-overview-desktop-app-row";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
  DesktopCompatRecoveryPlan,
} from "@/lib/windows/types";

afterEach(() => {
  cleanup();
  useDesktopDialogStore.setState({ activeDialog: null });
});

const BASE_SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 1,
  status: "idle",
  currentVersion: "1.4.0",
  allowPrerelease: false,
  latestVersion: null,
  latestCompatibilityEpoch: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

function snapshotWith(
  overrides: Partial<DesktopAppUpdateSnapshot>,
): DesktopAppUpdateSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

class StubBridge implements DesktopAppUpdatesBridge {
  readonly getSnapshot = vi.fn((): Promise<DesktopAppUpdateSnapshot> =>
    Promise.resolve(BASE_SNAPSHOT),
  );
  readonly checkForUpdates = vi.fn(
    (_intent: DesktopAppUpdateCheckIntent): Promise<DesktopAppUpdateSnapshot> =>
      Promise.resolve(BASE_SNAPSHOT),
  );
  readonly setAllowPrerelease = vi.fn(
    (): Promise<DesktopAppUpdateChannelChange> =>
      Promise.resolve({ outcome: "changed", snapshot: BASE_SNAPSHOT }),
  );
  readonly resolveCompatRecovery = vi.fn(
    (): Promise<DesktopCompatRecoveryPlan> =>
      Promise.resolve({
        route: "manual",
        rcCandidateVersion: null,
        stagedVersion: null,
      }),
  );
  readonly downloadUpdate = vi.fn(() => Promise.resolve(BASE_SNAPSHOT));
  readonly installUpdate = vi.fn(() => Promise.resolve(BASE_SNAPSHOT));
  onChange(): { dispose(): void } {
    return { dispose: () => undefined };
  }
}

function renderRow(
  snapshot: DesktopAppUpdateSnapshot,
  bridge: StubBridge,
): void {
  render(<HostOverviewDesktopAppRow bridge={bridge} snapshot={snapshot} />);
}

function stateText(): string {
  return screen.getByTestId("host-overview-desktop-app-state").textContent;
}

describe("<HostOverviewDesktopAppRow />", () => {
  it("offers Download for an available update and starts the download", () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({ status: "available", latestVersion: "1.5.0" }),
      bridge,
    );
    expect(stateText()).toBe("v1.5.0 available");
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.textContent).toContain("Download");
    fireEvent.click(action);
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("disables Download and shows the reason when the install is blocked", () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({
        status: "available",
        latestVersion: "1.5.0",
        installBlockedReason: "Move Traycer to /Applications to update.",
      }),
      bridge,
    );
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.hasAttribute("disabled")).toBe(true);
    screen.getByText("Move Traycer to /Applications to update.");
    fireEvent.click(action);
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
  });

  it("shows download progress with no action while downloading", () => {
    renderRow(
      snapshotWith({
        status: "downloading",
        latestVersion: "1.5.0",
        downloadProgress: 42,
      }),
      new StubBridge(),
    );
    expect(stateText()).toBe("Downloading 42%");
    expect(screen.queryByTestId("host-overview-desktop-app-action")).toBeNull();
  });

  it("shows plain Downloading when progress is not known", () => {
    renderRow(
      snapshotWith({ status: "downloading", latestVersion: "1.5.0" }),
      new StubBridge(),
    );
    expect(stateText()).toBe("Downloading");
  });

  it("offers Restart for a ready update and reaches installUpdate", async () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({ status: "ready", latestVersion: "1.5.0" }),
      bridge,
    );
    expect(stateText()).toBe("v1.5.0 ready");
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.textContent).toContain("Restart");
    fireEvent.click(action);
    await vi.waitFor(() => {
      expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("disables Restart while the install is in flight", () => {
    renderRow(
      snapshotWith({
        status: "ready",
        latestVersion: "1.5.0",
        installInFlight: true,
      }),
      new StubBridge(),
    );
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.hasAttribute("disabled")).toBe(true);
    // The label does not change, so the restart is announced by a live
    // region inside the button.
    expect(action.textContent).toContain("Restart");
    screen.getByRole("status", { name: "Restarting to install the update" });
  });

  it("announces no restart while a ready update is only waiting", () => {
    renderRow(
      snapshotWith({ status: "ready", latestVersion: "1.5.0" }),
      new StubBridge(),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers Finish update when guidance is set and opens the guidance dialog", () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({
        status: "ready",
        latestVersion: "1.5.0",
        installGuidance: {
          summary: "Install the package",
          steps: ["Run the command"],
          command: "sudo dpkg -i traycer.deb",
          releaseUrl: "https://example.invalid/release",
        },
      }),
      bridge,
    );
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.textContent).toContain("Finish update");
    fireEvent.click(action);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "install-guidance",
    );
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("claims Up to date for an up-to-date snapshot, with no action", () => {
    renderRow(snapshotWith({ status: "up-to-date" }), new StubBridge());
    expect(stateText()).toBe("Up to date (v1.4.0)");
    expect(screen.queryByTestId("host-overview-desktop-app-action")).toBeNull();
  });

  it("claims Up to date after an automatic check that found nothing (idle + lastCheckedAt + latestVersion)", () => {
    renderRow(
      snapshotWith({
        status: "idle",
        lastCheckedAt: "2026-10-06T00:00:00.000Z",
        latestVersion: "1.4.0",
        lastCheckIntent: "automatic",
      }),
      new StubBridge(),
    );
    expect(stateText()).toBe("Up to date (v1.4.0)");
  });

  it.each([
    ["idle, never checked", snapshotWith({ status: "idle" })],
    [
      "idle, checked but no latest version",
      snapshotWith({
        status: "idle",
        lastCheckedAt: "2026-10-06T00:00:00.000Z",
      }),
    ],
    ["checking", snapshotWith({ status: "checking" })],
    ["error", snapshotWith({ status: "error", errorMessage: "offline" })],
    ["unavailable", snapshotWith({ status: "unavailable" })],
  ])("shows only the version, never Up to date, when %s", (_name, snapshot) => {
    renderRow(snapshot, new StubBridge());
    expect(stateText()).toBe("v1.4.0");
    expect(stateText()).not.toContain("Up to date");
    expect(screen.queryByTestId("host-overview-desktop-app-action")).toBeNull();
  });

  it("renders nothing before the first snapshot names a version", () => {
    renderRow(snapshotWith({ currentVersion: "" }), new StubBridge());
    expect(screen.queryByTestId("host-overview-desktop-app-row")).toBeNull();
  });
});
