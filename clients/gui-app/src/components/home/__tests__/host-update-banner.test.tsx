import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostUpdateBanner } from "@/components/home/host-update-banner";
import { HostControllerStatusListener } from "@/components/layout/bridges/host-controller-status-listener";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  HOST_UPDATE_BANNER_SNOOZE_MS,
  useHostUpdateBannerStore,
} from "@/stores/settings/host-update-banner-store";
import type {
  ActivateInstalledOk,
  ApplyStagedOk,
  HostControllerStatus,
  HostLifecyclePending,
  HostLifecycleRunAdmission,
  HostLifecycleView,
  IHostLifecycleHost,
  IHostManagement,
  IRunnerHost,
  LocalHostCapability,
  MutationOutcome,
} from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import type { DesktopHostControllerStatusBridge } from "@/lib/windows/types";
import { runnerQueryKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toast } from "sonner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  HOST_UPDATED_SERVICE_DISABLED_MESSAGE,
  HOST_UPDATE_SERVICE_DISABLED_MESSAGE,
  SERVICE_TASK_NOT_OWNED_MESSAGE,
} from "@traycer-clients/shared/platform/host-service-notices";

const openSettingsMock = vi.hoisted(() => vi.fn());
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: openSettingsMock,
    openHistory: vi.fn(),
    close: vi.fn(),
    setSection: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  },
}));

interface Overrides {
  readonly status?: HostControllerStatus;
  readonly applyStaged?: () => Promise<MutationOutcome<ApplyStagedOk>>;
  readonly activateInstalled?: () => Promise<
    MutationOutcome<ActivateInstalledOk>
  >;
}

const UP_TO_DATE_STATUS: HostControllerStatus = {
  download: null,
  mutation: null,
  installedVersion: "1.4.1",
  latestVersion: "1.4.1",
  stagedVersion: null,
  installedRuntimeVersion: null,
  runningRuntimeVersion: null,
  updateReady: false,
  activation: "activated",
  reachable: true,
  localAttempt: null,
  removedByUser: false,
  checkedAt: "2026-05-15T00:00:00Z",
  lastEnsureFailure: null,
  updateDeferral: null,
};

const READY_STATUS: HostControllerStatus = {
  ...UP_TO_DATE_STATUS,
  latestVersion: "1.4.2",
  stagedVersion: "1.4.2",
  updateReady: true,
};

function makeManagement(overrides: Overrides): IHostManagement {
  const notImplemented = (method: string) => (): Promise<never> =>
    Promise.reject(new Error(`${method} not implemented`));
  const status = overrides.status ?? UP_TO_DATE_STATUS;
  return {
    getHostControllerStatus: vi.fn(() => Promise.resolve(status)),
    convergeReady: vi.fn(notImplemented("convergeReady")),
    applyStaged: vi.fn(overrides.applyStaged ?? notImplemented("applyStaged")),
    activateInstalled: vi.fn(
      overrides.activateInstalled ?? notImplemented("activateInstalled"),
    ),
    installVersion: vi.fn(notImplemented("installVersion")),
    uninstallHost: vi.fn(notImplemented("uninstallHost")),
    restartHost: vi.fn(() => Promise.resolve({ kind: "restarted" as const })),
    uninstallTraycer: vi.fn(notImplemented("uninstallTraycer")),
    getRemovalState: vi.fn(() => Promise.resolve({ removedByUser: false })),
    clearRemoval: vi.fn(() => Promise.resolve()),
    getHostLogs: vi.fn(() => Promise.resolve({ path: null, tail: "" })),
    runDoctor: vi.fn(() => Promise.resolve({ issues: [], ranAt: "" })),
    availableVersions: vi.fn(notImplemented("availableVersions")),
    installedRecord: vi.fn(() => Promise.resolve(null)),
    registerService: vi.fn(notImplemented("registerService")),
    deregisterService: vi.fn(notImplemented("deregisterService")),
    registryCheck: vi.fn(notImplemented("registryCheck")),
    freePortAndRestart: vi.fn((input) =>
      Promise.resolve({ kind: "applied" as const, ...input }),
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

function makeHost(management: IHostManagement | null): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  // Preserve MockRunnerHost's prototype methods (signIn, signOut, …) while
  // overriding the readonly fields the test needs to vary. Spreading a class
  // instance only copies own enumerable fields, so we keep the prototype
  // chain via Object.create.
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostManagement: management,
    hostTray: null,
  });
}

