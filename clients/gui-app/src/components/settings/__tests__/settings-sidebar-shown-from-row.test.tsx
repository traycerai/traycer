import {
  queryOptions,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import type { IHostManagement } from "@traycer-clients/shared/platform/runner-host";
import type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import {
  buildOverviewManagement,
  makeInstalledRecord,
  selectHostOverviewTab,
} from "@/components/settings/panels/__tests__/host-overview-test-support";

const harness = vi.hoisted(() => ({
  hostIds: [] as string[],
  activeHostId: "host-a" as string | null,
  personalMembershipHostIds: ["host-x"],
  clients: {} as Record<string, HostClient<HostRpcRegistry>>,
  currentClient: null as HostClient<HostRpcRegistry> | null,
  spine: null as HostClient<HostRpcRegistry> | null,
  statusCalls: {} as Record<string, number>,
  labelResolverHostIds: [] as string[],
  scopedHostId: null as string | null,
  fleetHostIds: [] as string[],
  observeStatus: true,
  showPanel: false,
  management: null as IHostManagement | null,
  messengers: {} as Record<string, MockHostMessenger<HostRpcRegistry>>,
  accountRemovals: [] as string[],
  finishDeregister: null as (() => void) | null,
  xItem: null as HostListItem | null,
  policyWrites: [] as {
    readonly hostId: string;
    readonly input: UpdateHostVersionPolicyInput;
  }[],
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { remoteEntry } =
    await import("@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures");
  const hostsById = new Map(
    ["host-a", "host-x"].map((hostId) => [
      hostId,
      hostScopeOptionFixture({
        hostId,
        name: hostId === "host-x" ? "Host X" : "Host A",
        isLocalMachine: false,
        connectable: hostId !== "host-a",
        isActive: hostId === "host-a",
        entry: remoteEntry(hostId, null),
      }),
    ]),
  );
  // One object per account record, so X keeps its identity across renders.
  let xWithItem: HostScopeOption | null = null;
  return {
    useHostOptions: () => {
      const hosts = harness.hostIds.flatMap((hostId) => {
        const host = hostsById.get(hostId);
        if (host === undefined) return [];
        if (hostId !== "host-x" || harness.xItem === null) return [host];
        if (xWithItem?.item !== harness.xItem)
          xWithItem = { ...host, item: harness.xItem };
        return [xWithItem];
      });
      return hostOptionsFixture({
        hosts,
        activeHostId: harness.activeHostId,
      });
    },
  };
});

vi.mock(
  "@/components/settings/environment/use-environment-status-model",
  () => ({
    useEnvironmentStatusModel: () => ({
      picker: {
        localRows: [],
        defaultPick: { kind: "personal" as const },
      },
      statuses: new Map(),
    }),
  }),
);

vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
    useHostsRunningConfiguration: () => ({
      hosts: harness.personalMembershipHostIds.map((hostId) => ({
        hostId,
        name: hostId === "host-x" ? "Host X" : "Host A",
      })),
      state: "ready" as const,
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
    }),
  }),
);

vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/bots/use-host-environment-bindings-query")
      >();
    return {
      ...actual,
      useHostEnvironmentBindings: () => ({
        byHostId: new Map(),
        ownSettingsHostIds: [],
        failedHostIds: [],
        retryFailed: () => undefined,
      }),
    };
  },
);

vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => null,
  useHostNegotiatedMethodVersions: () => new Map(),
}));

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (target: { readonly hostId: string } | null) =>
    target === null ? null : (harness.clients[target.hostId] ?? null),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => harness.currentClient,
  useHostBinding: () => ({
    hostClient: null,
    directory: null,
    auth: {
      deregisterHostFromAccount: (hostId: string) => {
        harness.accountRemovals.push(hostId);
        return new Promise<{ readonly kind: "ok" }>((resolve) => {
          harness.finishDeregister = () => resolve({ kind: "ok" });
        });
      },
      updateHostVersionPolicy: (
        hostId: string,
        input: UpdateHostVersionPolicyInput,
      ): Promise<UpdateHostVersionPolicyFetchResult> => {
        harness.policyWrites.push({ hostId, input });
        return Promise.resolve({
          kind: "ok",
          result: {
            hostId,
            updatePolicy: input.updatePolicy ?? "manual",
            desiredVersion: null,
          },
        });
      },
    },
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    refreshHostFleet: () => undefined,
    hostManagement: harness.management,
  }),
  useRunnerHostOrNull: () => null,
}));

vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHostsPollLiveness: () => undefined,
}));

