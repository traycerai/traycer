// The bridge Doctor card (`host-doctor-card.tsx`), mounted directly rather
// than through the sheet's `source.kind === "bridge"` branch — this suite is
// about ONE unit's foreground-run guard, not the down-host scope apparatus
// around it.
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
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  FreePortAndRestartInput,
  FreePortAndRestartResult,
  HostDoctorIssue,
  HostDoctorReport,
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  HostRestartRequestResult,
  IHostLifecycleHost,
  IHostManagement,
  IRunnerHost,
  QueuedDoctorRepair,
  QueuedDoctorRepairResult,
} from "@traycer-clients/shared/platform/runner-host";
import { HostDoctorCard } from "@/components/settings/panels/host-doctor-card";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HOST_FOREGROUND_RESTART_REASON } from "@/lib/host/host-lifecycle-copy";

const RESTART_REASON = HOST_FOREGROUND_RESTART_REASON;

afterEach(() => {
  cleanup();
});

interface ManagementOverrides {
  readonly runDoctor?: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostDoctorReport>;
  readonly runDoctorRepairQueued?: (input: {
    readonly repair: QueuedDoctorRepair;
    readonly expectedHostId: string;
  }) => Promise<QueuedDoctorRepairResult>;
  readonly freePortAndRestart?: (
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ) => Promise<FreePortAndRestartResult>;
}

