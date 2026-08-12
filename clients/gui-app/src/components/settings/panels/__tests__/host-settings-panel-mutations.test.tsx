import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import type {
  ApplyStagedOk,
  ConvergeReadyOk,
  HostAvailableSnapshot,
  HostControllerStatus,
  HostInstalledRecord,
  HostRegistryUpdateState,
  IHostManagement,
  InstallVersionOk,
  IRunnerHost,
  LocalHostSnapshot,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));
const hostScopeMocks: {
  client: HostClient<HostRpcRegistry> | null;
  hostId: string;
  extra: Partial<HostScope>;
} = vi.hoisted(() => ({
  client: null,
  hostId: "host-a",
  extra: {},
}));

// Panels depend on the host SCOPE, not on the six hooks it composes, so this
// mocks at that boundary rather than re-mocking the scope's internals.
//
// The default scope here is THIS COMPUTER'S HOST, NOT DIALABLE — which is the
// recovery console's state, and this suite is the recovery console's suite.
// Every flow below (install, register a service, apply a staged build, pick a
// version, rename via the name file) runs over the local CLI bridge, and the
// bridge is what answers when the host process cannot. A reachable host, local
// or remote, now gets the RPC Overview instead; that page's flows are covered
// by the `host-overview-*` suites. Leaving this default `connectable` silently
// re-pointed most of these tests at a page that has none of these controls.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () =>
      hostScopeFixture({
        host: hostScopeOptionFixture({
          hostId: hostScopeMocks.hostId,
          isLocalMachine: true,
          connectable: false,
        }),
        status: "unreachable",
        client: hostScopeMocks.client,
        hostId: hostScopeMocks.hostId,
        ...hostScopeMocks.extra,
      }),
  };
});