vi.mock("@/hooks/host/use-refresh-host-directory-on-open", () => ({
  useRefreshHostDirectoryOnOpen: () => undefined,
}));
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));
vi.mock("@/providers/settings-density-context", () => ({
  useSettingsDensity: () => "compact",
}));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => false,
}));

vi.mock("@/hooks/host/use-fleet-update-views", async () => {
  const { UNKNOWN_FLEET_UPDATE_VIEW } =
    await import("@/lib/host/fleet-update/fleet-update-view");
  return {
    useFleetUpdateViews: (hostIds: readonly string[]) => {
      harness.fleetHostIds = [...hostIds];
      return () => UNKNOWN_FLEET_UPDATE_VIEW;
    },
  };
});

vi.mock("@/hooks/bots/use-host-environment-labels", async () => {
  const { useQueries } = await import("@tanstack/react-query");
  const { queryKeys: keys } = await import("@/lib/query-keys");
  return {
    useHostEnvironmentLabelResolver: (
      hostIds: readonly string[],
      scopedHostId: string | null,
    ) => {
      harness.labelResolverHostIds = [...hostIds];
      harness.scopedHostId = scopedHostId;
      useQueries({
        queries: hostIds.map((hostId) =>
          queryOptions({
            queryKey: keys.hostMethod<HostRpcRegistry, "environment.status">(
              hostId,
              "environment.status",
              {},
            ),
            queryFn: ({ signal }) => {
              const client = harness.clients[hostId];
              return client.requestWithSignal("environment.status", {}, signal);
            },
            enabled: hostId === scopedHostId,
            retry: false,
          }),
        ),
      });
      return () => null;
    },
  };
});

vi.mock("@/components/layout/sidebar-artwork", () => ({
  SidebarArtwork: () => null,
}));
vi.mock("@/components/settings/settings-search-box", () => ({
  SettingsSearch: () => null,
}));
vi.mock("@/providers/keybinding-context", () => ({
  singleDigitLeaderDigitFor: () => "1",
  useSettingsLeaderModifierForIndex: () => null,
}));
vi.mock("@/components/onboarding/getting-started-checklist", () => ({
  useGettingStartedGuideIsComplete: () => true,
}));
vi.mock("@/components/settings/environment-picker", () => ({
  EnvironmentPicker: () => null,
}));
vi.mock("@/components/settings/host-scope/add-host-dialog", () => ({
  AddHostDialog: () => null,
}));

import { HostOverviewNotices } from "@/components/settings/panels/host-overview-notices";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import {
  clearHostDoorState,
  noteHostDoorState,
} from "@/stores/host/host-door-state-store";

const X = hostScopeOptionFixture({
  hostId: "host-x",
  name: "Host X",
  isLocalMachine: false,
  isActive: false,
});

const STATUS_CALL_CAP = 3;

/** X's door refuses this app for good: the row shows whatever X's reads do. */
function refuseXForGood(): void {
  noteHostDoorState({
    hostId: X.hostId,
    kind: "not-a-member",
    detail: { code: "FORBIDDEN", doorReason: "not_a_member" },
  });
}

function makeClients(): void {
  const messengers = Object.fromEntries(
    harness.hostIds.map((hostId) => [
      hostId,
      new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `req-settings-sidebar-${hostId}`,
        handlers: {
          "environment.status": () => {
            if (hostId === "host-x") {
              const calls = (harness.statusCalls[hostId] ?? 0) + 1;
              harness.statusCalls[hostId] = calls;
              // Only the status-only row can loop (a rail re-read ends the row
              // it shows); past the cap the read never settles, so it ends.
              if (calls > STATUS_CALL_CAP) return new Promise(() => undefined);
            }
            return Promise.reject(new Error("status read refused"));
          },
        },
      }),
    ]),
  );
  harness.messengers = messengers;
  const spines = Object.fromEntries(
    Object.entries(messengers).map(([hostId, messenger]) => {
      const spine = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        invalidator: { invalidateHostScope: () => undefined },
        findHostById: (requestedHostId) =>
          requestedHostId === hostId ? remoteEntry(hostId, null) : null,
        messenger,
      });
      spine.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "token",
        }),
      );
      return [hostId, spine];
    }),
  );
  const spine = spines["host-a"];
  harness.spine = spine;
  harness.currentClient = spine.createRequesterForHostId("host-a");
  harness.clients = Object.fromEntries(
    Object.entries(spines).map(([hostId, hostSpine]) => [
      hostId,
      hostSpine.createRequesterForHostId(hostId),
    ]),
  );
}