function makeManagement(overrides: ManagementOverrides): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented in mock`));
  return {
    getHostControllerStatus: vi.fn(notImplemented("getHostControllerStatus")),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(notImplemented("applyStaged")),
    activateInstalled: vi.fn(notImplemented("activateInstalled")),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn((): Promise<HostRestartRequestResult> =>
      Promise.resolve({ kind: "restarted" as const }),
    ),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor:
      overrides.runDoctor ??
      vi.fn(() => Promise.resolve<HostDoctorReport>({ issues: [], ranAt: "" })),
    availableVersions: vi.fn(notImplemented("availableVersions")),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(notImplemented("registerService")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(notImplemented("registryCheck")),
    freePortAndRestart:
      overrides.freePortAndRestart ??
      vi.fn((input) => Promise.resolve({ kind: "applied" as const, ...input })),
    runDoctorRepairQueued:
      overrides.runDoctorRepairQueued ??
      vi.fn(() => Promise.resolve({ kind: "applied" as const })),
    freePortAndRestartIfIdle: vi.fn((_input) =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "ok" as const, value: null },
      }),
    ),
    cliManifest: vi.fn(() => Promise.resolve(null)),
    maintenanceUpdateCheck: vi.fn(notImplemented("maintenanceUpdateCheck")),
    maintenanceDoctor: vi.fn(notImplemented("maintenanceDoctor")),
    maintenanceInstallationInfo: vi.fn(
      notImplemented("maintenanceInstallationInfo"),
    ),
    maintenanceInstallVersion: vi.fn(
      notImplemented("maintenanceInstallVersion"),
    ),
    restartHostIfIdle: vi.fn(notImplemented("restartHostIfIdle")),
    restartHostServiceIfHostIdle: vi.fn(
      notImplemented("restartHostServiceIfHostIdle"),
    ),
    runDoctorRepairIfIdle: vi.fn(notImplemented("runDoctorRepairIfIdle")),
    getHostName: vi.fn(() =>
      Promise.resolve({
        systemName: "test-host",
        customName: null,
        effectiveName: "test-host",
      }),
    ),
    setHostName: vi.fn((input: { readonly customName: string | null }) =>
      Promise.resolve({
        systemName: "test-host",
        customName: input.customName,
        effectiveName: input.customName ?? "test-host",
      }),
    ),
  };
}

function lifecycleView(
  admittedAs: HostLifecycleRunAdmission | null,
): HostLifecycleView {
  return {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: admittedAs === null ? "not-running" : "enforcing",
      admittedAs,
    },
    pending: "none",
  };
}

function buildLifecycleHost(initial: HostLifecycleView): IHostLifecycleHost {
  return {
    get: () => Promise.resolve(initial),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: initial,
      } satisfies HostLifecycleSetResult),
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
}

/**
 * `MockRunnerHost.hostLifecycle` is hardcoded `null` (it cannot express a
 * foreground run), and `hostManagement`/`hostLifecycle` are both read-only on
 * the class. `host-doctor-card.test.tsx`'s own `makeHostWithManagement`
 * already reaches past that with the same trick — override the fields on a
 * fresh object sharing the instance's prototype.
 */
function makeHostWithManagementAndLifecycle(
  management: IHostManagement,
  admittedAs: HostLifecycleRunAdmission | null,
): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostManagement: management,
    hostTray: null,
    hostLifecycle: buildLifecycleHost(lifecycleView(admittedAs)),
  });
}

/**
 * Same construction as {@link makeHostWithManagementAndLifecycle}, but with a
 * pushable `onChange` so a test can simulate a foreground run starting AFTER
 * mount, while a prompt opened at `admittedAs: null` is still on screen.
 */
function makeHostWithPushableLifecycle(management: IHostManagement): {
  readonly host: IRunnerHost;
  readonly pushLifecycleView: (view: HostLifecycleView) => void;
} {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  const changeHandlers: Array<(view: HostLifecycleView) => void> = [];
  const hostLifecycle: IHostLifecycleHost = {
    get: () => Promise.resolve(lifecycleView(null)),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view: lifecycleView(null),
      } satisfies HostLifecycleSetResult),
    onChange: (handler) => {
      changeHandlers.push(handler);
      return { dispose: () => undefined };
    },
    quit: null,
  };
  return {
    host: Object.assign(Object.create(proto) as IRunnerHost, host, {
      hostManagement: management,
      hostTray: null,
      hostLifecycle,
    }),
    pushLifecycleView: (view) => {
      for (const handler of changeHandlers) handler(view);
    },
  };
}

function renderCard(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostDoctorCard expectedHostId="local-host" />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function pendingUpgradeIssue(): HostDoctorIssue {
  return {
    code: "CLI_UPGRADE_PENDING",
    severity: "warning",
    title: "CLI upgrade pending (2.0.0)",
    message: "Restart the host service to finalise the swap.",
    fixAction: "host-restart",
    terminalCommand: "traycer host restart --channel prod",
    details: null,
  };
}

function freePortIssue(): HostDoctorIssue {
  return {
    code: "PORT_CONFLICT",
    severity: "error",
    title: "Host port held by another process",
    message: "Port 7300 is held by node (pid=4321), not the host (pid=1234).",
    fixAction: "host-free-port-and-restart",
    terminalCommand:
      "traycer host free-port-and-restart --pid 4321 --port 7300 --channel prod",
    details: { port: 7300, conflictingPid: 4321, conflictingProcess: "node" },
  };
}

function serviceNotRegisteredIssue(): HostDoctorIssue {
  return {
    code: "SERVICE_NOT_REGISTERED",
    severity: "warning",
    title: "Host service isn't registered",
    message: "The host has no OS service registration.",
    fixAction: "service-install",
    terminalCommand: "traycer host service register",
    details: null,
  };
}

function serviceRefreshIssue(): HostDoctorIssue {
  return {
    code: "SERVICE_DEFINITION_STALE",
    severity: "warning",
    title: "Host service definition is out of date",
    message: "The registered service points at an old install path.",
    fixAction: "service-refresh",
    terminalCommand: "traycer host service refresh",
    details: null,
  };
}

function isDisabled(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.disabled;
}

function describedReasonText(button: HTMLElement): string | null {
  const describedBy = button.getAttribute("aria-describedby");
  if (describedBy === null) return null;
  const reasonEl = document.getElementById(describedBy);
  return reasonEl?.textContent ?? null;
}

describe("the bridge Doctor card's restart fixes during a foreground run", () => {
  it("RED: a host-restart fix is disabled, reasoned, and dispatches nothing", async () => {
    const runDoctorRepairQueued = vi.fn(() =>
      Promise.resolve({ kind: "applied" as const }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [pendingUpgradeIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      runDoctorRepairQueued,
    });
    renderCard(makeHostWithManagementAndLifecycle(management, "foreground"));

    // Positive assertion via `waitFor` first: only true once the lifecycle
    // query has resolved, so it settles the render for what follows.
    await waitFor(() => {
      const button = screen.getByRole("button", { name: /Restart host/i });
      expect(isDisabled(button)).toBe(true);
    });
    const button = screen.getByRole("button", { name: /Restart host/i });
    expect(describedReasonText(button)).toBe(RESTART_REASON);

    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runDoctorRepairQueued).not.toHaveBeenCalled();
  });

  it("RED: a host-free-port-and-restart fix is disabled, reasoned, and dispatches nothing", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput & { readonly expectedHostId: string }) =>
        Promise.resolve({ kind: "applied" as const, ...input }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(makeHostWithManagementAndLifecycle(management, "foreground"));

    await waitFor(() => {
      const button = screen.getByRole("button", {
        name: /Free port \+ restart/i,
      });
      expect(isDisabled(button)).toBe(true);
    });
    const button = screen.getByRole("button", {
      name: /Free port \+ restart/i,
    });
    expect(describedReasonText(button)).toBe(RESTART_REASON);

    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(freePortAndRestart).not.toHaveBeenCalled();
  });

  it("GREEN control: Update service (service-refresh) stays enabled with no reason under foreground", async () => {
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [serviceRefreshIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
    });
    renderCard(makeHostWithManagementAndLifecycle(management, "foreground"));

    const button = await screen.findByRole("button", {
      name: /Update service/i,
    });
    expect(isDisabled(button)).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });

  it("GREEN control: admittedAs null — the restart fix is enabled", async () => {
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [pendingUpgradeIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
    });
    renderCard(makeHostWithManagementAndLifecycle(management, null));

    const button = await screen.findByRole("button", { name: /Restart host/i });
    expect(isDisabled(button)).toBe(false);
  });

  // "Register service" (fixAction
  // "service-install") joins the fixes withheld during a foreground run — see
  // this file's OWN "GREEN control: a non-restart fix stays enabled with no
  // reason" test above, which asserts the OPPOSITE for this exact issue and
  // will need updating once the fix lands (flagged in the report, not
  // touched here since only new red rows were asked for).
  it("RED: a service-install fix (Register service) is disabled, reasoned, and dispatches nothing", async () => {
    const runDoctorRepairQueued = vi.fn(() =>
      Promise.resolve({ kind: "applied" as const }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [serviceNotRegisteredIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      runDoctorRepairQueued,
    });
    renderCard(makeHostWithManagementAndLifecycle(management, "foreground"));

    await waitFor(() => {
      const button = screen.getByRole("button", { name: /Register service/i });
      expect(isDisabled(button)).toBe(true);
    });
    const button = screen.getByRole("button", { name: /Register service/i });
    expect(describedReasonText(button)).toBe(
      "A host you started in a terminal is running; stop it, then register the service.",
    );

    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runDoctorRepairQueued).not.toHaveBeenCalled();
  });

  it("GREEN control: admittedAs null — the service-install fix is enabled", async () => {
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [serviceNotRegisteredIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
    });
    renderCard(makeHostWithManagementAndLifecycle(management, null));

    const button = await screen.findByRole("button", {
      name: /Register service/i,
    });
    expect(isDisabled(button)).toBe(false);
    expect(describedReasonText(button)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The bridge Doctor card's "Free port and restart?" prompt
// (host-doctor-card.tsx's `freePortPrompt` ~229-231, rendered by
// `host-doctor-report-content.tsx` ~104 with `blockedReason={null}` today)
// must close its Confirm the moment a foreground run starts under it - same
// class as the restart-fixes tests above, but through the dialog's own `blockedReason` rather than by
// disabling the fix button before it is ever opened.
// ---------------------------------------------------------------------------

describe("the bridge Doctor card's free-port-and-restart prompt during a foreground run", () => {
  it("RED: Confirm is disabled with the restart reason and dispatches nothing once foreground starts under it", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput & { readonly expectedHostId: string }) =>
        Promise.resolve({ kind: "applied" as const, ...input }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    const { host, pushLifecycleView } =
      makeHostWithPushableLifecycle(management);
    renderCard(host);

    fireEvent.click(
      await screen.findByRole("button", { name: /Free port \+ restart/i }),
    );
    await screen.findByRole("dialog");

    act(() => {
      pushLifecycleView(lifecycleView("foreground"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-blocked-reason").textContent).toBe(
        RESTART_REASON,
      );
    });
    const confirm = screen.getByTestId("confirm-action") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(freePortAndRestart).not.toHaveBeenCalled();
  });

  it("GREEN control: without the push, confirming calls freePortAndRestart once", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput & { readonly expectedHostId: string }) =>
        Promise.resolve({ kind: "applied" as const, ...input }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    const { host } = makeHostWithPushableLifecycle(management);
    renderCard(host);

    fireEvent.click(
      await screen.findByRole("button", { name: /Free port \+ restart/i }),
    );
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() => {
      expect(freePortAndRestart).toHaveBeenCalledTimes(1);
    });
  });
});