afterEach(() => {
  cleanup();
  hostScopeMocks.client = null;
  hostScopeMocks.hostId = "host-a";
  hostScopeMocks.extra = {};
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

describe("<HostSettingsPanel /> - mutation flows", () => {
  // The page is now titled for whichever machine the sidebar has scoped, and
  // the local service console renders only when that machine is this device.
  // The old "This machine" heading existed to separate the local card from a
  // "My Hosts" list that ALSO contained the local machine; the duplication it
  // was disambiguating is gone, so the heading went with it.
  it("titles the page for the scoped machine and keeps the local service console", async () => {
    const { management } = makeManagement({});

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    expect(await screen.findByTestId("settings-host-identity")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This machine" })).toBeNull();
    // The machine is the subject of the page, so it must not also appear in
    // the "other machines" strip below it.
    expect(screen.queryByTestId("other-machines-row-host-a")).toBeNull();
  });

  it("opens a confirmation dialog before restarting the host", async () => {
    const restartHost = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const { management } = makeManagement({ restartHost });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    const restartButton = await waitForButton("Restart");
    fireEvent.click(restartButton);

    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain("in-progress agents");
    expect(restartHost).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(restartHost).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith("Host restart requested");
  });

  it("keeps the install console reachable on a fresh install with no hosts anywhere", async () => {
    // First run: no local host id yet, so the union has no row at all and the
    // scope resolves to NOTHING. The old branch rendered only the "No hosts
    // yet" notice — while the CLI bridge sat right here reporting
    // not-installed. Install must not hide behind a host list that can only
    // become non-empty by installing.
    hostScopeMocks.extra = {
      host: null,
      hosts: [],
      hostId: null,
      vanishedHostId: null,
      isLoading: false,
      listsFailed: false,
      status: "unreachable",
    };
    const { management } = makeManagement({
      installedRecord: vi.fn(() => Promise.resolve(null)),
    });
    renderPanel(makeHost(management, null));

    const install = await waitForButton("Install host");
    expect(install.getAttribute("data-variant")).toBe("default");
    expect(screen.queryByTestId("host-scope-empty")).toBeNull();
  });

  it("disarms an open restart confirmation when the scoped host changes", async () => {
    // The dialogs live outside the local-console conditional, so without the
    // scope-keyed remount a host switch left this confirmation mounted and
    // armed at the LOCAL bridge while the page described another machine —
    // confirming it restarted a host that was no longer the dialog's visible
    // subject.
    const restartHost = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const { management } = makeManagement({ restartHost });
    const host = makeHost(management, makeLocalHostSnapshot());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // Fresh elements per render: reusing one element tree lets React bail out
    // on referentially identical children, and the panel would never re-read
    // the changed scope.
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={host}>
          <HostSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>
    );
    const view = render(makeUi());

    fireEvent.click(await waitForButton("Restart"));
    expect(
      await screen.findByTestId("confirm-destructive-dialog"),
    ).toBeTruthy();

    hostScopeMocks.hostId = "host-b";
    view.rerender(makeUi());

    expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    expect(restartHost).not.toHaveBeenCalled();
  });

  // Field RCA 2026-07-28: a busy host denying the restart surfaced as a
  // reportable "Couldn't restart host" error toast, inviting "Report
  // issue" for a self-recovering condition. A declined result must render
  // as plain information - never as a success and never as an error.
  it("renders a declined restart as an informational toast, not success or a reportable error", async () => {
    const restartHost = vi.fn(() =>
      Promise.resolve({
        kind: "declined" as const,
        message: "The host has work in progress, so it was not restarted.",
      }),
    );
    const { management } = makeManagement({ restartHost });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    fireEvent.click(await waitForButton("Restart"));
    fireEvent.click(
      within(
        await screen.findByTestId("confirm-destructive-dialog"),
      ).getByTestId("confirm-action"),
    );

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("Host not restarted", {
        description: "The host has work in progress, so it was not restarted.",
      });
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("saves a custom host name from the Host settings page", async () => {
    const setHostName = vi.fn((input: { readonly customName: string | null }) =>
      Promise.resolve({
        systemName: "hardiks-macbook",
        customName: input.customName,
        effectiveName: input.customName ?? "hardiks-macbook",
      }),
    );
    const { management } = makeManagement({ setHostName });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    await openHostNameEdit();
    const input = await screen.findByRole("textbox", {
      name: "Display Name",
    });
    await waitFor(() => {
      if (input.hasAttribute("disabled")) {
        throw new Error("Host name input still disabled");
      }
    });
    fireEvent.change(input, { target: { value: "  Studio   Mac  " } });
    fireEvent.click(await waitForButton("Save"));

    await waitFor(() => {
      expect(setHostName).toHaveBeenCalledWith({
        customName: "Studio Mac",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Host name updated");
    // Successful save closes the inline edit form and restores focus.
    await waitFor(() => {
      expect(screen.queryByTestId("settings-host-name-edit")).toBeNull();
    });
    const editToggle = screen.getByTestId("settings-host-edit-name-toggle");
    expect(editToggle).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(editToggle);
    });
  });

  it("opens the name editor, discards a draft on Cancel, and reopens with the persisted name", async () => {
    const setHostName = vi.fn();
    const { management } = makeManagement({
      setHostName,
      getHostName: vi.fn(() =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: "Studio Mac",
          effectiveName: "Studio Mac",
        }),
      ),
    });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    await openHostNameEdit();
    const input = await screen.findByRole("textbox", {
      name: "Display Name",
    });
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("Studio Mac");
    });
    fireEvent.change(input, { target: { value: "Throwaway Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByTestId("settings-host-name-edit")).toBeNull();
    });
    expect(setHostName).not.toHaveBeenCalled();
    const editToggle = screen.getByTestId("settings-host-edit-name-toggle");
    await waitFor(() => {
      expect(document.activeElement).toBe(editToggle);
    });

    await openHostNameEdit();
    const reopened = await screen.findByRole("textbox", {
      name: "Display Name",
    });
    expect((reopened as HTMLInputElement).value).toBe("Studio Mac");
  });

  it("closes the name editor after a successful Reset", async () => {
    const setHostName = vi.fn((input: { readonly customName: string | null }) =>
      Promise.resolve({
        systemName: "hardiks-macbook",
        customName: input.customName,
        effectiveName: input.customName ?? "hardiks-macbook",
      }),
    );
    const { management } = makeManagement({
      setHostName,
      getHostName: vi.fn(() =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: "Studio Mac",
          effectiveName: "Studio Mac",
        }),
      ),
    });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    await openHostNameEdit();
    fireEvent.click(await waitForButton("Reset"));

    await waitFor(() => {
      expect(setHostName).toHaveBeenCalledWith({ customName: null });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("settings-host-name-edit")).toBeNull();
    });
    expect(toast.success).toHaveBeenCalledWith("Host name updated");
    const editToggle = screen.getByTestId("settings-host-edit-name-toggle");
    await waitFor(() => {
      expect(document.activeElement).toBe(editToggle);
    });
  });

  it("keeps status and meta visible when getHostName fails", async () => {
    const { management } = makeManagement({
      getHostName: vi.fn(() => Promise.reject(new Error("name failed"))),
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.4.2")),
      ),
    });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    await waitFor(() => {
      expect(screen.getByTestId("settings-host-status").textContent).toBe(
        "● Running",
      );
    });
    // Status/meta must not wait on the name query - assert them first.
    const identity = screen.getByTestId("settings-host-identity");
    expect(identity.textContent).toContain("v1.4.2");
    expect(identity.textContent).toContain("ws://127.0.0.1:42123");
    expect(identity.textContent).toContain("pid 12345");
    // Name degrades independently once getHostName settles to isError.
    expect(
      (await screen.findByTestId("settings-host-name-unavailable")).textContent,
    ).toBe("Host name unavailable");
    // No resolved settings -> Edit name stays disabled (can't open editor).
    expect(
      screen
        .getByTestId("settings-host-edit-name-toggle")
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables Cancel while Save is in flight and keeps the editor open on rejection", async () => {
    let rejectSet: (error: Error) => void = () => undefined;
    const setHostName = vi.fn(
      (_input: { readonly customName: string | null }) =>
        new Promise<never>((_resolve, reject) => {
          rejectSet = reject;
        }),
    );
    const { management } = makeManagement({ setHostName });

    renderPanel(makeHost(management, makeLocalHostSnapshot()));

    await openHostNameEdit();
    const input = await screen.findByRole("textbox", {
      name: "Display Name",
    });
    await waitFor(() => {
      if (input.hasAttribute("disabled")) {
        throw new Error("Host name input still disabled");
      }
    });
    fireEvent.change(input, { target: { value: "Retry Me" } });

    // Click Save without waitForButton - Save becomes disabled while pending.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setHostName).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByTestId("settings-host-name-edit")).toBeTruthy();

    act(() => {
      rejectSet(new Error("save failed"));
    });

    // Editor stays open with the draft so the user can retry.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.getByTestId("settings-host-name-edit")).toBeTruthy();
    const draftInput = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Display Name",
    });
    expect(draftInput).toBeInstanceOf(HTMLInputElement);
    expect(draftInput.value).toBe("Retry Me");
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("shows state-contextual summary actions for not-installed, stopped, and running", async () => {
    // not-installed: primary Install host, no Restart, update region hidden.
    {
      const { management } = makeManagement({
        installedRecord: vi.fn(() => Promise.resolve(null)),
      });
      renderPanel(makeHost(management, null));

      const install = await waitForButton("Install host");
      expect(install.getAttribute("data-variant")).toBe("default");
      expect(screen.getByRole("button", { name: "Run doctor" })).toBeTruthy();
      expect(screen.getByTestId("settings-host-edit-name-toggle")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Restart$/ })).toBeNull();
      await waitFor(() => {
        expect(screen.getByTestId("settings-host-status").textContent).toBe(
          "Not installed",
        );
      });
      // Update region is hidden entirely for not-installed (no Up to date / Check now / Retry bar).
      expect(screen.queryByText("Up to date")).toBeNull();
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.queryByTestId("settings-host-update-action")).toBeNull();
      cleanup();
    }

    // stopped: Restart is primary; update region is present.
    {
      const { management } = makeManagement({
        installedRecord: vi.fn(() =>
          Promise.resolve(makeInstalledRecord("1.4.2")),
        ),
        registryCheck: vi.fn(() =>
          Promise.resolve<HostRegistryUpdateState>({
            checkedAt: "2026-05-15T00:00:00Z",
            latestVersion: "1.4.2",
            installedVersion: "1.4.2",
            updateAvailable: false,
            reachable: true,
            errorMessage: null,
          }),
        ),
      });
      renderPanel(makeHost(management, null));

      const restart = await waitForButton("Restart");
      expect(restart.getAttribute("data-variant")).toBe("default");
      expect(screen.getByRole("button", { name: "Run doctor" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Install host" })).toBeNull();
      await waitFor(() => {
        expect(screen.getByTestId("settings-host-status").textContent).toBe(
          "○ Stopped",
        );
      });
      expect(await screen.findByText("Up to date")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
      cleanup();
    }

    // running: Restart is secondary; identity meta includes version / url / pid.
    {
      const { management } = makeManagement({
        installedRecord: vi.fn(() =>
          Promise.resolve(makeInstalledRecord("1.4.2")),
        ),
        registryCheck: vi.fn(() =>
          Promise.resolve<HostRegistryUpdateState>({
            checkedAt: "2026-05-15T00:00:00Z",
            latestVersion: "1.4.2",
            installedVersion: "1.4.2",
            updateAvailable: false,
            reachable: true,
            errorMessage: null,
          }),
        ),
      });
      renderPanel(makeHost(management, makeLocalHostSnapshot()));

      const restart = await waitForButton("Restart");
      expect(restart.getAttribute("data-variant")).toBe("secondary");
      expect(screen.getByRole("button", { name: "Run doctor" })).toBeTruthy();
      await waitFor(() => {
        expect(screen.getByTestId("settings-host-status").textContent).toBe(
          "● Running",
        );
      });
      const identity = await screen.findByTestId("settings-host-identity");
      expect(identity.textContent).toContain("v1.4.2");
      expect(identity.textContent).toContain("ws://127.0.0.1:42123");
      expect(identity.textContent).toContain("pid 12345");
      expect(screen.getByText("Up to date")).toBeTruthy();
      cleanup();
    }
  });

  it("keeps Installation disclosures collapsed by default and opens Advanced the same way", async () => {
    const { management } = makeManagement({
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.4.2")),
      ),
    });

    renderPanel(makeHost(management, null));

    expect(
      await screen.findByRole("heading", { name: "Installation" }),
    ).toBeTruthy();

    const detailsTrigger = await waitFor(() =>
      screen.getByRole("button", { name: /Installation details/i }),
    );
    const advancedTrigger = await waitFor(() =>
      screen.getByRole("button", { name: "Advanced" }),
    );
    expect(detailsTrigger.getAttribute("data-state")).toBe("closed");
    expect(advancedTrigger.getAttribute("data-state")).toBe("closed");

    await openAdvancedDisclosure();
    expect(
      screen
        .getByRole("button", { name: "Advanced" })
        .getAttribute("data-state"),
    ).toBe("open");
    await waitForButton("Re-register");
  });

  it("runs applyStaged and shows a success toast once a stage is updateReady", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "ok",
        value: { appliedVersion: "2.0.0", runningActivated: true },
      }),
    );
    const status: HostControllerStatus = {
      download: null,
      mutation: null,
      installedVersion: "1.4.2",
      latestVersion: "2.0.0",
      stagedVersion: "2.0.0",
      installedRuntimeVersion: null,
      runningRuntimeVersion: null,
      updateReady: true,
      activation: "activated",
      reachable: true,
      removedByUser: false,
      checkedAt: "2026-05-15T00:00:00Z",
    };
    const { management } = makeManagement({
      applyStaged,
      status,
      // Provide an installedRecord so the panel's status derives as
      // "stopped" (not "not-installed") - the Updates row is hidden when
      // no host is installed, since "Up to date" next to "Not installed"
      // is internally contradictory.
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.4.2")),
      ),
    });

    renderPanel(makeHost(management, null));

    const updateButton = await waitForButton("Update");
    fireEvent.click(updateButton);

    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", false);
    });
    expect(toast.success).toHaveBeenCalledWith("Updated host to v2.0.0");
  });

  it("surfaces the install progress banner when the shared mutation lane reports progress", async () => {
    // The panel no longer wires its own `onProgress` callback (Host Update
    // Layer Redesign) - progress is read from the shared canonical
    // `HostControllerStatus` query, which in production is pushed by
    // `HostControllerStatusListener`. Here we push it directly via
    // `queryClient.setQueryData`, the same mechanism the listener uses.
    let resolveConverge: (
      value: MutationOutcome<ConvergeReadyOk>,
    ) => void = () => undefined;
    const convergeReady = vi.fn(
      () =>
        new Promise<MutationOutcome<ConvergeReadyOk>>((resolve) => {
          resolveConverge = resolve;
        }),
    );
    // No installed record → status is "not-installed", so the Actions row
    // exposes "Install host".
    const { management } = makeManagement({
      convergeReady,
      installedRecord: vi.fn(() => Promise.resolve(null)),
    });

    const queryClient = renderPanel(makeHost(management, null));

    const installButton = await waitForButton("Install host");
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(convergeReady).toHaveBeenCalledTimes(1);
    });

    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          download: null,
          mutation: {
            kind: "ensure",
            progress: {
              stage: "download",
              percent: 42,
              bytes: 100,
              totalBytes: 240,
              message: "downloading",
            },
            startedAt: "2026-05-15T00:00:00Z",
          },
          installedVersion: null,
          latestVersion: null,
          stagedVersion: null,
          installedRuntimeVersion: null,
          runningRuntimeVersion: null,
          updateReady: false,
          activation: "unavailable",
          reachable: false,
          removedByUser: false,
          checkedAt: "2026-05-15T00:00:00Z",
        },
      );
    });

    const banner = await screen.findByTestId("settings-host-progress");
    expect(banner.textContent).toContain("Setting up host");
    expect(banner.textContent).toContain("download");
    expect(
      (await screen.findByTestId("settings-host-progress-percent")).textContent,
    ).toBe("42%");

    act(() => {
      queryClient.setQueryData<HostControllerStatus>(
        runnerQueryKeys.hostControllerStatus(management),
        {
          download: null,
          mutation: null,
          installedVersion: "1.4.2",
          latestVersion: null,
          stagedVersion: null,
          installedRuntimeVersion: null,
          runningRuntimeVersion: null,
          updateReady: false,
          activation: "activated",
          reachable: true,
          removedByUser: false,
          checkedAt: "2026-05-15T00:00:00Z",
        },
      );
    });
    resolveConverge({
      kind: "ok",
      value: { running: true, version: "1.4.2" },
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Installed host v1.4.2");
    });
  });

  it("no longer exposes Reinstall or Uninstall in the Advanced section", async () => {
    const { management } = makeManagement({
      installedRecord: vi.fn(() =>
        Promise.resolve(makeInstalledRecord("1.4.2")),
      ),
    });

    renderPanel(makeHost(management, null));

    await openAdvancedDisclosure();
    // The OS service controls still live under Advanced...
    await waitForButton("Re-register");
    // ...but the Installation section (Reinstall / Uninstall) is gone.
    expect(screen.queryByRole("button", { name: /^Reinstall$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Uninstall$/ })).toBeNull();
  });

  it("passes the include prereleases filter when the Advanced version picker checkbox is selected", async () => {
    const availableVersions = vi.fn(
      (_input: { readonly includePreReleases: boolean }) =>
        Promise.resolve(makeAvailableSnapshot()),
    );
    const { management } = makeManagement({ availableVersions });

    renderPanel(makeHost(management, null));

    await waitFor(() => {
      expect(availableVersions).toHaveBeenCalledWith({
        includePreReleases: false,
      });
    });
    await openAdvancedDisclosure();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /include release candidates/i,
      }),
    );

    await waitFor(() => {
      expect(availableVersions).toHaveBeenCalledWith({
        includePreReleases: true,
      });
    });
  });

  it("disables advanced pin install when the registry asset is unavailable", async () => {
    const installVersion = vi.fn(() =>
      Promise.resolve<MutationOutcome<InstallVersionOk>>({
        kind: "ok",
        value: { installedVersion: "1.4.2", runningActivated: true },
      }),
    );
    const availableVersions = vi.fn(() =>
      Promise.resolve(makeUnavailableAvailableSnapshot()),
    );
    const { management } = makeManagement({
      installVersion,
      availableVersions,
      registryCheck: vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: null,
          updateAvailable: false,
          reachable: true,
          errorMessage: null,
        }),
      ),
    });

    renderPanel(makeHost(management, null));

    await openAdvancedDisclosure();
    expect(
      await screen.findByText("Build unavailable for this platform."),
    ).toBeTruthy();
    const installButton = screen.getByRole("button", { name: "Install" });
    expect(installButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(installButton);
    expect(installVersion).not.toHaveBeenCalled();
  });

  it("uses the default advanced install reason for blank unavailable reasons", async () => {
    const availableVersions = vi.fn(() =>
      Promise.resolve(makeUnavailableAvailableSnapshotWithReason("   ")),
    );
    const { management } = makeManagement({
      availableVersions,
      registryCheck: vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: "2026-05-15T00:00:00Z",
          latestVersion: "1.4.2",
          installedVersion: null,
          updateAvailable: false,
          reachable: true,
          errorMessage: null,
        }),
      ),
    });

    renderPanel(makeHost(management, null));

    await openAdvancedDisclosure();
    expect(
      await screen.findByText("Unavailable on this platform."),
    ).toBeTruthy();
    const installButton = screen.getByRole("button", { name: "Install" });
    expect(installButton.hasAttribute("disabled")).toBe(true);
    expect(tooltipTextNear(installButton)).toBe(
      "Unavailable on this platform.",
    );
  });
});

