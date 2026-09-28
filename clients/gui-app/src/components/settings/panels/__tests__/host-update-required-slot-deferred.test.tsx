// Does a click on Settings ▸ Update host show the
// terminal-host refusal verbatim, when the REAL `useRunnerConvergeReady`
// mutation is the one turning `{ kind: "deferred", message }` into a toast?
//
// `host-update-required-slot.test.tsx` mocks
// `@/hooks/runner/use-runner-converge-ready-mutation` module-wide, which is
// exactly the seam that would hide a defect in the hook's own
// deferred -> rejection -> toast mapping. This file leaves that hook real and
// only fakes its `IHostManagement` port, one level further down.
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
  convergeReady: IHostManagement["convergeReady"],
): IHostManagement {
  const notImplemented = (name: string) => () =>
    Promise.reject(new Error(`${name} must not run in this test`));
  return {
    getHostControllerStatus: notImplemented("getHostControllerStatus"),
    convergeReady,
    getRemovalState: () => Promise.resolve({ removedByUser: false }),
    applyStaged: notImplemented("applyStaged"),
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
          canManageHost
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

describe("<HostUpdateRequiredSlot /> - a deferred (terminal-host) convergeReady outcome, through the REAL mutation hook", () => {
  it("shows the refusal verbatim in the error toast's description", async () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot(
      buildManagement(() =>
        Promise.resolve({ kind: "deferred" as const, message: SENTENCE }),
      ),
    );

    fireEvent.click(screen.getByTestId("host-scope-update-host"));

    await waitFor(() => {
      expect(toastCalls.length).toBe(1);
    });
    expect(toastCalls[0]?.options?.description).toBe(SENTENCE);
  });
});
