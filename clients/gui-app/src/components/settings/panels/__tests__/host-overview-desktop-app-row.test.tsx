import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
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
): RenderResult {
  return render(
    <HostOverviewDesktopAppRow bridge={bridge} snapshot={snapshot} />,
  );
}

function announcement(): string {
  return screen.getByRole("status").textContent;
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

  it("keeps Download while downloading as an inert, still-focusable control, and says so in the live region", () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({
        status: "downloading",
        latestVersion: "1.5.0",
        downloadProgress: 42,
      }),
      bridge,
    );
    expect(stateText()).toBe("Downloading 42%");
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.textContent).toContain("Download");
    // `aria-disabled`, never natively `disabled`: Chromium takes the focus
    // off a button the moment it becomes `disabled` and does not return it.
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(action.hasAttribute("disabled")).toBe(false);
    // Never the percentage: it would be read out on every tick.
    expect(announcement()).toBe("Downloading the update");
    fireEvent.click(action);
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
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

  it("makes Restart inert, still focusable, while the install is in flight", async () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({
        status: "ready",
        latestVersion: "1.5.0",
        installInFlight: true,
      }),
      bridge,
    );
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.click(action);
    // The install goes through an awaited check before it reaches the
    // bridge, so give a second install the time it would need to arrive.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    // The label does not change, so the row's live region says it.
    expect(action.textContent).toContain("Restart");
    expect(announcement()).toBe("Restarting to install the update");
  });

  it.each([
    [
      "available",
      snapshotWith({ status: "available", latestVersion: "1.5.0" }),
    ],
    ["up to date", snapshotWith({ status: "up-to-date" })],
    ["checking", snapshotWith({ status: "checking" })],
    [
      "a plain error",
      snapshotWith({ status: "error", errorMessage: "offline" }),
    ],
  ])("keeps the live region mounted and empty when %s", (_name, snapshot) => {
    // Standing, so that a later change of its content is announced: a region
    // inserted already filled is not.
    renderRow(snapshot, new StubBridge());
    expect(announcement()).toBe("");
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

  it("keeps a finishable ready state when an install fails with manual guidance", () => {
    const bridge = new StubBridge();
    renderRow(
      snapshotWith({
        status: "error",
        latestVersion: "1.5.0",
        errorMessage: "install failed",
        installGuidance: {
          summary: "Install the package",
          steps: ["Run the command"],
          command: "sudo dpkg -i traycer.deb",
          releaseUrl: "https://example.invalid/release",
        },
      }),
      bridge,
    );
    expect(stateText()).toBe("v1.5.0 ready");
    // Not the bare "ready" a restart was pressed from: the failed prompt has
    // to be heard as a change.
    expect(announcement()).toBe(
      "v1.5.0 ready. Finishing the update needs a manual step.",
    );
    const action = screen.getByTestId("host-overview-desktop-app-action");
    expect(action.textContent).toContain("Finish update");
    fireEvent.click(action);
    expect(useDesktopDialogStore.getState().activeDialog).toBe(
      "install-guidance",
    );
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("is exposed as a group named Traycer Desktop", () => {
    renderRow(snapshotWith({}), new StubBridge());
    screen.getByRole("group", { name: "Traycer Desktop" });
  });

  it("keeps ONE button node from available through downloading to ready", () => {
    const bridge = new StubBridge();
    const view = renderRow(
      snapshotWith({ status: "available", latestVersion: "1.5.0" }),
      bridge,
    );
    const first = screen.getByTestId("host-overview-desktop-app-action");
    first.focus();
    expect(document.activeElement).toBe(first);

    view.rerender(
      <HostOverviewDesktopAppRow
        bridge={bridge}
        snapshot={snapshotWith({
          status: "downloading",
          latestVersion: "1.5.0",
          downloadProgress: 10,
        })}
      />,
    );
    const second = screen.getByTestId("host-overview-desktop-app-action");
    expect(second).toBe(first);
    // Waiting, not natively `disabled`: that is what keeps the focus here in
    // Chromium, which drops it from a button that becomes `disabled`. jsdom
    // would keep it either way, so the attribute is the assertion that
    // matters; the focus one only shows nothing else moved it.
    expect(first.hasAttribute("disabled")).toBe(false);
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.contains(first)).toBe(true);
    expect(document.activeElement).toBe(first);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Downloading the update");

    view.rerender(
      <HostOverviewDesktopAppRow
        bridge={bridge}
        snapshot={snapshotWith({ status: "ready", latestVersion: "1.5.0" })}
      />,
    );
    const third = screen.getByTestId("host-overview-desktop-app-action");
    expect(third).toBe(first);
    expect(third.textContent).toContain("Restart");
    expect(third.hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(document.body.contains(first)).toBe(true);
    // The SAME region node, its content changed: that is what gets the
    // download landing announced.
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("v1.5.0 ready");
  });

  describe("focus hand-off when the action is withdrawn", () => {
    const availableSnapshot = snapshotWith({
      status: "available",
      latestVersion: "1.5.0",
    });
    const errorSnapshot = snapshotWith({
      status: "error",
      latestVersion: "1.5.0",
      errorMessage: "download failed",
    });

    it("moves focus to the row when the focused button goes away", () => {
      const bridge = new StubBridge();
      const view = renderRow(availableSnapshot, bridge);
      const button = screen.getByTestId("host-overview-desktop-app-action");
      button.focus();
      expect(document.activeElement).toBe(button);

      view.rerender(
        <HostOverviewDesktopAppRow bridge={bridge} snapshot={errorSnapshot} />,
      );
      expect(
        screen.queryByTestId("host-overview-desktop-app-action"),
      ).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByTestId("host-overview-desktop-app-row"),
      );
    });

    it("leaves focus alone when the button was not focused", () => {
      const bridge = new StubBridge();
      const view = render(
        <>
          <input data-testid="elsewhere" />
          <HostOverviewDesktopAppRow
            bridge={bridge}
            snapshot={availableSnapshot}
          />
        </>,
      );
      const elsewhere = screen.getByTestId("elsewhere");
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);

      view.rerender(
        <>
          <input data-testid="elsewhere" />
          <HostOverviewDesktopAppRow bridge={bridge} snapshot={errorSnapshot} />
        </>,
      );
      expect(
        screen.queryByTestId("host-overview-desktop-app-action"),
      ).toBeNull();
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(
        screen.getByTestId("host-overview-desktop-app-row"),
      );
    });

    it("does not throw when the whole row unmounts with the button focused", () => {
      const view = renderRow(availableSnapshot, new StubBridge());
      const button = screen.getByTestId("host-overview-desktop-app-action");
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(() => view.unmount()).not.toThrow();
    });
  });
});
