import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostOptionsFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";
import {
  chooseLogLevelOption,
  openLogLevelSelect,
} from "@/components/settings/panels/__tests__/diagnostics-test-support";
import {
  buildConfigHostFixture,
  CONFIG_LOG_LEVEL_METHODS,
  DIAGNOSTICS_LOG_METHODS,
  type ConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  clients: {} as Record<string, ConfigHostFixture["client"]>,
  activeHostId: "host-a",
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () =>
    hostOptionsFixture({
      hosts: harness.hosts,
      activeHostId: harness.activeHostId,
    }),
}));

vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  () => ({
    useEnvironmentStatusModel: () => ({
      picker: { localRows: [], defaultPick: { kind: "personal" as const } },
      statuses: new Map(),
    }),
  }),
);

vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: harness.hosts.map((host) => ({
        hostId: host.hostId,
        name: host.name,
      })),
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
    useHostsRunningConfiguration: () => ({
      hosts: harness.hosts.map((host) => ({
        hostId: host.hostId,
        name: host.name,
      })),
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
  }),
);

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: { readonly hostId: string } | null) =>
    target === null ? null : (harness.clients[target.hostId] ?? null),
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => harness.clients[harness.activeHostId],
    useHostBinding: () => {
      const selected =
        useSettingsHostScopeStore.getState().hostByEnvironment.personal;
      const hostId = selected?.hostId ?? harness.activeHostId;
      return {
        hostClient: harness.clients[hostId],
        directory: null,
      };
    },
  };
});

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
  }),
  useRunnerHostOrNull: () => null,
}));

vi.mock("@/providers/settings-density-context", () => ({
  useSettingsDensity: () => "comfortable",
}));

import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";

function ScopeHostId(): ReactNode {
  const scope = useHostScope();
  return <span data-testid="scope-host-id">{scope.hostId}</span>;
}

function setupFixtures(): {
  readonly hostA: ConfigHostFixture;
  readonly hostX: ConfigHostFixture;
} {
  const hostA = buildConfigHostFixture({
    hostId: "host-a",
    isLocalMachine: false,
    logLevels: { cliLogLevel: "warn", hostLogLevel: "info" },
  });
  const hostX = buildConfigHostFixture({
    hostId: "host-x",
    isLocalMachine: false,
    logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
  });
  harness.hosts = ["host-a", "host-x"].map((hostId) =>
    hostScopeOptionFixture({
      hostId,
      name: hostId === "host-a" ? "Host A" : "Host X",
      isLocalMachine: false,
      isActive: hostId === "host-a",
      entry: remoteEntry(hostId, null),
    }),
  );
  harness.clients = { "host-a": hostA.client, "host-x": hostX.client };
  harness.activeHostId = "host-a";
  for (const hostId of ["host-a", "host-x"]) {
    recordNegotiatedHostMethods(hostId, [
      ...CONFIG_LOG_LEVEL_METHODS,
      ...DIAGNOSTICS_LOG_METHODS,
    ]);
  }
  return { hostA, hostX };
}

function renderDiagnostics(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DiagnosticsSettingsPanel />
        <ScopeHostId />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  harness.hosts = [];
  harness.clients = {};
  harness.activeHostId = "host-a";
  useSettingsEnvironmentPickStore.setState({
    pick: PERSONAL_PICK,
    defaultPick: PERSONAL_PICK,
  });
  useSettingsHostScopeStore.getState().reset();
});

afterEach(() => {
  cleanup();
  harness.hosts = [];
  harness.clients = {};
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  useSettingsHostScopeStore.getState().reset();
});

describe("<DiagnosticsSettingsPanel /> with the real Settings Host scope", () => {
  it("writes log verbosity to X after the Settings host moves from A to X", async () => {
    const { hostA, hostX } = setupFixtures();
    useSettingsHostScopeStore.getState().selectHost(PERSONAL_PICK, {
      hostId: "host-a",
      name: "Host A",
    });
    renderDiagnostics();
    await screen.findByTestId("settings-log-level-cli");
    expect(screen.getByTestId("scope-host-id").textContent).toBe("host-a");

    act(() =>
      useSettingsHostScopeStore.getState().selectHost(PERSONAL_PICK, {
        hostId: "host-x",
        name: "Host X",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("scope-host-id").textContent).toBe("host-x"),
    );
    await openLogLevelSelect("cli");
    await chooseLogLevelOption("Debug");

    await waitFor(() =>
      expect(hostX.setLogLevelCalls).toContainEqual({
        scope: "cli",
        level: "debug",
      }),
    );
    expect(hostA.setLogLevelCalls).toHaveLength(0);
  });
});
