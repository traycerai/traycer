// A contract patch: `IHostManagement.freePortAndRestart` now resolves
// `FreePortAndRestartResult = FreePortAndRestartApplied | HostMutationDeclined`
// — main resolves `declined` for a refusal and never rejects for one (an
// identity mismatch still rejects). Two renderer callers still assume every
// resolution is an apply: the bridge card's own `freePortMutation`
// (`host-doctor-card.tsx` ~:180-197) and `runFixAction`'s free-port arm
// (`host-doctor-actions.ts` ~:154-161). Both ignore `kind` entirely today.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  FreePortAndRestartInput,
  FreePortAndRestartResult,
  HostDoctorReport,
  HostLifecycleSetResult,
  HostLifecycleView,
  IHostLifecycleHost,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostDoctorCard } from "@/components/settings/panels/host-doctor-card";
import { runFixAction } from "@/components/settings/panels/host-doctor-actions";

// Exact wording, reused from the earlier deferred-refusal tests — the not-service-run
// text and the `none`-quiesce text, both plausible refusal reasons for a
// free-port-and-restart repair.
const FOREGROUND_REFUSAL_MESSAGE =
  "A host you started in a terminal is running, and Traycer leaves it alone. Stop it there to continue.";
const NONE_QUIESCE_MESSAGE =
  "This app no longer starts a local host. Restart Traycer to apply the host lifecycle setting.";

afterEach(() => {
  cleanup();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

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

interface ManagementOverrides {
  readonly runDoctor?: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostDoctorReport>;
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
    restartHost: vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
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
      vi.fn((input: FreePortAndRestartInput) =>
        Promise.resolve({ ...input, kind: "applied" as const }),
      ),
    runDoctorRepairQueued: vi.fn(() =>
      Promise.resolve({ kind: "applied" as const }),
    ),
    freePortAndRestartIfIdle: vi.fn(() =>
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

function lifecycleHost(): IHostLifecycleHost {
  const view: HostLifecycleView = {
    desired: { mode: "background", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: "not-running",
      admittedAs: null,
    },
    pending: "none",
  };
  return {
    get: () => Promise.resolve(view),
    set: () =>
      Promise.resolve({
        kind: "applied",
        view,
      } satisfies HostLifecycleSetResult),
    onChange: () => ({ dispose: () => undefined }),
    quit: null,
  };
}

function makeHostWithManagement(management: IHostManagement): IRunnerHost {
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
    hostLifecycle: lifecycleHost(),
  });
}

function renderCard(management: IHostManagement): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={makeHostWithManagement(management)}>
        <HostDoctorCard expectedHostId="local-host" />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

async function clickFreePortFixAndConfirm(): Promise<void> {
  const fixButton = await screen.findByRole("button", {
    name: /Free port \+ restart/i,
  });
  fireEvent.click(fixButton);
  const confirmButton = await screen.findByTestId("confirm-action");
  fireEvent.click(confirmButton);
}

describe("free-port `declined` — the bridge card's own freePortMutation", () => {
  it("RED: a declined refusal (foreground) shows a declined notice, not success or Fix failed", async () => {
    const freePortAndRestart = vi.fn((): Promise<FreePortAndRestartResult> =>
      Promise.resolve({
        kind: "declined" as const,
        message: FOREGROUND_REFUSAL_MESSAGE,
      }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(management);

    await clickFreePortFixAndConfirm();
    await waitFor(() => {
      expect(freePortAndRestart).toHaveBeenCalledTimes(1);
    });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Free port + restart didn't run", {
      description: FOREGROUND_REFUSAL_MESSAGE,
    });
  });

  it("RED: a declined refusal (none-quiesce) shows a declined notice, not success or Fix failed", async () => {
    const freePortAndRestart = vi.fn((): Promise<FreePortAndRestartResult> =>
      Promise.resolve({
        kind: "declined" as const,
        message: NONE_QUIESCE_MESSAGE,
      }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(management);

    await clickFreePortFixAndConfirm();
    await waitFor(() => {
      expect(freePortAndRestart).toHaveBeenCalledTimes(1);
    });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Free port + restart didn't run", {
      description: NONE_QUIESCE_MESSAGE,
    });
  });

  it("GREEN control: an applied result shows Restarted with port freed", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput): Promise<FreePortAndRestartResult> =>
        Promise.resolve({ ...input, kind: "applied" as const }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(management);

    await clickFreePortFixAndConfirm();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Restarted with port freed");
    });
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("GREEN control: a real rejection shows Couldn't free port with the error text", async () => {
    const freePortAndRestart = vi.fn((): Promise<FreePortAndRestartResult> =>
      Promise.reject(new Error("boom")),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [freePortIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(management);

    await clickFreePortFixAndConfirm();
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    const [message, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(message).toBe("Couldn't free port");
    expect(options?.description).toBe("boom");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });
});

describe("free-port `declined` — runFixAction's free-port arm, called directly", () => {
  it("RED: a declined refusal is reported as declined, not applied", async () => {
    const management = makeManagement({
      freePortAndRestart: () =>
        Promise.resolve({
          kind: "declined" as const,
          message: FOREGROUND_REFUSAL_MESSAGE,
        }),
    });

    const result = await runFixAction(
      management,
      freePortIssue(),
      "local-host",
    );

    expect(result).toEqual({
      kind: "declined",
      message: FOREGROUND_REFUSAL_MESSAGE,
    });
  });

  it("GREEN control: an applied result is reported as applied", async () => {
    const management = makeManagement({
      freePortAndRestart: (input) =>
        Promise.resolve({ ...input, kind: "applied" as const }),
    });

    const result = await runFixAction(
      management,
      freePortIssue(),
      "local-host",
    );

    expect(result).toEqual({ kind: "applied" });
  });
});
