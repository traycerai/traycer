import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HostOverviewUpdatesRegion } from "@/components/settings/panels/host-overview-updates";
import {
  describeCliFloorRemedy,
  type CliFloorRemedy,
} from "@/components/settings/panels/host-overview-cli-floor-remedy";
import type { HostOverviewUpdatesSummary } from "@/components/settings/panels/host-overview-updates-state";
import type {
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
  DesktopCompatRecoveryPlan,
} from "@/lib/windows/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const requestInstallMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const clipboardWriteText = vi.fn(() => Promise.resolve());
vi.mock("@/lib/app-update/request-app-update-install", () => ({
  requestAppUpdateInstall: requestInstallMock,
}));

const SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 1,
  status: "available",
  currentVersion: "1.2.0",
  allowPrerelease: false,
  latestVersion: "1.3.0",
  latestCompatibilityEpoch: 1,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
  errorMessage: null,
  lastCheckedAt: "2026-09-06T00:00:00Z",
  lastCheckIntent: "automatic",
};

class FakeDesktopBridge implements DesktopAppUpdatesBridge {
  readonly downloadUpdate = vi.fn(() => Promise.resolve(SNAPSHOT));
  readonly installUpdate = vi.fn(() => Promise.resolve(SNAPSHOT));
  readonly checkForUpdates = vi.fn((_intent: DesktopAppUpdateCheckIntent) =>
    Promise.resolve(SNAPSHOT),
  );

  getSnapshot(): Promise<DesktopAppUpdateSnapshot> {
    return Promise.resolve(SNAPSHOT);
  }

  setAllowPrerelease(
    _allowPrerelease: boolean,
  ): Promise<DesktopAppUpdateChannelChange> {
    return Promise.resolve({ outcome: "unchanged", snapshot: SNAPSHOT });
  }

  resolveCompatRecovery(_request: {
    readonly minimumEpoch: number;
    readonly hostAllowsRcRecovery: boolean;
  }): Promise<DesktopCompatRecoveryPlan> {
    return Promise.resolve({
      route: "manual",
      rcCandidateVersion: null,
      stagedVersion: null,
    });
  }

  onChange(_handler: (snapshot: DesktopAppUpdateSnapshot) => void): {
    dispose(): void;
  } {
    return { dispose: () => undefined };
  }
}

function summary(remedy: CliFloorRemedy): HostOverviewUpdatesSummary {
  return {
    hostName: "build-host",
    description: remedy.sentence,
    failureDescription: null,
    remedy,
    checking: false,
    updatableVersion: null,
    installing: false,
    busy: false,
    onCheck: vi.fn(),
    onUpdateLatest: vi.fn(),
  };
}

function regionElement(
  remedy: CliFloorRemedy,
  bridge: DesktopAppUpdatesBridge | null,
): ReactElement {
  return (
    <TooltipProvider>
      <HostOverviewUpdatesRegion
        summary={summary(remedy)}
        degrade={null}
        desktopBridge={bridge}
        onInstallationHelp={vi.fn()}
      />
    </TooltipProvider>
  );
}

function renderRegion(
  remedy: CliFloorRemedy,
  bridge: DesktopAppUpdatesBridge | null,
): RenderResult {
  return render(regionElement(remedy, bridge));
}

function manualRemedy(binaryPath: string): CliFloorRemedy {
  return describeCliFloorRemedy({
    isLocalMachine: false,
    platform: "darwin-arm64",
    cliSource: "manual",
    cliBinaryPath: binaryPath,
    cliVersion: "1.2.0",
    requiredCliVersion: "1.3.0",
    desktopUpdate: null,
    hostName: "build-host",
  });
}

afterEach(() => {
  cleanup();
  requestInstallMock.mockClear();
  clipboardWriteText.mockClear();
  useDesktopDialogStore.getState().close();
});

