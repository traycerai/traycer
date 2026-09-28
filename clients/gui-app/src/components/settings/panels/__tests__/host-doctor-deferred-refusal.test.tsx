// A Doctor refusal that resolves `deferred` is a declined
// notice, exactly like `lane-busy` / `host-changed` — not a "Fix failed"
// error. Route 1 is the WATCHED RPC Doctor sheet's if-idle dispatch
// (`useLocalDoctorFixMutation`, `host-settings-panel.tsx`), which today
// throws on ANY non-"ok" outcome, including `deferred`. Route 2 is the
// bridge Doctor card's QUEUED dispatch, where main already resolves every
// queued `deferred` as `{kind: "declined", message}` — so route 2's rows are
// confirmation, not new red.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
    readonly getLocalEntry: () => null;
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
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
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  DoctorRepairDispatch,
  FreePortAndRestartInput,
  HostDoctorReport as BridgeHostDoctorReport,
  HostLifecycleRunAdmission,
  HostLifecycleSetResult,
  HostLifecycleView,
  HostRestartRequestResult,
  IHostLifecycleHost,
  IHostManagement,
  IRunnerHost,
  QueuedDoctorRepairResult,
} from "@traycer-clients/shared/platform/runner-host";
import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import type { HostRpcRegistry } from "@/lib/host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { HostDoctorCard } from "@/components/settings/panels/host-doctor-card";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  openHostOverviewMenu,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";

const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

// Exact wording reused by the Install-fix and Free-port-fix declined-notice tests below.
const NONE_QUIESCE_MESSAGE =
  "This app no longer starts a local host. Restart Traycer to apply the host lifecycle setting.";

// The confirmed not-service-run text — named so it can be swapped in
// one place if that wording changes again.
const FOREGROUND_NOT_SERVICE_RUN_MESSAGE =
  "A host you started in a terminal is running, and Traycer leaves it alone. Stop it there to continue.";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  // The `sonner` mock is one module-level object, so its `toast.*` spies
  // accumulate calls across tests unless cleared here — otherwise a later
  // test's assertion on "was this called" silently inherits an earlier
  // test's calls.
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  vi.mocked(toast.message).mockClear();
});

// ---------------------------------------------------------------------------
// Route 1 — the WATCHED RPC Doctor sheet (`HostSettingsPanel`).
// ---------------------------------------------------------------------------

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

function bindingWith(hostClient: unknown): HostBindingMock {
  return {
    hostClient,
    directory: {
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
      getLocalEntry: () => null,
    },
  };
}

