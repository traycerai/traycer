import type { ReactElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
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

  // What MAIN holds, as distinct from what the rendered remedy was derived
  // from: the mount check reads this (`useUpdateCheckOnBlockingMount`), never
  // the remedy's snapshot, which on the first commit is the store's
  // placeholder. A spy, so a negative "did not check" can first prove the
  // hook consulted the bridge at all.
  readonly getSnapshot: Mock<() => Promise<DesktopAppUpdateSnapshot>>;

  constructor(snapshot: DesktopAppUpdateSnapshot) {
    this.getSnapshot = vi.fn(() => Promise.resolve(snapshot));
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

  it("copies Windows Desktop fallback commands and renders PowerShell guidance", () => {
    const binaryPath =
      "C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe";
    const remedy = describeCliFloorRemedy({
      isLocalMachine: true,
      platform: "win32-x64",
      cliSource: "desktop",
      cliBinaryPath: binaryPath,
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: {
        ...SNAPSHOT,
        latestVersion: "1.2.0",
      },
      hostName: "build-host",
    });
    renderRegion(remedy, null);

    expect(screen.getByRole("status").textContent).toBe(remedy.sentence);
    // E09: removing the PowerShell/outside wording would make this visible
    // shell-guidance pin RED even if the copy payload remained unchanged.
    expect(screen.getByRole("status").textContent).toContain(
      "PowerShell window outside Traycer on that machine",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy commands" }));
    // E07: withholding Windows Desktop fallback commands would leave this
    // exact clipboard payload unavailable; this positive copy pin must RED.
    expect(clipboardWriteText).toHaveBeenCalledWith(
      "& 'C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe' cli upgrade\n& 'C:\\Users\\x\\AppData\\Local\\Traycer\\cli\\traycer.exe' host restart",
    );
    expect(requestInstallMock).not.toHaveBeenCalled();
  });

  it("downloads an available Desktop update and never installs directly", () => {
    const bridge = new FakeDesktopBridge(SNAPSHOT);
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
      const bridge = new FakeDesktopBridge(SNAPSHOT);
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
    const bridge = new FakeDesktopBridge(SNAPSHOT);
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
    const bridge = new FakeDesktopBridge(SNAPSHOT);
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
      const bridge = new FakeDesktopBridge(SNAPSHOT);
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

  it("checks a never-asked updater once, with automatic intent, and does not create an effect retry loop", async () => {
    // Main has never been asked: `idle` with no `lastCheckedAt`. That is
    // the ONE reason the mount check fires (`shouldCheckForUpdates`).
    const bridge = new FakeDesktopBridge({
      ...SNAPSHOT,
      status: "idle",
      latestVersion: null,
      lastCheckedAt: null,
      lastCheckIntent: null,
    });
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
    // AUTOMATIC, not manual: a manual check publishes "Checking…" then
    // "up to date" into the app-wide snapshot and pops toasts from a
    // settings pane; the mount check is the app's own intent, and only
    // the button below is the user's. Falsification: pass "manual" from
    // the hook and this pin goes RED.
    expect(bridge.checkForUpdates).toHaveBeenCalledWith("automatic");
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
    // Back to idle: a failed automatic check publishes nothing, so the
    // remedy returns to `idle` with `lastCheckedAt` still null and the
    // bridge handed to the hook again (the `checking` arm hands it null,
    // so that transition alone proves nothing about the ref). The
    // once-per-mount ref is what stops this from being a poller.
    // Falsification: drop `requested` from `useUpdateCheckOnBlockingMount`
    // and this commit reads the never-checked snapshot and dispatches a
    // second automatic check - the count below goes to 2.
    rendered.rerender(regionElement(remedy, bridge));
    await waitFor(() => expect(bridge.getSnapshot).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("decides from the bridge's own snapshot: an idle REMEDY over an updater main has already checked fires nothing on mount, and the button stays the manual route", async () => {
    // The rendered remedy is `idle` - exactly what the store's placeholder
    // reports on the first commit whatever main holds - while main's own
    // snapshot records a completed check. Deciding from the rendered
    // snapshot fired a check on every mount of this remedy; the guarded hook
    // reads the bridge instead. Falsification: decide from `checkOnMount`
    // alone (skip `bridge.getSnapshot()`) and the zero below goes RED.
    const bridge = new FakeDesktopBridge({
      ...SNAPSHOT,
      status: "idle",
      lastCheckedAt: "2026-09-06T00:00:00Z",
      lastCheckIntent: "automatic",
    });
    const remedy = describeCliFloorRemedy({
      isLocalMachine: true,
      platform: "darwin-arm64",
      cliSource: "desktop",
      cliBinaryPath: null,
      cliVersion: "1.2.0",
      requiredCliVersion: "1.3.0",
      desktopUpdate: { ...SNAPSHOT, status: "idle", lastCheckedAt: null },
      hostName: "build-host",
    });
    renderRegion(remedy, bridge);

    // The idle arm keeps a labelled button (the mount check publishes
    // nothing on a failed check, so `idle` can be what remains AFTER it).
    const button = await screen.findByRole("button", {
      name: "Check for updates",
    });
    // The negative is observed AFTER the hook consulted the bridge and its
    // read resolved, so a zero here is the hook's decision, not a race
    // with the effect.
    await waitFor(() => expect(bridge.getSnapshot).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(bridge.checkForUpdates).toHaveBeenCalledWith("manual");
  });
});