function makeInstalledManagement(): IHostManagement {
  return buildOverviewManagement({
    installedRecord: vi.fn(() => Promise.resolve(makeInstalledRecord("1.4.2"))),
  });
}

function HostScopePage(): React.ReactNode {
  const scope = useHostScope();
  return (
    <>
      <SettingsSidebar
        mode={{
          kind: "modal",
          activeSection: "host",
          onSelect: () => undefined,
        }}
        variant="rail"
      />
      {harness.showPanel ? <HostSettingsPanel /> : null}
      {harness.observeStatus ? <StatusObserver /> : null}
      <HostOverviewNotices
        offlineNotice={null}
        offlineRetry={scope.retryEntryStatus}
        offlineRetryPending={false}
        operation={null}
        drainGate={null}
      />
    </>
  );
}

function StatusObserver(): React.ReactNode {
  useQuery(
    queryOptions({
      queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        "host-x",
        "environment.status",
        {},
      ),
      queryFn: ({ signal }) => {
        const client = harness.clients["host-x"];
        return client.requestWithSignal("environment.status", {}, signal);
      },
      refetchOnMount: false,
      retryOnMount: false,
      retry: false,
    }),
  );
  return null;
}

async function seedStatusError(queryClient: QueryClient): Promise<void> {
  const client = harness.clients["host-x"];
  await queryClient
    .fetchQuery(
      queryOptions({
        queryKey: queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
          "host-x",
          "environment.status",
          {},
        ),
        queryFn: ({ signal }) =>
          client.requestWithSignal("environment.status", {}, signal),
        retry: false,
      }),
    )
    .catch(() => undefined);
  expect(harness.statusCalls["host-x"]).toBe(1);
  harness.statusCalls["host-x"] = 0;
}

function renderPage(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <HostScopePage />
    </QueryClientProvider>,
  );
}

function resetState(): void {
  harness.hostIds = ["host-a", "host-x"];
  harness.activeHostId = "host-a";
  harness.personalMembershipHostIds = ["host-x"];
  harness.clients = {};
  harness.currentClient = null;
  harness.spine = null;
  harness.statusCalls = {};
  harness.labelResolverHostIds = [];
  harness.scopedHostId = null;
  harness.fleetHostIds = [];
  harness.observeStatus = true;
  harness.showPanel = false;
  harness.management = null;
  harness.messengers = {};
  harness.accountRemovals = [];
  harness.finishDeregister = null;
  harness.xItem = null;
  harness.policyWrites = [];
  useSettingsEnvironmentPickStore.setState({
    pick: PERSONAL_PICK,
    defaultPick: PERSONAL_PICK,
  });
  useSettingsHostScopeStore.getState().reset();
  clearHostDoorState("host-x");
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  cleanup();
  resetState();
});