const LOCAL_HOST_ID = "desktop-pid-1";

/** Same as {@link makeHost}, with a known local host so `useReactiveLocalHostEntry()`
 * resolves a hostId and the Enable-background-service action is offered. */
function makeHostWithLocalHost(
  management: IHostManagement | null,
): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: {
      hostId: LOCAL_HOST_ID,
      availability: "available",
      websocketUrl: "ws://127.0.0.1:4917/rpc",
      version: "1.2.3",
      pid: 4242,
      systemHostName: "test-machine",
      displayName: "test-machine",
    },
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

/** Overrides just `hostLifecycle` on an already-built fake host. */
function withHostLifecycle(
  host: IRunnerHost,
  hostLifecycle: IHostLifecycleHost,
): IRunnerHost {
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostLifecycle,
  });
}

interface FakeHostLifecycleForBanner extends IHostLifecycleHost {
  push(next: HostLifecycleView): void;
}

/** `get()` resolves the current view; `onChange` records the ONE handler
 * a consumer registers, and `push` re-plays it exactly as main's own
 * lifecycle-change push does. */
function createFakeHostLifecycleForBanner(
  initial: HostLifecycleView,
): FakeHostLifecycleForBanner {
  let current = initial;
  let handler: ((view: HostLifecycleView) => void) | null = null;
  return {
    get: () => Promise.resolve(current),
    set: () =>
      Promise.reject(new Error("hostLifecycle.set not used by this suite")),
    onChange: (nextHandler) => {
      handler = nextHandler;
      return {
        dispose: () => {
          handler = null;
        },
      };
    },
    quit: null,
    push: (next) => {
      current = next;
      handler?.(next);
    },
  };
}

function lifecycleView(
  admittedAs: HostLifecycleRunAdmission | null,
): HostLifecycleView {
  return {
    desired: { mode: "ask", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: "managed",
      supervisor: "enforcing",
      admittedAs,
    },
    pending: "none",
  };
}

const HOST_UPDATE_FOREGROUND_SENTENCE =
  "Update ready. A host you started in a terminal is running; stop it to finish the update.";

/**
 * The review's foreground-sentence ruling: the sentence above is true only when THIS APP
 * can finish the update itself
 * (`applied.localHostCapability === "managed" && pending !== "restart-app"`).
 * Otherwise a foreground run gets this one instead - the constant this names
 * (`HOST_FOREGROUND_UPDATE_READY_SELF_SERVE` or similar) does not exist yet,
 * so the literal is asserted directly.
 */
const HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE =
  "Update ready. A host you started in a terminal is running; update it yourself.";

function foregroundLifecycleView(overrides: {
  readonly localHostCapability: LocalHostCapability;
  readonly pending: HostLifecyclePending;
}): HostLifecycleView {
  return {
    desired: { mode: "ask", rev: 1, updatedBy: null, updatedAt: null },
    applied: {
      localHostCapability: overrides.localHostCapability,
      supervisor: "enforcing",
      admittedAs: "foreground",
    },
    pending: overrides.pending,
  };
}

function messengerFactory(): MessengerFactory<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {},
    });
}

/**
 * Same as {@link renderBanner}, plus `HostRuntimeProvider` - the binding
 * `useReactiveLocalHostEntry()` reads its directory from
 * (`useHostBinding()?.directory`), which `renderBanner` alone never
 * supplies, so the Enable-background-service action's `onEnableService`
 * stays null there regardless of `localHost`.
 */
