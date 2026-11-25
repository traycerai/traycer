import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrganizationView } from "@traycer/protocol/host/organization/contracts";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  poolHostDirectoryEntry,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  settleProcessHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { accountWideManifestFixtures } from "@traycer-clients/shared/test-fixtures/account-wide-manifest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { queryClient as appQueryClient } from "@/lib/query-client";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import { OrganizationProvider } from "@/hooks/organization/organization-provider";
import {
  useOrganization,
  useOrganizationView,
} from "@/hooks/organization/organization-context";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostRuntimeBinding } from "@/providers/host-runtime-provider";

const runtimeClient = vi.hoisted(() => ({
  current: null as HostClient<HostRpcRegistry> | null,
}));
const runtimeBindingRef = vi.hoisted(() => ({
  current: null as HostRuntimeBinding<HostRpcRegistry> | null,
}));
const routedStream: { client: object | null } = vi.hoisted(() => ({
  client: null,
}));
const servingDecision = vi.hoisted(() => {
  let current: HostServingDecision = {
    servingPeer: null,
    servingPeerMethods: null,
    servingPeerEnvironmentId: null,
  };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (next: HostServingDecision) => {
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
});

vi.mock("@/lib/host/app-serving-decision", async (importOriginal) => {
  const react = await import("react");
  const actual =
    await importOriginal<typeof import("@/lib/host/app-serving-decision")>();
  return {
    ...actual,
    useAppServingDecision: () =>
      react.useSyncExternalStore(
        servingDecision.subscribe,
        servingDecision.get,
        servingDecision.get,
      ),
  };
});

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => {
      if (runtimeClient.current === null)
        throw new Error("host client fixture is not installed");
      return runtimeClient.current;
    },
    useAuthService: () => ({
      revalidateCurrentContextAfterInvalidation: () => Promise.resolve(null),
    }),
  };
});

vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    getHostBindingSnapshot: () => runtimeBindingRef.current,
  };
});

vi.mock("@/hooks/host/use-surface-host-stream-binding", () => ({
  useSurfaceHostStreamBinding: () => null,
}));

vi.mock("@/hooks/host/use-pool-tier", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/host/use-pool-tier")>();
  return {
    ...actual,
    useRoutedStreamClient: () => ({
      client: routedStream.client,
      peerHostId: "pool",
    }),
  };
});

vi.mock("@/components/organization/organization-dialogs", () => ({
  OrganizationDialogHost: () => null,
}));

vi.mock("@/lib/epic-selectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/epic-selectors")>();
  return { ...actual, useRegisteredEpicLocalHome: () => false };
});

const poolEntry = poolHostDirectoryEntry("wss://pool.test/rpc");
if (poolEntry === null) throw new Error("pool fixture must build");

const teamComputer: HostDirectoryEntry = {
  hostId: "team-computer",
  label: "Team computer",
  kind: "remote",
  websocketUrl: "wss://team.test/rpc",
  version: "1.5.4",
  transportDialability: "dialable",
  owner: { kind: "team", id: "team-1", name: "Team" },
};

const personalComputer: HostDirectoryEntry = {
  ...teamComputer,
  hostId: "personal-computer",
  label: "Personal computer",
  owner: { kind: "user", id: "viewer-1" },
};

function OrganizationCommandProbe() {
  const organization = useOrganization();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void organization?.command({
            kind: "groups",
            operations: [
              {
                operation: "create",
                groupId: "group-new",
                name: "New group",
                color: "#4488cc",
                position: 0,
              },
            ],
          })
        }
      >
        Create group
      </button>
      <button type="button" onClick={() => void organization?.refresh()}>
        Refresh organization
      </button>
    </>
  );
}

function OrganizationGroupsProbe() {
  const organization = useOrganization();
  const groupNames = useOrganizationView(
    (view) => view?.groups.groups.map((group) => group.name).join(",") ?? "",
    Object.is,
  );
  return (
    <>
      <output data-testid="organization-groups">{groupNames}</output>
      <button type="button" onClick={() => void organization?.refresh()}>
        Refresh organization
      </button>
    </>
  );
}

