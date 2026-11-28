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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
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
  /** X's account record; `resetState` gives X one, as every listed row has. */
  xItem: null as HostListItem | null,
  xIsLocalMachine: false,
  /** This machine's service, read only while X is this machine. */
  xService: undefined as ServiceStatusSnapshot | undefined,
  policyWrites: [] as {
    readonly hostId: string;
    readonly input: UpdateHostVersionPolicyInput;
  }[],
}));

const fixtures = vi.hoisted(() => ({
  /** Uplink up is `connectable`; uplink down is `offline`. `clientCloud` stays ok. */
  registryItem: (
    hostId: string,
    displayName: string,
    connectivity: "connectable" | "offline",
  ): HostListItem => ({
    hostId,
    displayName,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-03-03T12:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.0.0",
      lastSeenAt: "2026-03-03T12:00:00Z",
    },
  }),
}));

// The rows come from the real builder, so registration, routability and health
// follow the account record, the directory entry, this machine's service and
// the selection authority's leases exactly as they do in the app.
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { buildHostScopeOptions } =
    await import("@/components/settings/host-scope/host-scope-model");
  const { localEntry, remoteEntry } =
    await import("@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures");
  const { useSelectionAuthorityStore: useAuthority } =
    await import("@/stores/host/selection-authority-store");
  const hostAItem = fixtures.registryItem("host-a", "Host A", "connectable");
  // Listed with no route, so nothing dials A.
  const hostAEntry: HostDirectoryEntry = {
    ...remoteEntry("host-a", null),
    websocketUrl: null,
  };
  const xEntry = (): HostDirectoryEntry =>
    harness.xIsLocalMachine
      ? { ...localEntry, hostId: "host-x", label: "Host X" }
      : remoteEntry("host-x", null);
  // One object per account record, so X keeps its identity across renders.
  let cached: {
    readonly key: string;
    readonly hosts: readonly HostScopeOption[];
  } | null = null;
  return {
    useHostOptions: () => {
      const leases = useAuthority((state) => state.leases);
      const authorityAttached = useAuthority((state) => state.attached);
      const key = JSON.stringify([
        harness.hostIds,
        harness.activeHostId,
        harness.xItem,
        harness.xIsLocalMachine,
        harness.xService,
        leases,
        authorityAttached,
      ]);
      if (cached?.key !== key) {
        const listed = new Set(harness.hostIds);
        const xItem = harness.xItem;
        cached = {
          key,
          hosts: buildHostScopeOptions({
            directory: [
              ...(listed.has("host-a") ? [hostAEntry] : []),
              ...(listed.has("host-x") ? [xEntry()] : []),
            ],
            registry: [
              ...(listed.has("host-a") ? [hostAItem] : []),
              ...(listed.has("host-x") && xItem !== null ? [xItem] : []),
            ],
            localHostId: harness.xIsLocalMachine ? "host-x" : null,
            activeHostId: harness.activeHostId,
            localService: harness.xService,
            localPlatform: null,
            hasLiveSession: () => false,
            leases,
            authorityAttached,
            localHostSettingUp: false,
            localHostTerminalRunNote: null,
            sandboxes: [],
            nowMs: 0,
          }),
        };
      }
      return hostOptionsFixture({
        hosts: cached.hosts,
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

import { HOST_UPDATE_REQUIRED_DETAIL } from "@/components/settings/host-scope/host-health";
import { hostLeaseFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { HostOverviewNotices } from "@/components/settings/panels/host-overview-notices";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { useHostScope } from "@/components/settings/host-scope/use-host-scope";
import { carryViewedHostIntoSettingsScope } from "@/components/settings/host-scope/carry-viewed-host-into-settings";
import {
  clearHostDoorState,
  noteHostDoorState,
} from "@/stores/host/host-door-state-store";

/** The computer Settings waits on; its row is the use-host-options double's. */
const X = { hostId: "host-x" } as const;

function localService(
  state: ServiceStatusSnapshot["state"],
): ServiceStatusSnapshot {
  const running = state === "running";
  return {
    state,
    version: state === "not-installed" ? null : "1.0.0",
    listenUrl: running ? "ws://127.0.0.1:4917/rpc" : null,
    pid: running ? 4242 : null,
  };
}

/** The selection authority, attached, holding `lease` for X. */
function publishXLease(lease: HostLeaseSnapshot): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: "host-a",
    targetHostId: "host-a",
    effectiveHostId: "host-a",
    leases: [lease],
    selectionRevision: 1,
  });
}

const X_INCOMPATIBLE_LEASE = hostLeaseFixture("host-x", {
  reason: "incompatible",
  detail: {
    code: "PROTOCOL_MAJOR_MISMATCH",
    hostVersion: "1.1.4",
    minSupportedVersion: "1.2.0",
    clientCompatibility: null,
  },
});

/** X's door says it is older than this app supports: the needs-update row. */
function markXOlderHost(): void {
  noteHostDoorState({
    hostId: X.hostId,
    kind: "older-host",
    detail: { code: "UNAUTHORIZED", doorReason: null },
  });
}

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

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function xRegistryItem(connectivity: "connectable" | "offline"): HostListItem {
  return fixtures.registryItem(X.hostId, "Host X", connectivity);
}

function shownFromRow(): string {
  return screen.getByTestId("scope-shown-from-row").textContent;
}

function renderShownPanel(queryClient: QueryClient): void {
  harness.showPanel = true;
  harness.observeStatus = false;
  renderPage(queryClient);
}

function healthLabel(): string {
  return screen.getByTestId("host-identity-health").textContent;
}

function expectSwitcherWord(word: string): void {
  fireEvent.click(screen.getByTestId("settings-host-switcher"));
  const row = screen.getByTestId(`settings-host-switcher-option-${X.hostId}`);
  expect(screen.getByTestId("settings-host-switcher-status").textContent).toBe(
    word,
  );
  expect(row.textContent).toContain(word);
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
      <span data-testid="scope-shown-from-row">
        {scope.shownFromRow ? "row" : "placed"}
      </span>
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
  harness.xItem = xRegistryItem("connectable");
  harness.xIsLocalMachine = false;
  harness.xService = undefined;
  harness.policyWrites = [];
  useSelectionAuthorityStore.getState().reset();
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

  it("reads Reported reachable, not Online, for this running computer shown from its row", () => {
    harness.xIsLocalMachine = true;
    harness.xService = localService("running");
    const queryClient = newQueryClient();
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Reported reachable");
  });

  it("keeps Update required and Update host for a refused computer whose lease is incompatible", async () => {
    harness.xIsLocalMachine = true;
    harness.xService = localService("running");
    publishXLease(X_INCOMPATIBLE_LEASE);
    const queryClient = newQueryClient();
    makeClients();
    await seedStatusError(queryClient);
    act(() => carryViewedHostIntoSettingsScope(X.hostId));
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Update required");
    const facts = screen.getByTestId("host-identity-fact-line");
    expect(facts.textContent).toContain(HOST_UPDATE_REQUIRED_DETAIL);
    expect(within(facts).getByTestId("host-scope-update-host")).not.toBeNull();
  });

  it("reads Update required for a computer whose door says it is older than this app", () => {
    const queryClient = newQueryClient();
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      markXOlderHost();
    });
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Update required");
    expect(screen.getByTestId("host-identity-fact-line").textContent).toContain(
      HOST_UPDATE_REQUIRED_DETAIL,
    );
  });

  it("keeps Offline for an older computer whose account says it is offline", () => {
    harness.xItem = xRegistryItem("offline");
    const queryClient = newQueryClient();
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      markXOlderHost();
    });
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Offline");
  });

  it.each([
    { service: "stopped", label: "Stopped" },
    { service: "not-installed", label: "Not installed" },
  ] as const)(
    "keeps $label for this computer, refused, while its service is $service",
    ({ service, label }) => {
      harness.xIsLocalMachine = true;
      harness.xService = localService(service);
      const queryClient = newQueryClient();
      makeClients();
      act(() => {
        carryViewedHostIntoSettingsScope(X.hostId);
        refuseXForGood();
      });
      renderShownPanel(queryClient);

      expect(shownFromRow()).toBe("row");
      expect(healthLabel()).toBe(label);
    },
  );

  it("reads Reported reachable, not Online, when a remote ready lease's status read was refused", async () => {
    publishXLease(hostLeaseFixture("host-x", null));
    const queryClient = newQueryClient();
    makeClients();
    await seedStatusError(queryClient);
    act(() => carryViewedHostIntoSettingsScope(X.hostId));
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Reported reachable");
  });

  it("reads Reported reachable for a refused remote computer whose registry uplink is up", () => {
    const queryClient = newQueryClient();
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Reported reachable");
  });

  it("reads Offline for a refused remote computer whose registry uplink is down", () => {
    publishXLease(hostLeaseFixture("host-x", null));
    harness.xItem = xRegistryItem("offline");
    const queryClient = newQueryClient();
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Offline");
  });

  it("words the rail row and the switcher trigger update required for a needs-update computer", () => {
    const queryClient = newQueryClient();
    makeClients();
    harness.observeStatus = false;
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      markXOlderHost();
    });
    renderPage(queryClient);

    expectSwitcherWord("update required");
  });

  it("words the rail row and the switcher trigger offline for a refused computer whose uplink is down", () => {
    publishXLease(hostLeaseFixture("host-x", null));
    harness.xItem = xRegistryItem("offline");
    const queryClient = newQueryClient();
    makeClients();
    harness.observeStatus = false;
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    renderPage(queryClient);

    expectSwitcherWord("offline");
  });

  it("keeps Online for this computer when it is placed and not shown from its row", () => {
    harness.xIsLocalMachine = true;
    harness.xService = localService("running");
    const queryClient = newQueryClient();
    makeClients();
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("placed");
    expect(healthLabel()).toBe("Online");
  });

  it("keeps Restarting… for a demoted computer whose own health is an expected restart", () => {
    publishXLease({
      hostId: "host-x",
      status: "restarting-expected",
      dead: null,
    });
    const queryClient = newQueryClient();
    makeClients();
    act(() => {
      carryViewedHostIntoSettingsScope(X.hostId);
      refuseXForGood();
    });
    renderShownPanel(queryClient);

    expect(shownFromRow()).toBe("row");
    expect(healthLabel()).toBe("Restarting…");
    expect(screen.queryByTestId("host-overview-offline-notice")).toBeNull();
    const installation = screen.getByTestId(
      "host-overview-tab-panel-installation",
    );
    expect(
      within(installation).getByTestId("host-scope-connecting"),
    ).not.toBeNull();
    expect(
      within(installation).queryByTestId(
        "host-overview-installation-needs-connection",
      ),
    ).toBeNull();
  });
});