describe("<SettingsSidebar /> while a named host is shown from its row", () => {
  it("keeps the refused status read idle until Try again and keeps naming X", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    makeClients();
    await seedStatusError(queryClient);
    act(() => carryViewedHostIntoSettingsScope(X.hostId));
    renderPage(queryClient);

    await waitFor(() =>
      expect(
        screen.getByTestId("settings-host-switcher").getAttribute("aria-label"),
      ).toContain("Host X"),
    );
    expect(harness.labelResolverHostIds).toEqual([]);
    expect(harness.scopedHostId).toBeNull();
    expect(harness.fleetHostIds).toEqual([]);
    expect(harness.statusCalls["host-x"]).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      const state = queryClient.getQueryState(
        queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
          "host-x",
          "environment.status",
          {},
        ),
      );
      expect(harness.statusCalls["host-x"]).toBe(1);
      expect(state?.status).toBe("error");
      expect(state?.fetchStatus).toBe("idle");
    });
    expect(
      screen.getByTestId("settings-host-switcher").getAttribute("aria-label"),
    ).toContain("Host X");
    expect(harness.statusCalls["host-x"]).toBe(1);
  });

  it("does not reread status while a terminally refused row remains visible", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    harness.observeStatus = false;
    renderPage(queryClient);
    const trigger = screen.getByTestId("settings-host-switcher");
    expect(trigger.getAttribute("aria-label")).toContain("Host X");
    expect(harness.statusCalls["host-x"] ?? 0).toBe(0);
    expect(harness.labelResolverHostIds).toEqual([]);
    expect(harness.fleetHostIds).toEqual([]);
  });

  it("keeps the rail and Overview on the same refused host", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    makeClients();
    harness.showPanel = true;
    harness.observeStatus = false;
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    renderPage(queryClient);

    expect(
      screen.getByTestId("settings-host-switcher").getAttribute("aria-label"),
    ).toContain("Host X");
    expect(
      screen.getByText("Status, updates and maintenance for Host X."),
    ).not.toBeNull();
    expect(
      screen.getByTestId("host-overview-installation-needs-connection")
        .textContent,
    ).toContain("Host X");
    expect(harness.statusCalls["host-x"] ?? 0).toBe(0);
  });

  it("closes A's removal confirmation before the real panel removes refused X", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    makeClients();
    act(() => refuseXForGood());
    harness.currentClient = null;
    const hostAMessenger = harness.messengers["host-a"];
    const hostXMessenger = harness.messengers["host-x"];
    hostAMessenger.calls.length = 0;
    hostXMessenger.calls.length = 0;
    harness.personalMembershipHostIds = ["host-a", "host-x"];
    harness.activeHostId = "ambient";
    harness.showPanel = true;
    harness.observeStatus = false;
    useSettingsHostScopeStore.getState().selectHost(PERSONAL_PICK, {
      hostId: "host-a",
      name: "Host A",
    });
    renderPage(queryClient);

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove from account" }),
    );
    expect(
      await screen.findByTestId("confirm-destructive-dialog"),
    ).not.toBeNull();
    expect(hostXMessenger.calls).toEqual([]);

    act(() => carryViewedHostIntoSettingsScope(X.hostId));
    await waitFor(() => {
      expect(
        screen.getByTestId("settings-host-switcher").getAttribute("aria-label"),
      ).toContain("Host X");
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      expect(
        screen.getByTestId("host-overview-installation-needs-connection")
          .textContent,
      ).toContain("Host X");
    });
    expect(hostXMessenger.calls).toEqual([]);
    hostAMessenger.calls.length = 0;
    hostXMessenger.calls.length = 0;
    fireEvent.click(
      screen.getByRole("button", { name: "Remove from account" }),
    );
    const xDialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(
      within(xDialog).getByRole("button", { name: "Remove from account" }),
    );

    await waitFor(() => expect(harness.accountRemovals).toEqual(["host-x"]));
    expect(hostAMessenger.calls).toEqual([]);
    expect(hostXMessenger.calls).toEqual([]);
    const finishDeregister = harness.finishDeregister;
    if (finishDeregister === null)
      throw new Error("Deregistration request did not start");
    act(() => finishDeregister());
    await waitFor(() =>
      expect(useSettingsHostScopeStore.getState().pendingHostId).toBeNull(),
    );
  });

  it("writes refused X's auto-update choice to the account and sends no host a request", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    makeClients();
    harness.xItem = {
      hostId: X.hostId,
      displayName: "Host X",
      platform: "darwin-arm64",
      kind: "personal",
      publicKey: "pk",
      createdAt: "2026-03-03T12:00:00Z",
      status: {
        connectivity: "connectable",
        viewerReachability: "unknown",
        clientCloud: "ok",
        updateState: "current",
        appVersion: "1.5.0",
        lastSeenAt: null,
      },
      updatePolicy: "manual",
    };
    harness.showPanel = true;
    harness.observeStatus = false;
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    const hostAMessenger = harness.messengers["host-a"];
    const hostXMessenger = harness.messengers["host-x"];
    hostAMessenger.calls.length = 0;
    hostXMessenger.calls.length = 0;
    renderPage(queryClient);

    await selectHostOverviewTab("updates");
    fireEvent.click(await screen.findByTestId("host-auto-update-host-x"));

    await waitFor(() =>
      expect(harness.policyWrites).toEqual([
        {
          hostId: "host-x",
          input: {
            updatePolicy: "auto",
            desiredVersion: undefined,
            force: undefined,
          },
        },
      ]),
    );
    expect(hostAMessenger.calls).toEqual([]);
    expect(hostXMessenger.calls).toEqual([]);
  });

  it("withholds LocalRecoveryDangerZone while a named entry waits and keeps it for an empty account", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    makeClients();
    harness.management = makeInstalledManagement();
    harness.showPanel = true;
    harness.observeStatus = false;
    act(() => carryViewedHostIntoSettingsScope(X.hostId));
    renderPage(queryClient);

    expect(screen.queryByTestId("settings-remove-traycer")).toBeNull();
    cleanup();
    resetState();
    harness.hostIds = [];
    harness.activeHostId = null;
    harness.personalMembershipHostIds = [];
    harness.management = makeInstalledManagement();
    harness.showPanel = true;
    renderPage(queryClient);

    expect(await screen.findByTestId("settings-remove-traycer")).not.toBeNull();
  });
});
