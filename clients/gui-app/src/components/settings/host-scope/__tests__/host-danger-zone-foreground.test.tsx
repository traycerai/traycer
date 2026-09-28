// The foreground-remove ruling: while THIS machine's host was started in a
// terminal (`applied.admittedAs === "foreground"`), "Remove Traycer"
// (`RemoveTraycerRow`, `host-danger-zone.tsx` ~:196-300) must not touch it -
// the same "this app leaves a terminal-started run alone" rule the update
// surfaces already carry, extended to uninstall. Nothing in the row reads the
// lifecycle view today, so every RED here is that gate simply not existing
// yet.
//
// `TraycerUninstallResult` is now `TraycerRemoved | HostMutationDeclined`:
// main resolves `{kind:"declined", message}` for a refusal (nothing is
// removed) rather than rejecting, so a declined uninstall is a NOTICE
// (`toastHostRepairDeclined`), not the error-toast path.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type {
  HostLifecyclePending,
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IHostManagement,
  LocalHostCapability,
  TraycerUninstallResult,
} from "@traycer-clients/shared/platform/runner-host";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { HostDangerZone } from "@/components/settings/host-scope/host-danger-zone";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const FOREGROUND_REMOVE_SENTENCE =
  "A host you started in a terminal is running; stop it, then remove Traycer.";

const MANAGED_IDLE = { capability: "managed", pending: "none" } as const;

function lifecycleView(
  admittedAs: HostLifecycleRunAdmission | null,
  applied: {
    readonly capability: LocalHostCapability;
    readonly pending: HostLifecyclePending;
  },
): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: applied.capability,
      supervisor: admittedAs === null ? "not-running" : "enforcing",
      admittedAs,
    },
    pending: applied.pending,
  };
}