async function openAdvancedDisclosure(): Promise<void> {
  const trigger = await waitFor(() =>
    screen.getByRole("button", { name: "Advanced" }),
  );
  if (trigger.getAttribute("data-state") !== "open") {
    fireEvent.click(trigger);
  }
}

async function openHostNameEdit(): Promise<void> {
  // "Edit name" is disabled until the host-name query resolves successfully.
  const toggle = await waitFor(() => {
    const button = screen.getByTestId("settings-host-edit-name-toggle");
    if (button.hasAttribute("disabled")) {
      throw new Error("Edit name button still disabled");
    }
    return button;
  });
  fireEvent.click(toggle);
  await screen.findByTestId("settings-host-name-edit");
}

async function waitForButton(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const button = screen.getByRole("button", {
      name: new RegExp(`^${escapeRegex(name)}$`),
    });
    if (button.hasAttribute("disabled")) {
      throw new Error(`${name} button still disabled`);
    }
    return button;
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ManagementOverrides {
  readonly status: HostControllerStatus | undefined;
  readonly convergeReady: Mock | undefined;
  readonly applyStaged: Mock | undefined;
  readonly activateInstalled: Mock | undefined;
  readonly installVersion: Mock | undefined;
  readonly uninstallHost: Mock | undefined;
  readonly restartHost: Mock | undefined;
  readonly registerService: Mock | undefined;
  readonly deregisterService: Mock | undefined;
  readonly registryCheck: Mock | undefined;
  readonly installedRecord: Mock | undefined;
  readonly availableVersions: Mock | undefined;
  readonly cliManifest: Mock | undefined;
  readonly getHostName: Mock | undefined;
  readonly setHostName: Mock | undefined;
}

interface ManagementResult {
  readonly management: IHostManagement;
}

const NOT_INSTALLED_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: null,
  latestVersion: null,
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "unavailable",
  reachable: false,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
};

