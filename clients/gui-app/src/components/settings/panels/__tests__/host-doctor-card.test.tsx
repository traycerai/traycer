import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { HostDoctorCard } from "@/components/settings/panels/host-doctor-card";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type {
  HostDoctorIssue,
  HostDoctorReport,
  HostRestartRequestResult,
  QueuedDoctorRepair,
  QueuedDoctorRepairResult,
  FreePortAndRestartInput,
  IHostManagement,
  IRunnerHost,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";

const HOST_CHANGED_MESSAGE =
  "This computer's host changed while that was open. Reopen Settings and try again.";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

interface ManagementOverrides {
  readonly runDoctor?: (input: {
    readonly expectedHostId: string;
  }) => Promise<HostDoctorReport>;
  readonly restartHost?: () => Promise<HostRestartRequestResult>;
  readonly runDoctorRepairQueued?: (input: {
    readonly repair: QueuedDoctorRepair;
    readonly expectedHostId: string;
  }) => Promise<QueuedDoctorRepairResult>;
  readonly freePortAndRestart?: (
    input: FreePortAndRestartInput & { readonly expectedHostId: string },
  ) => Promise<FreePortAndRestartInput>;
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
    restartHost:
      overrides.restartHost ??
      vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
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
      overrides.freePortAndRestart ?? vi.fn((input) => Promise.resolve(input)),
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
  });
}