function buildManagement(
  uninstallTraycer: () => Promise<TraycerUninstallResult>,
): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} must not run in this test`));
  return {
    getHostControllerStatus: notImplemented("getHostControllerStatus"),
    convergeReady: notImplemented("convergeReady"),
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
    applyStaged: notImplemented("applyStaged"),
    activateInstalled: notImplemented("activateInstalled"),
    installVersion: notImplemented("installVersion"),
    uninstallHost: notImplemented("uninstallHost"),
    restartHost: notImplemented("restartHost"),
    uninstallTraycer,
    clearRemoval: () => Promise.resolve(),
    getHostLogs: notImplemented("getHostLogs"),
    runDoctor: notImplemented("runDoctor"),
    availableVersions: notImplemented("availableVersions"),
    installedRecord: () => Promise.resolve(null),
    registerService: notImplemented("registerService"),
    deregisterService: notImplemented("deregisterService"),
    registryCheck: notImplemented("registryCheck"),
    freePortAndRestart: (input) =>
      Promise.resolve({ kind: "applied" as const, ...input }),
    runDoctorRepairQueued: () => Promise.resolve({ kind: "applied" as const }),
    freePortAndRestartIfIdle: () =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    cliManifest: () => Promise.resolve(null),
    maintenanceUpdateCheck: notImplemented("maintenanceUpdateCheck"),
    maintenanceDoctor: notImplemented("maintenanceDoctor"),
    maintenanceInstallationInfo: notImplemented("maintenanceInstallationInfo"),
    maintenanceInstallVersion: notImplemented("maintenanceInstallVersion"),
    restartHostIfIdle: notImplemented("restartHostIfIdle"),
    restartHostServiceIfHostIdle: notImplemented(
      "restartHostServiceIfHostIdle",
    ),
    runDoctorRepairIfIdle: notImplemented("runDoctorRepairIfIdle"),
    getHostName: () =>
      Promise.resolve({
        systemName: "studio-mac",
        customName: null,
        effectiveName: "Local Host",
      }),
    setHostName: (input) =>
      Promise.resolve({
        systemName: "studio-mac",
        customName: input.customName,
        effectiveName: input.customName ?? "Local Host",
      }),
  };
}

function renderDangerZone(options: {
  readonly admittedAs: HostLifecycleRunAdmission | null;
  readonly management: IHostManagement;
}): { readonly pushLifecycleView: (view: HostLifecycleView) => void } {
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const hostLifecycle: IHostLifecycleHost = {
    get: () => Promise.resolve(lifecycleView(options.admittedAs, MANAGED_IDLE)),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: lifecycleView(options.admittedAs, MANAGED_IDLE),
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  const runnerHost = createFakeRunnerHost({
    hostLifecycle,
    hostManagement: options.management,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostDangerZone
          scope={hostScopeFixture({
            host: hostScopeOptionFixture({
              hostId: "host-local",
              name: "Local Host",
              isLocalMachine: true,
            }),
            status: "ready",
            client: null,
          })}
        />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return {
    pushLifecycleView: (view) => {
      for (const handler of changeHandlers) handler(view);
    },
  };
}

function describedText(element: HTMLElement): string | null {
  const describedById = element.getAttribute("aria-describedby");
  if (describedById === null) return null;
  return document.getElementById(describedById)?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

describe("HostDangerZone - Remove Traycer during a foreground host run", () => {
  it("R-a RED: foreground disables Remove Traycer, names the reason, and dispatches nothing on click", async () => {
    const uninstallTraycer = vi.fn(() =>
      Promise.reject(new Error("must not run in this test")),
    );
    renderDangerZone({
      admittedAs: "foreground",
      management: buildManagement(uninstallTraycer),
    });

    const button = (await screen.findByTestId(
      "settings-remove-traycer",
    )) as HTMLButtonElement;
    // Native property, not jest-dom's `toBeDisabled()`: this repo has no
    // jest-dom matchers wired in (see `host-lifecycle-settings-section.test.tsx`).
    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });
    expect(describedText(button)).toBe(FOREGROUND_REMOVE_SENTENCE);

    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uninstallTraycer).not.toHaveBeenCalled();
  });

  it("R-b RED: a foreground push while the confirm is open disables Confirm with the reason", async () => {
    const uninstallTraycer = vi.fn(() =>
      Promise.reject(new Error("must not run in this test")),
    );
    const { pushLifecycleView } = renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    fireEvent.click(await screen.findByTestId("settings-remove-traycer"));
    await screen.findByRole("dialog");

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    const confirmAction = (await screen.findByTestId(
      "confirm-action",
    )) as HTMLButtonElement;
    await waitFor(() => {
      expect(confirmAction.disabled).toBe(true);
    });
    expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
      FOREGROUND_REMOVE_SENTENCE,
    );

    fireEvent.click(confirmAction);
    expect(uninstallTraycer).not.toHaveBeenCalled();
  });

  it("R-c RED: Try again is disabled during a foreground run once removal is incomplete", async () => {
    const uninstallTraycer = vi.fn(() =>
      Promise.resolve({
        kind: "removed",
        removedHost: true,
        deregisteredService: false,
        serviceRegistrationRetained: true,
        removedLoginItem: false,
      } satisfies TraycerUninstallResult),
    );
    const { pushLifecycleView } = renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    fireEvent.click(await screen.findByTestId("settings-remove-traycer"));
    fireEvent.click(await screen.findByTestId("confirm-action"));
    await waitFor(() => {
      expect(uninstallTraycer).toHaveBeenCalledOnce();
    });
    const retry = (await screen.findByTestId(
      "settings-retry-uninstall",
    )) as HTMLButtonElement;

    act(() => {
      pushLifecycleView(lifecycleView("foreground", MANAGED_IDLE));
    });

    await waitFor(() => {
      expect(retry.disabled).toBe(true);
    });
    expect(describedText(retry)).toBe(FOREGROUND_REMOVE_SENTENCE);
  });

  it("GREEN: admittedAs null - Remove Traycer is enabled, the confirm opens, and confirming removes it once", async () => {
    const uninstallTraycer = vi.fn(() =>
      Promise.resolve({
        kind: "removed",
        removedHost: true,
        deregisteredService: true,
        serviceRegistrationRetained: false,
        removedLoginItem: true,
      } satisfies TraycerUninstallResult),
    );
    renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    const button = (await screen.findByTestId(
      "settings-remove-traycer",
    )) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(uninstallTraycer).toHaveBeenCalledOnce();
    });
  });
});

describe("HostDangerZone - Remove Traycer's declined-uninstall notice", () => {
  it("RED: a foreground-refusal decline shows the notice, not an error toast, and stays on the same row", async () => {
    const FOREGROUND_REFUSAL_MESSAGE =
      "A host you started in a terminal is running, and Traycer leaves it alone. Stop it there to continue.";
    const uninstallTraycer = vi.fn(() =>
      Promise.resolve({
        kind: "declined",
        message: FOREGROUND_REFUSAL_MESSAGE,
      } satisfies TraycerUninstallResult),
    );
    renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    fireEvent.click(await screen.findByTestId("settings-remove-traycer"));
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(uninstallTraycer).toHaveBeenCalledOnce();
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Remove Traycer didn't run", {
      description: FOREGROUND_REFUSAL_MESSAGE,
    });
    expect(screen.queryByTestId("settings-quit-after-uninstall")).toBeNull();
    expect(screen.queryByTestId("settings-retry-uninstall")).toBeNull();
    expect(screen.getByTestId("settings-remove-traycer")).not.toBeNull();
  });

  it("RED: a lock-busy decline shows the notice, not an error toast, and stays on the same row", async () => {
    const LOCK_BUSY_MESSAGE = "Another Traycer process is managing the host.";
    const uninstallTraycer = vi.fn(() =>
      Promise.resolve({
        kind: "declined",
        message: LOCK_BUSY_MESSAGE,
      } satisfies TraycerUninstallResult),
    );
    renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    fireEvent.click(await screen.findByTestId("settings-remove-traycer"));
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(uninstallTraycer).toHaveBeenCalledOnce();
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Remove Traycer didn't run", {
      description: LOCK_BUSY_MESSAGE,
    });
    expect(screen.queryByTestId("settings-quit-after-uninstall")).toBeNull();
    expect(screen.queryByTestId("settings-retry-uninstall")).toBeNull();
    expect(screen.getByTestId("settings-remove-traycer")).not.toBeNull();
  });

  it("GREEN control: a genuine rejection still shows the error toast, not the declined notice", async () => {
    const uninstallTraycer = vi.fn(() => Promise.reject(new Error("boom")));
    renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    fireEvent.click(await screen.findByTestId("settings-remove-traycer"));
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(toast.info).not.toHaveBeenCalled();
    const [message, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(message).toBe("Couldn't remove Traycer's components.");
    expect(
      (options as { readonly description?: unknown } | undefined)?.description,
    ).toBe("boom");
  });

  it("GREEN control: a completed removal renders the removed surface", async () => {
    const uninstallTraycer = vi.fn(() =>
      Promise.resolve({
        kind: "removed",
        removedHost: true,
        deregisteredService: true,
        serviceRegistrationRetained: false,
        removedLoginItem: true,
      } satisfies TraycerUninstallResult),
    );
    renderDangerZone({
      admittedAs: null,
      management: buildManagement(uninstallTraycer),
    });

    fireEvent.click(await screen.findByTestId("settings-remove-traycer"));
    fireEvent.click(await screen.findByTestId("confirm-action"));

    await screen.findByTestId("settings-quit-after-uninstall");
    expect(screen.queryByTestId("settings-remove-traycer")).toBeNull();
  });
});