function makeManagement(
  overrides: Partial<ManagementOverrides>,
): ManagementResult {
  const notImplemented =
    (method: string) =>
    (..._args: unknown[]): Promise<never> =>
      Promise.reject(new Error(`${method} not implemented in mock`));
  const status = overrides.status ?? NOT_INSTALLED_STATUS;
  const management: IHostManagement = {
    getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
    convergeReady:
      overrides.convergeReady ?? vi.fn(notImplemented("convergeReady")),
    applyStaged: overrides.applyStaged ?? vi.fn(notImplemented("applyStaged")),
    activateInstalled:
      overrides.activateInstalled ?? vi.fn(notImplemented("activateInstalled")),
    installVersion:
      overrides.installVersion ?? vi.fn(notImplemented("installVersion")),
    uninstallHost:
      overrides.uninstallHost ?? vi.fn(notImplemented("uninstallHost")),
    restartHost:
      overrides.restartHost ??
      vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() =>
      Promise.resolve({ issues: [], ranAt: "2026-05-15T00:00:00Z" }),
    ),
    availableVersions:
      overrides.availableVersions ??
      vi.fn(() => Promise.resolve(makeAvailableSnapshot())),
    installedRecord:
      overrides.installedRecord ?? vi.fn(() => Promise.resolve(null)),
    registerService:
      overrides.registerService ?? vi.fn(notImplemented("registerService")),
    deregisterService:
      overrides.deregisterService ?? vi.fn(() => Promise.resolve()),
    registryCheck:
      overrides.registryCheck ??
      vi.fn(() =>
        Promise.resolve<HostRegistryUpdateState>({
          checkedAt: null,
          latestVersion: null,
          installedVersion: null,
          updateAvailable: false,
          reachable: false,
          errorMessage: null,
        }),
      ),
    freePortAndRestart: vi.fn((input) => Promise.resolve(input)),
    cliManifest: overrides.cliManifest ?? vi.fn(() => Promise.resolve(null)),
    getHostName:
      overrides.getHostName ??
      vi.fn(() =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: null,
          effectiveName: "hardiks-macbook",
        }),
      ),
    setHostName:
      overrides.setHostName ??
      vi.fn((input: { readonly customName: string | null }) =>
        Promise.resolve({
          systemName: "hardiks-macbook",
          customName: input.customName,
          effectiveName: input.customName ?? "hardiks-macbook",
        }),
      ),
  };
  return { management };
}