function renderPanel(options: {
  readonly hostId: string;
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly management: IHostManagement;
}): { readonly fixture: OverviewHostFixture } {
  const fixture = buildOverviewHostFixture({
    hostId: options.hostId,
    isLocalMachine: true,
    overrideHandlers: options.overrideHandlers,
  });
  recordNegotiatedHostMethods(options.hostId, [...OVERVIEW_METHODS]);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: options.hostId,
      isLocalMachine: true,
      connectable: true,
    }),
    hostId: options.hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = bindingWith(fixture.client);
  const lifecycle = buildLifecycleHost(lifecycleView(null));
  const runnerHost = createFakeRunnerHost({
    hostLifecycle: lifecycle,
    hostManagement: options.management,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { fixture };
}

async function openDoctorSheet(): Promise<void> {
  await openHostOverviewMenu();
  fireEvent.click(screen.getByTestId("host-overview-run-doctor"));
}

function hostInstallLatestIssue(): HostDoctorIssue {
  return {
    code: "HOST_NOT_INSTALLED",
    severity: "error",
    title: "No usable host is installed",
    message: "Install a host to continue.",
    fixAction: "host-install-latest",
    terminalCommand: "traycer host install",
    details: null,
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

async function clickFixAndSettle(code: string): Promise<HTMLButtonElement> {
  const button = (await screen.findByTestId(
    `host-doctor-fix-${code}`,
  )) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => {
    const settled = screen.getByTestId(
      `host-doctor-fix-${code}`,
    ) as HTMLButtonElement;
    expect(settled.disabled).toBe(false);
  });
  return screen.getByTestId(`host-doctor-fix-${code}`) as HTMLButtonElement;
}

describe("the deferred-refusal route 1 — the watched RPC Doctor sheet's if-idle dispatch", () => {
  it("RED: an Install host fix that resolves deferred shows a declined notice, not Fix failed", async () => {
    const runDoctorRepairIfIdle = vi.fn((): Promise<DoctorRepairDispatch> =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "deferred" as const, message: NONE_QUIESCE_MESSAGE },
      }),
    );
    const management = buildOverviewManagement({ runDoctorRepairIfIdle });
    renderPanel({
      hostId: "host-local",
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [hostInstallLatestIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();
    await clickFixAndSettle(hostInstallLatestIssue().code);

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Install host didn't run", {
      description: NONE_QUIESCE_MESSAGE,
    });
  });

  it("RED: a Register service fix that resolves deferred shows a declined notice, not Fix failed", async () => {
    const runDoctorRepairIfIdle = vi.fn((): Promise<DoctorRepairDispatch> =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: {
          kind: "deferred" as const,
          message: FOREGROUND_NOT_SERVICE_RUN_MESSAGE,
        },
      }),
    );
    const management = buildOverviewManagement({ runDoctorRepairIfIdle });
    renderPanel({
      hostId: "host-local",
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [serviceNotRegisteredIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();
    await clickFixAndSettle(serviceNotRegisteredIssue().code);

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Register service didn't run", {
      description: FOREGROUND_NOT_SERVICE_RUN_MESSAGE,
    });
  });

  it("RED: a Free port + restart fix that resolves deferred shows a declined notice, not Fix failed", async () => {
    const freePortAndRestartIfIdle = vi.fn((): Promise<DoctorRepairDispatch> =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "deferred" as const, message: NONE_QUIESCE_MESSAGE },
      }),
    );
    const management = buildOverviewManagement({ freePortAndRestartIfIdle });
    renderPanel({
      hostId: "host-local",
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [freePortIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();
    // Free port + restart confirms before it dispatches
    // (`host-doctor-rpc-card.tsx:353-357,420-430`) — the fix button only
    // opens the "Free port and restart?" dialog; `confirm-action` is what
    // actually calls `freePortAndRestartIfIdle`.
    fireEvent.click(
      await screen.findByTestId(`host-doctor-fix-${freePortIssue().code}`),
    );
    fireEvent.click(await screen.findByTestId("confirm-action"));
    await waitFor(() => {
      expect(freePortAndRestartIfIdle).toHaveBeenCalledTimes(1);
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Free port + restart didn't run", {
      description: NONE_QUIESCE_MESSAGE,
    });
  });

  it("GREEN control: a real failure still shows Fix failed", async () => {
    const runDoctorRepairIfIdle = vi.fn((): Promise<DoctorRepairDispatch> =>
      Promise.resolve({
        kind: "dispatched" as const,
        outcome: { kind: "failed" as const, message: "boom" },
      }),
    );
    const management = buildOverviewManagement({ runDoctorRepairIfIdle });
    renderPanel({
      hostId: "host-local",
      management,
      overrideHandlers: {
        "host.doctor": () => ({
          status: "ok" as const,
          issues: [hostInstallLatestIssue()],
          triviallyGreenIssueCodes: [],
        }),
      },
    });
    await openDoctorSheet();
    await clickFixAndSettle(hostInstallLatestIssue().code);

    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    const [message] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(message).toBe("Fix failed");
  });
});

// ---------------------------------------------------------------------------
// Route 2 — the bridge Doctor card's queued dispatch (`HostDoctorCard`).
// Main already resolves a queued `deferred` as `{kind: "declined", message}`,
// so these confirm the existing shape rather than pinning new red.
// ---------------------------------------------------------------------------

interface BridgeManagementOverrides {
  readonly runDoctor?: (input: {
    readonly expectedHostId: string;
  }) => Promise<BridgeHostDoctorReport>;
  readonly runDoctorRepairQueued?: () => Promise<QueuedDoctorRepairResult>;
}