describe("OrganizationProvider uses the pool for a team serving peer", () => {
  afterEach(() => {
    cleanup();
    runtimeClient.current?.dispose();
    runtimeClient.current = null;
    runtimeBindingRef.current = null;
    routedStream.client = null;
    servingDecision.publish({
      servingPeer: null,
      servingPeerMethods: null,
      servingPeerEnvironmentId: null,
    });
    useSelectionAuthorityStore.getState().reset();
    useAuthStore.getState().setSignedOut();
    resetNegotiatedManifests();
    appQueryClient.clear();
  });

  it("keeps organization refresh and commands on the pool despite the team handshake", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const currentManifest = accountWideManifestFixtures().current;
    expect(currentManifest.size).toBe(23);
    recordNegotiatedHostMethods(teamComputer.hostId, [...currentManifest]);
    recordNegotiatedHostMethods(poolEntry.hostId, [
      "organization.command",
      "organization.refresh",
    ]);
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "viewer-1", userName: "Viewer", email: "viewer@example.com" },
        { userId: "viewer-1", username: "Viewer" },
        [],
      );
    useSelectionAuthorityStore.setState({
      servingPeer: { kind: "computer", hostId: teamComputer.hostId },
    });
    appQueryClient.setQueryData(
      hostQueryKeys.method<HostRpcRegistry, "environment.binding.read">(
        poolEntry.hostId,
        "environment.binding.read",
        { hostId: teamComputer.hostId },
      ),
      {
        hostId: teamComputer.hostId,
        environment: {
          environmentId: "environment-team",
          ownerKind: "organization",
          ownerId: "team-1",
          roomId: "room-team",
          label: "Team",
        },
        explicit: true,
        enrolledByUserId: "viewer-1",
        canUnbind: false,
      },
    );
    const serving = readHostServingDecision((hostId) =>
      hostId === teamComputer.hostId ? teamComputer : null,
    );
    expect(serving.servingPeerEnvironmentId).toBe("environment-team");
    act(() => servingDecision.publish(serving));

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "organization-request",
      handlers: {
        "organization.refresh": () => ({
          catalog: [],
          groups: { version: "0", groups: [], memberships: [] },
          appearances: [],
          taskLabels: {},
          ready: true,
          authenticationRequired: false,
          pending: [],
          failures: [],
        }),
        "organization.command": (command) => ({
          commandId: command.commandId,
          disposition: "durably-accepted",
        }),
      },
    });
    const hosts = new Map<string, HostDirectoryEntry>([
      [poolEntry.hostId, poolEntry],
      [teamComputer.hostId, teamComputer],
    ]);
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hosts.get(hostId) ?? null,
      messenger,
      routing: {
        plan,
        selectedHostId: () => teamComputer.hostId,
        serving: () => servingDecision.get(),
      },
    });
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "fixture-token",
        identity: {
          userId: "viewer-1",
          username: "Viewer",
          providerHandle: "viewer",
        },
      }),
    );
    runtimeClient.current = client;

    const view = render(
      <QueryClientProvider client={queryClient}>
        <OrganizationProvider>
          <OrganizationCommandProbe />
        </OrganizationProvider>
      </QueryClientProvider>,
    );

    try {
      await waitFor(() => {
        expect(
          messenger.calls.filter(
            (call) => call.method === "organization.refresh",
          ),
        ).toHaveLength(1);
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh organization" }),
      );
      await waitFor(() => {
        expect(
          messenger.calls.filter(
            (call) => call.method === "organization.refresh",
          ),
        ).toHaveLength(2);
      });
      fireEvent.click(screen.getByRole("button", { name: "Create group" }));
      await waitFor(() => {
        expect(
          messenger.calls.filter(
            (call) => call.method === "organization.command",
          ),
        ).toHaveLength(1);
      });

      expect(
        messenger.calls.map((call) => [
          call.method,
          call.authority.endpoint.hostId,
        ]),
      ).toEqual([
        ["organization.refresh", poolEntry.hostId],
        ["organization.refresh", poolEntry.hostId],
        ["organization.command", poolEntry.hostId],
      ]);
      expect(teamComputer.hostId).not.toBe(poolEntry.hostId);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("projects a personal serving computer's organization refresh into the real view", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    const currentManifest = accountWideManifestFixtures().current;
    recordNegotiatedHostMethods(personalComputer.hostId, [...currentManifest]);
    recordNegotiatedHostMethods(poolEntry.hostId, [
      "organization.command",
      "organization.refresh",
    ]);
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "viewer-1", userName: "Viewer", email: "viewer@example.com" },
        { userId: "viewer-1", username: "Viewer" },
        [],
      );
    useSelectionAuthorityStore.setState({
      attached: true,
      effectiveHostId: personalComputer.hostId,
      targetHostId: personalComputer.hostId,
      servingPeer: { kind: "computer", hostId: personalComputer.hostId },
    });
    const serving = readHostServingDecision((hostId) =>
      hostId === personalComputer.hostId ? personalComputer : null,
    );
    act(() => servingDecision.publish(serving));

    const personalView: OrganizationView = {
      catalog: [],
      groups: {
        version: "personal-refresh",
        groups: [
          {
            groupId: "personal-group",
            name: "Personal group",
            color: "#4488cc",
            position: 0,
          },
        ],
        memberships: [],
      },
      appearances: [],
      taskLabels: {},
      ready: true,
      authenticationRequired: false,
      pending: [],
      failures: [],
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "organization-personal-request",
      handlers: {
        "organization.refresh": () => personalView,
      },
    });
    const hosts = new Map<string, HostDirectoryEntry>([
      [poolEntry.hostId, poolEntry],
      [personalComputer.hostId, personalComputer],
    ]);
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hosts.get(hostId) ?? null,
      messenger,
      routing: {
        plan,
        selectedHostId: () => personalComputer.hostId,
        serving: () => servingDecision.get(),
      },
    });
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "fixture-token",
        identity: {
          userId: "viewer-1",
          username: "Viewer",
          providerHandle: "viewer",
        },
      }),
    );
    runtimeClient.current = client;
    runtimeBindingRef.current = Object.assign(Object.create(null), {
      hostClient: client,
    }) as HostRuntimeBinding<HostRpcRegistry>;

    const view = render(
      <QueryClientProvider client={queryClient}>
        <OrganizationProvider>
          <OrganizationGroupsProbe />
        </OrganizationProvider>
      </QueryClientProvider>,
    );

    try {
      await waitFor(() => {
        expect(
          messenger.calls.filter(
            (call) => call.method === "organization.refresh",
          ),
        ).toHaveLength(1);
        expect(screen.getByTestId("organization-groups").textContent).toBe(
          "Personal group",
        );
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh organization" }),
      );
      await waitFor(() => {
        expect(
          messenger.calls.filter(
            (call) => call.method === "organization.refresh",
          ),
        ).toHaveLength(2);
      });
      expect(
        messenger.calls.map((call) => [
          call.method,
          call.authority.endpoint.hostId,
        ]),
      ).toEqual([
        ["organization.refresh", personalComputer.hostId],
        ["organization.refresh", personalComputer.hostId],
      ]);
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });

  it("keeps the pool organization subscription open when the read answerer changes", async () => {
    const plan = settleProcessHostRpcTierPlan(poolEntry);
    recordNegotiatedHostMethods(personalComputer.hostId, [
      "organization.read",
      "organization.refresh",
      "organization.command",
    ]);
    recordNegotiatedHostMethods(poolEntry.hostId, [
      "organization.subscribe",
      "organization.refresh",
    ]);
    useAuthStore
      .getState()
      .setSignedIn(
        { userId: "viewer-1", userName: "Viewer", email: "viewer@example.com" },
        { userId: "viewer-1", username: "Viewer" },
        [],
      );
    useSelectionAuthorityStore.setState({
      attached: true,
      effectiveHostId: personalComputer.hostId,
      targetHostId: personalComputer.hostId,
      servingPeer: { kind: "computer", hostId: personalComputer.hostId },
    });
    const resolveServing = (hostId: string) =>
      hostId === personalComputer.hostId ? personalComputer : null;
    act(() => servingDecision.publish(readHostServingDecision(resolveServing)));

    const subscription = {
      close: vi.fn(),
      onServerFrame: vi.fn<(listener: (envelope: unknown) => void) => void>(),
    };
    const stream = {
      subscribe: vi.fn(() => subscription),
      subscribeAvailabilityRecovered: () => () => undefined,
    };
    routedStream.client = stream;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "organization-answerer-change-request",
      handlers: {
        "organization.refresh": () => ({
          catalog: [],
          groups: { version: "0", groups: [], memberships: [] },
          appearances: [],
          taskLabels: {},
          ready: true,
          authenticationRequired: false,
          pending: [],
          failures: [],
        }),
      },
    });
    const hosts = new Map<string, HostDirectoryEntry>([
      [poolEntry.hostId, poolEntry],
      [personalComputer.hostId, personalComputer],
    ]);
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => hosts.get(hostId) ?? null,
      messenger,
      routing: {
        plan,
        selectedHostId: () => personalComputer.hostId,
        serving: () => servingDecision.get(),
      },
    });
    client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "fixture-token",
        identity: {
          userId: "viewer-1",
          username: "Viewer",
          providerHandle: "viewer",
        },
      }),
    );
    runtimeClient.current = client;
    runtimeBindingRef.current = Object.assign(Object.create(null), {
      hostClient: client,
    }) as HostRuntimeBinding<HostRpcRegistry>;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <OrganizationProvider>
          <OrganizationGroupsProbe />
        </OrganizationProvider>
      </QueryClientProvider>,
    );

    try {
      await waitFor(() => {
        expect(
          messenger.calls.some(
            (call) => call.method === "organization.refresh",
          ),
        ).toBe(true);
        expect(stream.subscribe).toHaveBeenCalledTimes(1);
      });
      expect(stream.subscribe).toHaveBeenCalledWith("organization.subscribe", {
        taskIds: [],
      });

      act(() => {
        recordNegotiatedHostMethods(personalComputer.hostId, [
          "organization.refresh",
          "organization.command",
        ]);
        servingDecision.publish(readHostServingDecision(resolveServing));
      });

      await waitFor(() => {
        expect(servingDecision.get().servingPeerMethods).not.toBeNull();
      });
      expect(subscription.close).not.toHaveBeenCalled();
      expect(stream.subscribe).toHaveBeenCalledTimes(1);
      const deliverFrame = subscription.onServerFrame.mock.calls.at(0)?.[0];
      if (deliverFrame === undefined)
        throw new Error("organization frame listener missing");
      act(() => {
        deliverFrame({
          kind: "snapshot",
          hasBinaryPayload: false,
          view: {
            catalog: [],
            groups: {
              version: "1",
              groups: [
                {
                  groupId: "moved-frame",
                  name: "Moved frame",
                  color: "#4488cc",
                  position: 0,
                },
              ],
              memberships: [],
            },
            appearances: [],
            taskLabels: {},
            ready: true,
            authenticationRequired: false,
            pending: [],
            failures: [],
          } satisfies OrganizationView,
        });
      });
      await waitFor(() =>
        expect(screen.getByTestId("organization-groups").textContent).toBe(
          "Moved frame",
        ),
      );
    } finally {
      view.unmount();
      client.dispose();
      queryClient.clear();
    }
  });
});
