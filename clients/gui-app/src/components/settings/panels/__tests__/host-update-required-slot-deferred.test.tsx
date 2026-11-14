// A click on Settings ▸ Update now shows a deferred `applyStaged` refusal
// inline. The older-host hook is real; only the local-host id, the directory
// row, and `IHostManagement` are faked. `convergeReady` must not run, and the
// refusal is not a toast.
const toastCalls = vi.hoisted(
  (): Array<{
    readonly message: unknown;
    readonly options: { readonly description?: unknown } | undefined;
  }> => [],
);
vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: (
    message: unknown,
    options: { readonly description?: unknown } | undefined,
  ) => {
    toastCalls.push({ message, options });
    return 0;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

const appVersion = vi.hoisted((): { current: string | null } => ({
  current: "1.5.0",
}));
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => appVersion.current,
  getClientAppVersionLabel: () => "v1.5.0",
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => "host-a",
}));
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: () => null,
  };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { IHostManagement } from "@traycer-clients/shared/platform/runner-host";
import { HostUpdateRequiredSlot } from "@/components/settings/panels/host-overview-panel";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../../../__tests__/create-fake-runner-host";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

const SENTENCE =
  "A host started in a terminal is running; the desktop won't update it.";

const INCOMPATIBLE: HostLeaseSnapshot = {
  hostId: "host-a",
  status: "dead",
  dead: {
    reason: "incompatible",
    detail: {
      code: "PROTOCOL_MAJOR_MISMATCH",
      hostVersion: "1.1.4",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    },
  },
};

function seedLeases(leases: readonly HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: "host-a",
    targetHostId: "host-a",
    effectiveHostId: "host-a",
    leases,
    selectionRevision: 1,
  });
}

function buildManagement(
  applyStaged: IHostManagement["applyStaged"],
  convergeReady: IHostManagement["convergeReady"],
): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} must not run in this test`));
  return {
    getHostControllerStatus: notImplemented("getHostControllerStatus"),
    convergeReady,
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
    applyStaged,
    activateInstalled: notImplemented("activateInstalled"),
    installVersion: notImplemented("installVersion"),
    uninstallHost: notImplemented("uninstallHost"),
    restartHost: notImplemented("restartHost"),
    uninstallTraycer: notImplemented("uninstallTraycer"),
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
        effectiveName: "Studio Mac",
      }),
    setHostName: (input) =>
      Promise.resolve({
        systemName: "studio-mac",
        customName: input.customName,
        effectiveName: input.customName ?? "Studio Mac",
      }),
  };
}

function renderSlot(management: IHostManagement): void {
  const runnerHost = createFakeRunnerHost({ hostManagement: management });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostUpdateRequiredSlot
          host={hostScopeOptionFixture({
            hostId: "host-a",
            name: "Studio Mac",
            isLocalMachine: true,
            health: {
              state: "update-required",
              label: "irrelevant to this fixture",
              detail: null,
              tone: "warn",
              live: false,
            },
          })}
        />
      </QueryClientProvider>
    </RunnerHostProvider>,
  );
}

beforeEach(() => {
  toastCalls.length = 0;
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("<HostUpdateRequiredSlot /> - a deferred applyStaged outcome, through the real older-host hook", () => {
  it("shows the refusal inline and does not call convergeReady or a toast", async () => {
    seedLeases([INCOMPATIBLE]);
    const applyStaged = vi.fn(() =>
      Promise.resolve({ kind: "deferred" as const, message: SENTENCE }),
    );
    const convergeReady = vi.fn(() =>
      Promise.reject(new Error("convergeReady must not run")),
    );
    renderSlot(buildManagement(applyStaged, convergeReady));

    fireEvent.click(screen.getByTestId("host-scope-update-host"));

    await waitFor(() => {
      expect(
        screen.getByTestId("host-ensure-failure-message").textContent,
      ).toBe(SENTENCE);
    });
    expect(applyStaged).toHaveBeenCalledWith("manual", false);
    expect(convergeReady).not.toHaveBeenCalled();
    expect(toastCalls).toEqual([]);
  });
});