function makeBridgeManagement(
  overrides: BridgeManagementOverrides,
): IHostManagement {
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
      vi.fn(() =>
        Promise.resolve<BridgeHostDoctorReport>({ issues: [], ranAt: "" }),
      ),
    availableVersions: vi.fn(notImplemented("availableVersions")),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(notImplemented("registerService")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(notImplemented("registryCheck")),
    freePortAndRestart: vi.fn((input: FreePortAndRestartInput) =>
      Promise.resolve({ kind: "applied" as const, ...input }),
    ),
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

function bridgeLifecycleHost(): IHostLifecycleHost {
  const view = lifecycleView(null);
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

function makeBridgeHostWithManagement(
  management: IHostManagement,
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
    hostLifecycle: bridgeLifecycleHost(),
  });
}

function renderBridgeCard(management: IHostManagement): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={makeBridgeHostWithManagement(management)}>
        <HostDoctorCard expectedHostId="local-host" />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

/**
 * Clicks the fix button and waits for the mutation to settle, read off the
 * mock's own call count rather than the button re-enabling — a rejection
 * that reaches the lock threshold turns the button natively `disabled`
 * (`disabled:pointer-events-none`, a real HTML `disabled` attribute per
 * `button.tsx`), so it goes straight from "pending" to disabled and never
 * back through an enabled frame.
 */
async function clickBridgeFixAndAwaitCall(
  name: RegExp,
  mock: Mock<(...args: never[]) => unknown>,
  expectedCalls: number,
): Promise<void> {
  const button = await screen.findByRole("button", { name });
  fireEvent.click(button);
  await waitFor(() => {
    expect(mock).toHaveBeenCalledTimes(expectedCalls);
  });
}

describe("the deferred-refusal route 2 — the bridge Doctor card's queued dispatch", () => {
  it("SETTLING (expected GREEN): three declined answers never lock the card, and the fourth still queues", async () => {
    const runDoctorRepairQueued = vi.fn((): Promise<QueuedDoctorRepairResult> =>
      Promise.resolve({
        kind: "declined" as const,
        message: FOREGROUND_NOT_SERVICE_RUN_MESSAGE,
      }),
    );
    const management = makeBridgeManagement({
      runDoctor: () =>
        Promise.resolve<BridgeHostDoctorReport>({
          issues: [serviceNotRegisteredIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      runDoctorRepairQueued,
    });
    renderBridgeCard(management);

    for (let i = 1; i <= 3; i += 1) {
      await clickBridgeFixAndAwaitCall(
        /Register service/i,
        runDoctorRepairQueued,
        i,
      );
    }
    expect(
      vi
        .mocked(toast.info)
        .mock.calls.filter((call) => call[0] === "Register service didn't run"),
    ).toHaveLength(3);
    expect(
      vi
        .mocked(toast.error)
        .mock.calls.some(
          (call) =>
            typeof call[0] === "string" && call[0].includes("Doctor paused"),
        ),
    ).toBe(false);
    const button = await screen.findByRole("button", {
      name: /Register service/i,
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    await clickBridgeFixAndAwaitCall(
      /Register service/i,
      runDoctorRepairQueued,
      4,
    );
    expect(
      vi
        .mocked(toast.error)
        .mock.calls.some(
          (call) =>
            typeof call[0] === "string" && call[0].includes("Doctor paused"),
        ),
    ).toBe(false);
  });

  // Only the lock half is exercised through the real panel. The paused
  // toast's OWN branch in `handleFix` (host-doctor-card.tsx:216-227) is
  // behind a native HTML `disabled` on the same button once
  // `recurrenceLocked` is true (`host-doctor-issue-card.tsx:69-73`,
  // `disabled:pointer-events-none` in `button.tsx`), and `fireEvent.click` on
  // a genuinely disabled control never reaches its `onClick` — confirmed
  // against a bare disabled `<button>` in this harness before writing this
  // test. A fourth real click therefore cannot reach that branch without
  // hand-mocking the recurrence state around the lock, so this pins the lock
  // alone; the branch and the disabled button both predate this suite.
  it("CONTROL: three rejections do lock the card", async () => {
    const runDoctorRepairQueued = vi.fn(() =>
      Promise.reject(new Error("boom")),
    );
    const management = makeBridgeManagement({
      runDoctor: () =>
        Promise.resolve<BridgeHostDoctorReport>({
          issues: [serviceNotRegisteredIssue()],
          ranAt: "2026-05-15T00:00:00Z",
        }),
      runDoctorRepairQueued,
    });
    renderBridgeCard(management);

    for (let i = 1; i <= 3; i += 1) {
      await clickBridgeFixAndAwaitCall(
        /Register service/i,
        runDoctorRepairQueued,
        i,
      );
    }

    await waitFor(() => {
      const button = screen.getByRole("button", {
        name: /Register service/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    expect(runDoctorRepairQueued).toHaveBeenCalledTimes(3);
  });
});