function pendingUpgradeIssue(): HostDoctorIssue {
  return {
    code: "CLI_UPGRADE_PENDING",
    severity: "warning",
    title: "CLI upgrade pending (2.0.0)",
    message:
      "cli upgrade staged 2.0.0 at /tmp/traycer-2.0.0; live binary is locked. Restart the host service to finalise the swap.",
    fixAction: "host-restart",
    terminalCommand: "traycer host restart --channel prod",
    details: {
      stagedVersion: "2.0.0",
      stagedBinaryPath: "/tmp/traycer-2.0.0",
      stagedAt: "2026-05-15T00:00:00Z",
      reason: "binary-locked",
      currentVersion: "1.9.0",
      binaryPath: "/usr/local/bin/traycer",
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

describe("HostDoctorCard pending CLI upgrade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the CLI_UPGRADE_PENDING issue with Restart host guidance", async () => {
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [pendingUpgradeIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
    });
    renderCard(makeHostWithManagement(management));

    expect(await screen.findByText(/CLI upgrade pending/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart host/i })).toBeTruthy();
  });

  it("opens the Free Port + Restart confirmation when PORT_CONFLICT carries process identity", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput & { readonly expectedHostId: string }) =>
        Promise.resolve(input),
    );
    const issue: HostDoctorIssue = {
      code: "PORT_CONFLICT",
      severity: "error",
      title: "Host port held by another process",
      message:
        "Port 7300 (ws://127.0.0.1:7300) is held by node (pid=4321), not the host (pid=1234).",
      fixAction: "host-free-port-and-restart",
      terminalCommand:
        "traycer host free-port-and-restart --pid 4321 --port 7300 --channel prod",
      details: {
        pid: 1234,
        websocketUrl: "ws://127.0.0.1:7300",
        port: 7300,
        conflictingPid: 4321,
        conflictingProcess: "node",
      },
    };
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [issue],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(makeHostWithManagement(management));

    const fixButton = await screen.findByRole("button", {
      name: /Free port \+ restart/i,
    });
    fireEvent.click(fixButton);
    // The confirmation dialog renders the conflicting PID + process name.
    // Radix dialogs portal into document.body; `findByRole("dialog")`
    // matches the open dialog regardless of its DOM location.
    await screen.findByRole("dialog");
    const dialogTitle = await screen.findByText(/Free port and restart\?/i);
    expect(dialogTitle).toBeTruthy();
    // node/4321 may appear in both the issue summary and the dialog
    // description; assert via `getAllByText` so we don't trip on the
    // duplicate.
    expect(screen.getAllByText(/node/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/4321/).length).toBeGreaterThan(0);
    // Confirm. Radix marks the rest of the document aria-hidden when
    // the dialog opens, so role queries return only the dialog's
    // footer buttons. Find by destructive variant - the one styled red.
    const confirmButton = await screen.findByRole("button", {
      name: /Free port \+ restart/i,
    });
    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(freePortAndRestart).toHaveBeenCalledTimes(1);
    });
    // The recovery console keeps the QUEUEING route (it repairs a host that is
    // already down) but still carries the identity fence: the port and pid it
    // is about to act on describe the machine as this report saw it.
    expect(freePortAndRestart).toHaveBeenCalledWith({
      port: 7300,
      pid: 4321,
      processName: "node",
      expectedHostId: "local-host",
    });
    expect(management.freePortAndRestartIfIdle).not.toHaveBeenCalled();
  });

  it("allows Free Port + Restart when PID and process name are unknown", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput & { readonly expectedHostId: string }) =>
        Promise.resolve(input),
    );
    const issue: HostDoctorIssue = {
      code: "PORT_CONFLICT",
      severity: "error",
      title: "Host port held by another process",
      message: "Port 7300 is held by an unknown process.",
      fixAction: "host-free-port-and-restart",
      terminalCommand:
        "traycer host free-port-and-restart --port 7300 --channel prod",
      details: {
        port: 7300,
        conflictingPid: null,
        conflictingProcess: null,
      },
    };
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [issue],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
    });
    renderCard(makeHostWithManagement(management));

    const fixButton = await screen.findByRole("button", {
      name: /Free port \+ restart/i,
    });
    fireEvent.click(fixButton);
    await screen.findByRole("dialog");
    const confirmButton = await screen.findByRole("button", {
      name: /Free port \+ restart/i,
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(freePortAndRestart).toHaveBeenCalledTimes(1);
    });
    expect(freePortAndRestart).toHaveBeenCalledWith({
      port: 7300,
      pid: null,
      processName: null,
      expectedHostId: "local-host",
    });
    expect(management.freePortAndRestartIfIdle).not.toHaveBeenCalled();
  });

  it("never presents Free Port + Restart with port 0", async () => {
    const freePortAndRestart = vi.fn(
      (input: FreePortAndRestartInput & { readonly expectedHostId: string }) =>
        Promise.resolve(input),
    );
    const restartHost = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    // A defective Doctor record that *claims* it can free a port but
    // has no port/PID. The card must NOT pop the kill dialog.
    const issue: HostDoctorIssue = {
      code: "PORT_CONFLICT",
      severity: "error",
      title: "Host endpoint unreachable",
      message: "endpoint unreachable; unsafe to kill",
      fixAction: "host-free-port-and-restart",
      terminalCommand: "traycer host restart --channel prod",
      details: {
        port: 0,
        conflictingPid: null,
        conflictingProcess: null,
      },
    };
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [issue],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      freePortAndRestart,
      restartHost,
    });
    renderCard(makeHostWithManagement(management));

    const button = await screen.findByRole("button", {
      name: /Free port \+ restart/i,
    });
    fireEvent.click(button);
    // No dialog should appear.
    expect(screen.queryByText(/Free port and restart\?/i)).toBeNull();
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(restartHost).not.toHaveBeenCalled();
    expect(freePortAndRestart).not.toHaveBeenCalled();
  });

  it("renders PORT_UNREACHABLE with Restart host guidance (no Free Port button)", async () => {
    const issue: HostDoctorIssue = {
      code: "PORT_UNREACHABLE",
      severity: "error",
      title: "Host endpoint unreachable",
      message:
        "Host is running but its endpoint did not accept a TCP connection.",
      fixAction: "host-restart",
      terminalCommand: "traycer host restart --channel prod",
      details: {
        pid: 1234,
        websocketUrl: "ws://127.0.0.1:7300",
        port: 7300,
        conflictingPid: null,
        conflictingProcess: null,
      },
    };
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [issue],
          ranAt: "2026-05-15T00:00:00Z",
        }),
    });
    renderCard(makeHostWithManagement(management));
    expect(await screen.findByText(/Host endpoint unreachable/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Free port \+ restart/i }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Restart host/i })).toBeTruthy();
  });

  it("routes the restart fix through the identity-fenced queued repair, not the unfenced restartHost", async () => {
    const restartHost = vi.fn(() =>
      Promise.resolve({ kind: "restarted" as const }),
    );
    const runDoctorRepairQueued = vi.fn(() =>
      Promise.resolve({ kind: "applied" as const }),
    );
    const management = makeManagement({
      runDoctor: () =>
        Promise.resolve<HostDoctorReport>({
          issues: [pendingUpgradeIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      restartHost,
      runDoctorRepairQueued,
    });
    renderCard(makeHostWithManagement(management));

    const button = await screen.findByRole("button", {
      name: /Restart host/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(runDoctorRepairQueued).toHaveBeenCalledWith({
        repair: "restart",
        expectedHostId: "local-host",
      });
    });
    // The console keeps QUEUEING semantics, but it may no longer reach the
    // app-wide method that carries no host id: this console can outlive the
    // host it opened on, and that call would kill whichever host is here now.
    expect(restartHost).not.toHaveBeenCalled();
  });

  it("renders an error arm when the report read fails, not no issues detected", async () => {
    const management = makeManagement({
      runDoctor: () => Promise.reject(new Error(HOST_CHANGED_MESSAGE)),
    });
    renderCard(makeHostWithManagement(management));

    expect(
      await screen.findByText(`Doctor could not run: ${HOST_CHANGED_MESSAGE}`),
    ).toBeTruthy();
    expect(screen.queryByText("Doctor: no issues detected.")).toBeNull();
  });

  it("hostDoctor query keys discriminate two host ids even when the bridge hashes to {}", () => {
    const management = {};
    expect(
      JSON.stringify(runnerQueryKeys.hostDoctor(management, "host-a")),
    ).not.toBe(
      JSON.stringify(runnerQueryKeys.hostDoctor(management, "host-b")),
    );
  });

  it("Re-run Doctor on the error arm refetches, swapping the arm for the spinner", async () => {
    // Held in an object rather than a `let`: TS narrows a captured `let` to
    // `null` at the call site because it cannot prove the executor ran, and
    // the `?.()` that placates it then types as `never`.
    const second: { release: () => void } = { release: () => undefined };
    const secondGate = new Promise<void>((resolve) => {
      second.release = resolve;
    });
    let calls = 0;
    const runDoctor = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(HOST_CHANGED_MESSAGE);
      }
      await secondGate;
      return {
        issues: [] as const,
        ranAt: "2026-08-12T00:00:00Z",
      };
    });
    const management = makeManagement({ runDoctor });
    renderCard(makeHostWithManagement(management));

    expect(
      await screen.findByText(`Doctor could not run: ${HOST_CHANGED_MESSAGE}`),
    ).toBeTruthy();
    const idleRerun = screen.getByTestId("host-doctor-rerun");
    if (!(idleRerun instanceof HTMLButtonElement)) {
      throw new Error("expected rerun button");
    }

    fireEvent.click(idleRerun);
    await waitFor(() => {
      expect(runDoctor).toHaveBeenCalledTimes(2);
    });
    expect(runDoctor).toHaveBeenLastCalledWith({
      expectedHostId: "local-host",
    });
    // The refetch clears the error, and with no data behind it the query
    // returns to `pending` — so the error arm and its button are GONE and the
    // shared spinner owns the in-flight state. Pinned as an equality, not a
    // tolerance: it is the reason the button carries no `disabled` prop, and
    // if a later change keeps the arm mounted that prop has to come back.
    expect(screen.queryByTestId("host-doctor-rerun")).toBeNull();
    expect(screen.queryByText(/Doctor could not run:/)).toBeNull();
    expect(screen.getByText("Running Doctor…")).toBeTruthy();

    second.release();
    expect(await screen.findByText("Doctor: no issues detected.")).toBeTruthy();
    expect(screen.queryByText(/Doctor could not run:/)).toBeNull();
  });
});