function makeAvailableSnapshot(): HostAvailableSnapshot {
  return {
    generatedAt: "2026-05-15T00:00:00Z",
    latest: "1.4.2",
    platformKey: "darwin-arm64",
    manifestUrl: "",
    versions: [
      {
        version: "1.4.2",
        releasedAt: "2026-05-10T00:00:00Z",
        releaseNotesUrl: "",
        yanked: false,
        deprecationReason: null,
        platformAsset: {
          available: true,
          unavailableReason: null,
          url: "",
          sizeBytes: 1024,
          sha256: "",
          signatureUrl: "",
          publicKeyId: "",
        },
      },
    ],
  };
}

function makeUnavailableAvailableSnapshot(): HostAvailableSnapshot {
  return makeUnavailableAvailableSnapshotWithReason(
    "Build unavailable for this platform.",
  );
}

function makeUnavailableAvailableSnapshotWithReason(
  unavailableReason: string | null,
): HostAvailableSnapshot {
  const base = makeAvailableSnapshot();
  const entry = base.versions[0];
  return {
    ...base,
    versions: [
      {
        ...entry,
        platformAsset: {
          available: false,
          unavailableReason,
          url: "",
          sizeBytes: 1024,
          sha256: "",
          signatureUrl: "",
          publicKeyId: "",
        },
      },
    ],
  };
}

function makeInstalledRecord(version: string): HostInstalledRecord {
  return {
    version,
    installedAt: "2026-05-10T00:00:00Z",
    executablePath: `/tmp/traycer/${version}/host`,
    source: { kind: "registry", value: version },
    archiveSha256: "abc",
    signatureKeyId: "key",
    sizeBytes: 1024,
    signatureVerifiedAt: "2026-05-10T00:00:00Z",
    platform: "darwin",
    arch: "arm64",
  };
}

function makeHost(
  management: IHostManagement,
  localHost: LocalHostSnapshot | null,
): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostManagement: management,
    hostTray: null,
  });
}

function makeLocalHostSnapshot(): LocalHostSnapshot {
  return {
    hostId: "test-host",
    websocketUrl: "ws://127.0.0.1:42123",
    version: "1.4.2",
    pid: 12345,
    systemHostName: "hardiks-macbook",
    displayName: "hardiks-macbook",
    availability: "available",
  };
}

function renderPanel(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}