function renderBannerWithLocalHostBinding(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory()}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <HostUpdateBanner className={undefined} />
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function renderBanner(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostUpdateBanner className={undefined} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function renderBannerWithStatusListener(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <HostControllerStatusListener />
        <HostUpdateBanner className={undefined} />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function createStatusBridge(): {
  readonly bridge: DesktopHostControllerStatusBridge;
  readonly emit: (status: HostControllerStatus) => void;
} {
  const handlers = new Set<(status: HostControllerStatus) => void>();
  return {
    bridge: {
      onChange: (handler) => {
        handlers.add(handler);
        return {
          dispose: () => {
            handlers.delete(handler);
          },
        };
      },
    },
    emit: (status) => {
      for (const handler of handlers) {
        handler(status);
      }
    },
  };
}

function findHostUpdateBanner(): Promise<HTMLElement> {
  return screen.findByRole("status", {
    name: /Traycer host update available: 1\.4\.2/i,
  });
}

function queryHostUpdateBanner(): HTMLElement | null {
  return screen.queryByRole("status", {
    name: /Traycer host update/i,
  });
}

/**
 * Synchronize on host-controller status query completion (and the cache
 * update that drives the banner render). Negative "stays hidden" assertions
 * must wait here first: while the query is still loading, `status` is
 * undefined and the banner is null for the wrong reason.
 */
async function waitForHostControllerStatusReady(
  management: IHostManagement,
  queryClient: QueryClient,
): Promise<void> {
  const queryKey = runnerQueryKeys.hostControllerStatus(management);
  await waitFor(() => {
    expect(management.getHostControllerStatus).toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKey)?.status).toBe("success");
  });
}