describe("HostOverviewUpdatesRegion CLI floor remedy", () => {
  beforeEach(() => {
    clipboardWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  it("renders the sentence in the status span and copies the recorded path command", () => {
    const remedy = manualRemedy("/home/u/.local/bin/traycer");
    renderRegion(remedy, null);

    expect(screen.getByRole("status").textContent).toBe(remedy.sentence);
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(clipboardWriteText).toHaveBeenCalledWith(
      "'/home/u/.local/bin/traycer' cli upgrade",
    );
  });

  it("copies the bare command when the recorded path is unavailable", () => {
    const remedy = manualRemedy("");
    renderRegion(remedy, null);

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(clipboardWriteText).toHaveBeenCalledWith("traycer cli upgrade");
  });

  it("downloads an available Desktop update and never installs directly", () => {
    const bridge = new FakeDesktopBridge();
    const remedy = describeCliFloorRemedy({
      isLocalMachine: true,
      platform: "darwin-arm64",
      cliSource: "desktop",
      cliBinaryPath: null,
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: SNAPSHOT,
      hostName: "build-host",
    });
    renderRegion(remedy, bridge);

    fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    // Keep checking the forbidden routes when a mutation also misses download.
    expect.soft(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(requestInstallMock).not.toHaveBeenCalled();
    // Removing the available-state action gate would install from this row;
    // this negative spy must turn RED under that concrete status-ablation.
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("honors blocked and in-flight Desktop states as disabled, with no install route", () => {
    for (const desktopUpdate of [
      {
        ...SNAPSHOT,
        status: "ready" as const,
        installBlockedReason: "Not in Applications",
      },
      { ...SNAPSHOT, status: "ready" as const, installInFlight: true },
    ]) {
      const bridge = new FakeDesktopBridge();
      const remedy = describeCliFloorRemedy({
        isLocalMachine: true,
        platform: "darwin-arm64",
        cliSource: "desktop",
        cliBinaryPath: null,
        cliVersion: "1.2.0",
        requiredCliVersion: "1.3.0",
        desktopUpdate,
        hostName: "build-host",
      });
      renderRegion(remedy, bridge);
      const button = screen.getByRole("button", { name: "Restart to update" });
      // A broken disabled state must also reach the no-install assertions.
      expect.soft(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
      // Removing the blocked/in-flight disabled predicate would let this
      // control reach an install route; these negative no-install pins must
      // turn RED under that concrete state-gating ablation.
      expect(requestInstallMock).not.toHaveBeenCalled();
      expect(bridge.installUpdate).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("opens the manual Desktop guidance dialog for a ready update", () => {
    const bridge = new FakeDesktopBridge();
    const remedy = describeCliFloorRemedy({
      isLocalMachine: true,
      platform: "linux-x64",
      cliSource: "desktop",
      cliBinaryPath: null,
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: {
        ...SNAPSHOT,
        status: "ready",
        installGuidance: {
          summary: "Use the package manager",
          steps: ["Install the downloaded package"],
          command: "sudo dpkg -i traycer.deb",
          releaseUrl: "https://example.invalid/release",
        },
      },
      hostName: "build-host",
    });
    renderRegion(remedy, bridge);

    fireEvent.click(screen.getByRole("button", { name: "Finish update" }));
    // A missing dialog must not hide a forbidden install in the same click.
    expect
      .soft(useDesktopDialogStore.getState().activeDialog)
      .toBe("install-guidance");
    expect(requestInstallMock).not.toHaveBeenCalled();
  });

  it("routes a ready Desktop update through the shared install request door", () => {
    const bridge = new FakeDesktopBridge();
    const remedy = describeCliFloorRemedy({
      isLocalMachine: true,
      platform: "darwin-arm64",
      cliSource: "desktop",
      cliBinaryPath: null,
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: { ...SNAPSHOT, status: "ready" },
      hostName: "build-host",
    });
    renderRegion(remedy, bridge);

    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    // Retain the direct-install negative when the shared call is also missing.
    expect.soft(requestInstallMock).toHaveBeenCalledWith(bridge);
    // Removing the shared request-door call and invoking bridge.installUpdate
    // in the component would bypass cross-window protection; this negative
    // spy must turn RED under that concrete routing ablation.
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("shows manual retry and help for Desktop failures without automatic checks", async () => {
    const failures = [
      {
        status: "error" as const,
        errorMessage: "Updater failed",
        sentence: "Updater failed",
      },
      {
        status: "unavailable" as const,
        errorMessage: null,
        sentence: "Traycer Desktop couldn't check for updates.",
      },
    ] as const;
    for (const failure of failures) {
      const bridge = new FakeDesktopBridge();
      const remedy = describeCliFloorRemedy({
        isLocalMachine: true,
        platform: "darwin-arm64",
        cliSource: "desktop",
        cliBinaryPath: null,
        cliVersion: "1.2.0",
        requiredCliVersion: "1.3.0",
        desktopUpdate: {
          ...SNAPSHOT,
          status: failure.status,
          errorMessage: failure.errorMessage,
        },
        hostName: "build-host",
      });
      const rendered = renderRegion(remedy, bridge);

      expect(screen.getByRole("status").textContent).toBe(failure.sentence);
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Show installation help" }),
      ).toBeTruthy();
      await waitFor(() =>
        expect(bridge.checkForUpdates).not.toHaveBeenCalled(),
      );
      // D02's automatic retry mapping or D04's removal of only
      // `if (checkOnMount)` would dispatch on this failure mount. Retaining
      // `[bridge, checkOnMount]` isolates the mount guard; this count must
      // remain zero through rerenders until the user clicks.
      rendered.rerender(
        regionElement(
          describeCliFloorRemedy({
            isLocalMachine: true,
            platform: "darwin-arm64",
            cliSource: "desktop",
            cliBinaryPath: null,
            cliVersion: "1.2.0",
            requiredCliVersion: "1.3.0",
            desktopUpdate: { ...SNAPSHOT, status: "checking" },
            hostName: "build-host",
          }),
          bridge,
        ),
      );
      rendered.rerender(regionElement(remedy, bridge));
      await waitFor(() =>
        expect(bridge.checkForUpdates).not.toHaveBeenCalled(),
      );

      // Removing the retry button's manual dispatch would keep this genuine
      // spy at zero; these exact per-click counts must turn RED under D03.
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(bridge.checkForUpdates).toHaveBeenCalledWith("manual");
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      expect(bridge.checkForUpdates).toHaveBeenCalledTimes(2);
      cleanup();
    }
  });

  it("checks an unknown Desktop state once and does not create an effect retry loop", async () => {
    const bridge = new FakeDesktopBridge();
    const remedy = describeCliFloorRemedy({
      isLocalMachine: true,
      platform: "darwin-arm64",
      cliSource: "desktop",
      cliBinaryPath: null,
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: { ...SNAPSHOT, status: "idle" },
      hostName: "build-host",
    });
    const rendered = renderRegion(remedy, bridge);

    await waitFor(() =>
      expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1),
    );
    rendered.rerender(
      regionElement(
        describeCliFloorRemedy({
          isLocalMachine: true,
          platform: "darwin-arm64",
          cliSource: "desktop",
          cliBinaryPath: null,
          cliVersion: "1.2.0",
          requiredCliVersion: "1.3.0",
          desktopUpdate: { ...SNAPSHOT, status: "checking" },
          hostName: "build-host",
        }),
        bridge,
      ),
    );
    await waitFor(() =>
      expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1),
    );
    // Removing ONLY `if (checkOnMount)` while retaining `[bridge, checkOnMount]`
    // would call once on idle mount and again on the idle-to-checking
    // transition; this negative call-count pin must turn RED under D04.
    expect(bridge.checkForUpdates).toHaveBeenCalledWith("manual");
  });
});