describe("HostUpdateBanner (Host Update Layer Redesign, D4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset persistent zustand state so a snooze written by one test does
    // not leak into the next.
    useHostUpdateBannerStore.setState({ snoozeUntilByVersion: {} });
  });
  afterEach(() => {
    cleanup();
  });

  it("renders 'Update now' when the status is updateReady", async () => {
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
    expect(screen.getByText(/1\.4\.2/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Update now/i })).toBeTruthy();
  });

  it("stays hidden when up to date (no debt, activation:'activated')", async () => {
    const management = makeManagement({ status: UP_TO_DATE_STATUS });
    const queryClient = renderBanner(makeHost(management));
    await waitForHostControllerStatusReady(management, queryClient);
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("never shows for a merely-detected update (latestVersion ahead but not staged/ready)", async () => {
    const management = makeManagement({
      status: {
        ...UP_TO_DATE_STATUS,
        latestVersion: "1.5.0",
        stagedVersion: null,
        updateReady: false,
      },
    });
    const queryClient = renderBanner(makeHost(management));
    await waitForHostControllerStatusReady(management, queryClient);
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it.each(["pendingActivation", "activationUnknown"] as const)(
    "renders 'Restart host' identically for activation debt (%s)",
    async (activation) => {
      const management = makeManagement({
        status: { ...UP_TO_DATE_STATUS, activation },
      });
      renderBanner(makeHost(management));
      expect(
        await screen.findByRole("button", { name: /Restart host/i }),
      ).toBeTruthy();
    },
  );

  it("activation:'unavailable' suppresses debt UI (direct projection)", async () => {
    const management = makeManagement({
      status: { ...UP_TO_DATE_STATUS, activation: "unavailable" },
    });
    const queryClient = renderBanner(makeHost(management));
    await waitForHostControllerStatusReady(management, queryClient);
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("update-over-debt priority: updateReady + activation debt renders the update copy, and the click submits applyStaged (direct projection)", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "ok",
        value: {
          appliedVersion: "1.4.2",
          runningActivated: true,
          applied: true,
        },
      }),
    );
    const activateInstalled = vi.fn(() =>
      Promise.resolve<MutationOutcome<ActivateInstalledOk>>({
        kind: "ok",
        value: { activated: true },
      }),
    );
    const management = makeManagement({
      status: { ...READY_STATUS, activation: "pendingActivation" },
      applyStaged,
      activateInstalled,
    });
    renderBanner(makeHost(management));

    const button = await screen.findByRole("button", { name: /Update now/i });
    expect(screen.queryByRole("button", { name: /Restart host/i })).toBeNull();
    fireEvent.click(button);

    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", false);
    });
    expect(activateInstalled).not.toHaveBeenCalled();
  });

  it("invokes applyStaged when 'Update now' is clicked and shows success toast, clearing the snooze", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "ok",
        value: {
          appliedVersion: "1.4.2",
          runningActivated: true,
          applied: true,
        },
      }),
    );
    const management = makeManagement({
      status: READY_STATUS,
      applyStaged,
    });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    useHostUpdateBannerStore
      .getState()
      .snooze("1.4.2", Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS);
    fireEvent.click(button);
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", false);
    });
    await waitFor(() => {
      const snoozes = useHostUpdateBannerStore.getState().snoozeUntilByVersion;
      expect(Object.hasOwn(snoozes, "1.4.2")).toBe(false);
    });
  });

  it("opens the Force/Defer dialog on a busy outcome, Force following continuation:'retry-with-force'", async () => {
    const applyStaged = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "busy" as const,
        continuation: "retry-with-force" as const,
        message: "Another Traycer process is applying an update.",
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        value: {
          appliedVersion: "1.4.2",
          runningActivated: true,
          applied: true,
        },
      });
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    const dialog = await screen.findByTestId("host-busy-force-defer-dialog");
    // Shared with the restart flow's busy verdict; the purpose attribute is
    // the one thing that distinguishes the two on a page rendering both.
    expect(dialog.dataset.purpose).toBe("update");
    expect(dialog.textContent).toContain(
      "Another Traycer process is applying an update.",
    );
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledWith("manual", true);
    });
  });

  it("Force follows continuation:'activate' by submitting activateInstalled, not re-running apply", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve({
        kind: "busy" as const,
        continuation: "activate" as const,
        message: "Update already committed; activation is pending.",
      }),
    );
    const activateInstalled = vi.fn(() =>
      Promise.resolve<MutationOutcome<ActivateInstalledOk>>({
        kind: "ok",
        value: { activated: true },
      }),
    );
    const management = makeManagement({
      status: READY_STATUS,
      applyStaged,
      activateInstalled,
    });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-force"));
    await waitFor(() => {
      expect(activateInstalled).toHaveBeenCalledWith(true);
    });
    expect(applyStaged).toHaveBeenCalledTimes(1);
  });

  it("Defer dismisses the busy dialog without re-submitting", async () => {
    const applyStaged = vi.fn(() =>
      Promise.resolve({
        kind: "busy" as const,
        continuation: "retry-with-force" as const,
        message: "Another Traycer process is applying an update.",
      }),
    );
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    await screen.findByTestId("host-busy-force-defer-dialog");
    fireEvent.click(screen.getByTestId("host-busy-defer"));
    await waitFor(() => {
      expect(screen.queryByTestId("host-busy-force-defer-dialog")).toBeNull();
    });
    expect(applyStaged).toHaveBeenCalledTimes(1);
  });

  it("renders its own deferred-lock outcome inline, with Retry", async () => {
    const applyStaged = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "deferred" as const,
        message: "Another Traycer process is managing the host.",
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        value: {
          appliedVersion: "1.4.2",
          runningActivated: true,
          applied: true,
        },
      });
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    const deferred = await screen.findByTestId("host-update-banner-deferred");
    expect(deferred.textContent).toContain(
      "Another Traycer process is managing the host.",
    );

    fireEvent.click(screen.getByTestId("host-update-banner-retry"));
    await waitFor(() => {
      expect(applyStaged).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("host-update-banner-deferred")).toBeNull();
    });
  });

  describe("store-format floor refusal (terminal outcome)", () => {
    const FLOOR_MESSAGE =
      "Updating would install a host that cannot read this machine's data. Open Settings › Host to review it.";

    async function clickUpdateWith(
      applyStaged: () => Promise<MutationOutcome<ApplyStagedOk>>,
    ): Promise<void> {
      const management = makeManagement({ status: READY_STATUS, applyStaged });
      renderBanner(makeHost(management));
      fireEvent.click(
        await screen.findByRole("button", { name: /Update now/i }),
      );
      await screen.findByTestId("host-update-banner-deferred");
    }

    it("a failed outcome with the floor code shows its safe copy, no Retry and no CLI flag, and offers Settings › Host", async () => {
      openSettingsMock.mockClear();
      await clickUpdateWith(() =>
        Promise.resolve({
          kind: "failed" as const,
          message: FLOOR_MESSAGE,
          errorCode: "E_HOST_STORE_FORMAT_FLOOR",
        }),
      );

      const text = screen.getByTestId(
        "host-update-banner-deferred",
      ).textContent;
      expect(text).toContain("Settings › Host");
      expect(text).not.toContain("--accept-store-format-loss");
      expect(screen.queryByTestId("host-update-banner-retry")).toBeNull();

      fireEvent.click(
        screen.getByTestId("host-update-banner-open-host-settings"),
      );
      expect(openSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ section: "host" }),
      );
    });

    it.each([
      ["another CLI code", "E_SOMETHING_ELSE"],
      ["no code", null],
    ])(
      "a failed outcome with %s keeps its message and Retry, and offers no Settings action",
      async (_name, errorCode) => {
        await clickUpdateWith(() =>
          Promise.resolve({
            kind: "failed" as const,
            message: "Something else went wrong.",
            errorCode,
          }),
        );

        expect(
          screen.getByTestId("host-update-banner-deferred").textContent,
        ).toContain("Something else went wrong.");
        expect(screen.getByTestId("host-update-banner-retry")).toBeTruthy();
        expect(
          screen.queryByTestId("host-update-banner-open-host-settings"),
        ).toBeNull();
      },
    );
  });

  // G6(i): a CONTROLLER-LANE terminal failure while the local rich view is
  // idle/unknown (this file's whole premise — no host binding at all) must
  // still announce with alert semantics. `describeUpdateOperation` has
  // nothing to say here (the attempt is idle/unknown), so `aria-live` MUST be
  // derived from the branch actually rendered (`terminal-outcome`), not from
  // the local view's own copy — which is exactly the defect the independent
  // cold review's finding 6 named: the live region kept reading the
  // non-rendered attempt lane while the visible text, label and styling all
  // correctly said "failed".
  it("G6(i) — a controller-lane terminal outcome is aria-live: assertive even though the local rich view has nothing to say", async () => {
    const applyStaged = vi.fn().mockResolvedValueOnce({
      kind: "deferred" as const,
      message: "Another Traycer process is managing the host.",
    });
    const management = makeManagement({ status: READY_STATUS, applyStaged });
    renderBanner(makeHost(management));
    const button = await screen.findByRole("button", { name: /Update now/i });
    fireEvent.click(button);

    await screen.findByTestId("host-update-banner-deferred");
    const banner = screen.getByTestId("host-update-banner");
    expect(banner.getAttribute("aria-live")).toBe("assertive");
  });

  it("hides when a pushed controller-status status clears updateReady", async () => {
    const statusBridge = createStatusBridge();
    const management = makeManagement({ status: READY_STATUS });
    const host = Object.assign(makeHost(management), {
      hostControllerStatus: statusBridge.bridge,
    });
    renderBannerWithStatusListener(host);
    expect(await findHostUpdateBanner()).toBeTruthy();

    act(() => {
      statusBridge.emit({
        ...UP_TO_DATE_STATUS,
        installedVersion: "1.4.2",
      });
    });

    await waitFor(() => {
      expect(queryHostUpdateBanner()).toBeNull();
    });
  });

  it("renders nothing when hostManagement is null (mobile/web)", () => {
    renderBanner(makeHost(null));

    expect(queryHostUpdateBanner()).toBeNull();
  });

  // Snooze flow - keyed to the persistent `useHostUpdateBannerStore`.
  // The store is reset in beforeEach so these tests cannot bleed into
  // each other.
  it("hides the banner after clicking the snooze (X) button", async () => {
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
    const snoozeBtn = screen.getByRole("button", { name: /Remind me later/i });
    fireEvent.click(snoozeBtn);
    await waitFor(() => {
      expect(queryHostUpdateBanner()).toBeNull();
    });
    // Persisted store should now hold an entry for the snoozed version.
    const snoozes = useHostUpdateBannerStore.getState().snoozeUntilByVersion;
    expect(Object.hasOwn(snoozes, "1.4.2")).toBe(true);
    expect(snoozes["1.4.2"]).toBeGreaterThan(Date.now());
  });

  it("stays hidden when a non-expired snooze exists for the current stagedVersion", async () => {
    // Pre-seed the store with a snooze that has not yet expired.
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        "1.4.2": Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS,
      },
    });
    const management = makeManagement({ status: READY_STATUS });
    const queryClient = renderBanner(makeHost(management));
    await waitForHostControllerStatusReady(management, queryClient);
    expect(queryHostUpdateBanner()).toBeNull();
  });

  it("re-appears when the snooze entry has expired (snoozeUntil < now)", async () => {
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        // Snooze expired one hour ago.
        "1.4.2": Date.now() - 60 * 60 * 1000,
      },
    });
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
  });

  it("re-arms when stagedVersion advances past the snoozed version (snooze is per-version)", async () => {
    // User snoozed v1.4.1; now the stage reports v1.4.2.
    useHostUpdateBannerStore.setState({
      snoozeUntilByVersion: {
        "1.4.1": Date.now() + HOST_UPDATE_BANNER_SNOOZE_MS,
      },
    });
    const management = makeManagement({ status: READY_STATUS });
    renderBanner(makeHost(management));
    expect(await findHostUpdateBanner()).toBeTruthy();
  });

  describe("a foreground-admitted host cannot finish an update over itself", () => {
    it("[RED] update-ready + admittedAs:'foreground' replaces the action with the stop-it sentence", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(lifecycleView("foreground")),
      );
      renderBanner(host);
      await findHostUpdateBanner();

      // The lifecycle view is read after mount, so wait for the sentence
      // before asserting what it replaced.
      expect(
        await screen.findByText(HOST_UPDATE_FOREGROUND_SENTENCE),
      ).toBeTruthy();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();
      expect(screen.getByTestId("host-update-banner-snooze")).toBeTruthy();
      expect(management.applyStaged).not.toHaveBeenCalled();
    });

    it("[RED] activation debt + admittedAs:'foreground' replaces the restart action with the same sentence", async () => {
      const management = makeManagement({
        status: { ...UP_TO_DATE_STATUS, activation: "pendingActivation" },
      });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(lifecycleView("foreground")),
      );
      renderBanner(host);
      await screen.findByTestId("host-update-banner-snooze");

      expect(
        await screen.findByText(HOST_UPDATE_FOREGROUND_SENTENCE),
      ).toBeTruthy();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();
      expect(screen.getByTestId("host-update-banner-snooze")).toBeTruthy();
      expect(management.activateInstalled).not.toHaveBeenCalled();
    });

    it("[RED] a later push with admittedAs:null brings the action back reading 'Update now'", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const hostLifecycle = createFakeHostLifecycleForBanner(
        lifecycleView("foreground"),
      );
      const host = withHostLifecycle(makeHost(management), hostLifecycle);
      renderBanner(host);
      await findHostUpdateBanner();

      expect(
        await screen.findByText(HOST_UPDATE_FOREGROUND_SENTENCE),
      ).toBeTruthy();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();

      act(() => {
        hostLifecycle.push(lifecycleView(null));
      });

      expect(
        await screen.findByRole("button", { name: /Update now/i }),
      ).toBeTruthy();
    });

    it("[GREEN control] update-ready + admittedAs:null renders today's 'Update now' action, no sentence", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(lifecycleView(null)),
      );
      renderBanner(host);

      expect(
        await screen.findByRole("button", { name: /Update now/i }),
      ).toBeTruthy();
      expect(screen.queryByText(HOST_UPDATE_FOREGROUND_SENTENCE)).toBeNull();
    });
  });

  describe("The foreground-sentence ruling — the foreground sentence is true only when this app can finish the update itself", () => {
    it("[RED] booted in none (localHostCapability:'none', pending:'none'): the self-serve sentence, not the foreground-update one, with no action", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(
          foregroundLifecycleView({
            localHostCapability: "none",
            pending: "none",
          }),
        ),
      );
      renderBanner(host);
      await screen.findByTestId("host-update-banner-foreground");

      expect(screen.queryByText(HOST_UPDATE_FOREGROUND_SENTENCE)).toBeNull();
      expect(
        screen.getByText(HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE),
      ).toBeTruthy();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();
    });

    it("[RED] a committed '→ none' this session (localHostCapability:'managed', pending:'restart-app'): same three assertions", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(
          foregroundLifecycleView({
            localHostCapability: "managed",
            pending: "restart-app",
          }),
        ),
      );
      renderBanner(host);
      await screen.findByTestId("host-update-banner-foreground");

      expect(screen.queryByText(HOST_UPDATE_FOREGROUND_SENTENCE)).toBeNull();
      expect(
        screen.getByText(HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE),
      ).toBeTruthy();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();
    });

    it("[GREEN] managed + pending:'none': the foreground-update sentence, not the self-serve one", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(
          foregroundLifecycleView({
            localHostCapability: "managed",
            pending: "none",
          }),
        ),
      );
      renderBanner(host);
      await screen.findByTestId("host-update-banner-foreground");

      expect(screen.getByText(HOST_UPDATE_FOREGROUND_SENTENCE)).toBeTruthy();
      expect(
        screen.queryByText(HOST_UPDATE_FOREGROUND_SELF_SERVE_SENTENCE),
      ).toBeNull();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();
    });

    it("[GREEN] managed + pending:'restart-host' (restart-to-apply): the foreground-update sentence still shows", async () => {
      const management = makeManagement({ status: READY_STATUS });
      const host = withHostLifecycle(
        makeHost(management),
        createFakeHostLifecycleForBanner(
          foregroundLifecycleView({
            localHostCapability: "managed",
            pending: "restart-host",
          }),
        ),
      );
      renderBanner(host);
      await screen.findByTestId("host-update-banner-foreground");

      expect(screen.getByText(HOST_UPDATE_FOREGROUND_SENTENCE)).toBeTruthy();
      expect(screen.queryByTestId("host-update-banner-action")).toBeNull();
    });
  });
});

// A service-registration notice is not a failed update. Whichever surface ran
// the apply, a `deferred` carrying one of the desktop's three notices is said
// once as a toast and never becomes the failure banner, Retry, or a
// `HostUpdateFailed` event (retrying cannot change a disabled task or another
// user's task).
// T08 ruling 13's sentence, spelled out so a copy change is a test change.
const UNCONFIRMED =
  "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Try again, or run `traycer host doctor`.";

describe("HostUpdateBanner: service-registration notices are not failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHostUpdateBannerStore.setState({ snoozeUntilByVersion: {} });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    [
      "a disabled task the apply left off",
      HOST_UPDATED_SERVICE_DISABLED_MESSAGE,
      "warning",
    ],
    [
      "a launch apply waiting on a disabled task",
      HOST_UPDATE_SERVICE_DISABLED_MESSAGE,
      "warning",
    ],
    ["another Windows user's task", SERVICE_TASK_NOT_OWNED_MESSAGE, "info"],
    // T08 ruling 13: an owner that could not be confirmed is a notice too.
    ["a task whose owner could not be confirmed", UNCONFIRMED, "info"],
  ] as const)(
    "%s: a toast, no failure banner, no Retry, no HostUpdateFailed",
    async (_label, message, toastKind) => {
      const track = vi.spyOn(Analytics.getInstance(), "track");
      const applyStaged = vi.fn(() =>
        Promise.resolve<MutationOutcome<ApplyStagedOk>>({
          kind: "deferred",
          message,
        }),
      );
      const management = makeManagement({ status: READY_STATUS, applyStaged });
      renderBanner(makeHost(management));

      fireEvent.click(
        await screen.findByRole("button", { name: /Update now/i }),
      );

      await waitFor(() => {
        expect(applyStaged).toHaveBeenCalledWith("manual", false);
      });
      await waitFor(() => {
        // No local host to fence the enable action to here, so the plain
        // notice: the message alone.
        expect(vi.mocked(toast[toastKind])).toHaveBeenCalledWith(message);
      });
      expect(screen.queryByTestId("host-update-banner-deferred")).toBeNull();
      expect(screen.queryByTestId("host-update-banner-retry")).toBeNull();
      expect(
        screen.queryByRole("status", { name: /host update failed/i }),
      ).toBeNull();
      expect(
        track.mock.calls.filter(
          ([event]) => event === AnalyticsEvent.HostUpdateFailed,
        ),
      ).toEqual([]);
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    },
  );

  it("control: any other deferral is still the inline failure with Retry and is tracked", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const applyStaged = vi.fn(() =>
      Promise.resolve<MutationOutcome<ApplyStagedOk>>({
        kind: "deferred",
        message: "Another Traycer process is managing the host.",
      }),
    );
    renderBanner(
      makeHost(makeManagement({ status: READY_STATUS, applyStaged })),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Update now/i }));
    await screen.findByTestId("host-update-banner-deferred");
    expect(screen.getByTestId("host-update-banner-retry")).toBeTruthy();
    expect(
      track.mock.calls.filter(
        ([event]) => event === AnalyticsEvent.HostUpdateFailed,
      ),
    ).toHaveLength(1);
  });

  it("an update-ready row with an updateDeferral shows the message and no Update now, in the info tint", async () => {
    const management = makeManagement({
      status: {
        ...READY_STATUS,
        updateDeferral: {
          message: HOST_UPDATE_SERVICE_DISABLED_MESSAGE,
          code: "E_SERVICE_REGISTRATION_DISABLED",
        },
      },
    });
    renderBanner(makeHost(management));
    const notice = await screen.findByTestId(
      "host-update-banner-service-disabled",
    );
    expect(notice.textContent).toBe(HOST_UPDATE_SERVICE_DISABLED_MESSAGE);
    expect(screen.queryByRole("button", { name: /Update now/i })).toBeNull();
    expect(
      screen.getByRole("status", { name: /host update waiting/i }).className,
    ).not.toContain("destructive");
    // No local host is known in this fixture (`makeHost`'s `localHost: null`),
    // so the Enable action has nothing to fence a repair to.
    expect(
      screen.queryByTestId("host-update-banner-enable-service"),
    ).toBeNull();
  });

  // R5 §G cleanup: the update row's Enable-background-service action, gated
  // on `updateDeferral.code === "E_SERVICE_REGISTRATION_DISABLED"` AND a
  // known local host.
  describe("the Enable background service action", () => {
    // Enabling the service cannot make a task this account's, so a not-owned
    // notice - either reason - never carries the action, even with a local
    // host to fence it to.
    it("an Update now deferred over a task whose owner could not be confirmed is an info toast with no Enable action, even with a local host known", async () => {
      const applyStaged = vi.fn(() =>
        Promise.resolve<MutationOutcome<ApplyStagedOk>>({
          kind: "deferred",
          message: UNCONFIRMED,
        }),
      );
      const management = makeManagement({ status: READY_STATUS, applyStaged });
      renderBannerWithLocalHostBinding(makeHostWithLocalHost(management));

      fireEvent.click(
        await screen.findByRole("button", { name: /Update now/i }),
      );

      await waitFor(() => {
        expect(vi.mocked(toast.info)).toHaveBeenCalledWith(UNCONFIRMED);
      });
      expect(vi.mocked(toast.warning)).not.toHaveBeenCalled();
      expect(screen.queryByTestId("host-update-banner-deferred")).toBeNull();
      expect(
        screen.queryByTestId("host-update-banner-enable-service"),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /force/i })).toBeNull();
      expect(document.body.textContent).not.toMatch(/another Windows user/i);
    });

    it("shows for E_SERVICE_REGISTRATION_DISABLED with a local host known, and clicking it dispatches register-service for that host", async () => {
      const runDoctorRepairQueued = vi.fn(() =>
        Promise.resolve({ kind: "applied" as const }),
      );
      const management = makeManagement({
        status: {
          ...READY_STATUS,
          updateDeferral: {
            message: HOST_UPDATE_SERVICE_DISABLED_MESSAGE,
            code: "E_SERVICE_REGISTRATION_DISABLED",
          },
        },
      });
      const patched: IHostManagement = { ...management, runDoctorRepairQueued };
      renderBannerWithLocalHostBinding(makeHostWithLocalHost(patched));

      const enableButton = await screen.findByTestId(
        "host-update-banner-enable-service",
      );
      fireEvent.click(enableButton);

      await waitFor(() => {
        expect(runDoctorRepairQueued).toHaveBeenCalledWith({
          repair: "register-service",
          expectedHostId: LOCAL_HOST_ID,
        });
      });
    });

    it("does not show for E_SERVICE_TASK_NOT_OWNED, even with a local host known", async () => {
      const management = makeManagement({
        status: {
          ...READY_STATUS,
          updateDeferral: {
            message: SERVICE_TASK_NOT_OWNED_MESSAGE,
            code: "E_SERVICE_TASK_NOT_OWNED",
          },
        },
      });
      renderBannerWithLocalHostBinding(makeHostWithLocalHost(management));

      const notice = await screen.findByTestId(
        "host-update-banner-service-disabled",
      );
      expect(notice.textContent).toBe(SERVICE_TASK_NOT_OWNED_MESSAGE);
      expect(
        screen.queryByTestId("host-update-banner-enable-service"),
      ).toBeNull();
    });
  });
});
