/**
 * Binding or unbinding a machine (Tracy Bots) changes which machines an
 * environment lists, and that list is the same through every host. So the
 * bind's success refreshes `environment.host.list` on every host scope, not
 * only the host the bind was sent to: a list read through host A, held by
 * Settings or Home, follows a bind made through host B. Only the environments
 * the machine leaves and joins refresh; another team's list does not.
 *
 * Real hooks over two hosts' mock messengers sharing one query client.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EnvironmentDescriptor,
  EnvironmentHostBinding,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useEnvironmentHostBindMutation } from "@/hooks/bots/use-environment-host-bind-mutation";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEnvironmentHostReadQuery } from "@/hooks/bots/use-environment-host-read-query";

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const BOUND_HOST_ID = mockRemoteHostEntry.hostId;

function team(environmentId: string): EnvironmentDescriptor {
  return {
    environmentId,
    ownerKind: "organization",
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label: environmentId,
  };
}

const OLD = team("env-old");
const NEW = team("env-new");
const UNRELATED = team("env-unrelated");
const PERSONAL: EnvironmentDescriptor = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-1",
  roomId: "room-personal",
  label: "Personal",
};
const ENVIRONMENTS: ReadonlyArray<EnvironmentDescriptor> = [
  OLD,
  NEW,
  UNRELATED,
  PERSONAL,
];
/** The team lists host A observes throughout. */
const OBSERVED: ReadonlyArray<EnvironmentDescriptor> = [OLD, NEW, UNRELATED];

function bindingTo(environment: EnvironmentDescriptor): EnvironmentHostBinding {
  return {
    hostId: BOUND_HOST_ID,
    environment,
    explicit: environment.ownerKind === "organization",
    enrolledByUserId: "user-1",
    canUnbind: true,
  };
}

function machine(hostId: string): EnvironmentHostRecord {
  return {
    hostId,
    hostLabel: hostId,
    hostPlatform: null,
    enrolledByUserId: "user-1",
    kind: "personal",
    boundAt: 1,
  };
}

interface BindScenario {
  /** Host B is bound to {@link OLD} before the bind. */
  readonly destination: EnvironmentDescriptor;
  /** Whether B's `environment.host.read` answer is in the cache. */
  readonly readCached: boolean;
  /** Whether `previous`'s cached list names B. */
  readonly listNamesHost: boolean;
}

/**
 * Two hosts over one cloud-backed state. Host A answers `environment.host.list`
 * and counts the reads per environment; host B answers the read and the bind,
 * and a bind moves its machine between the cloud's lists.
 */
async function mountBindScenario(scenario: BindScenario): Promise<{
  readonly bind: () => Promise<void>;
  readonly listReads: () => Readonly<Record<string, number>>;
  readonly hostIdsListed: (environmentId: string) => ReadonlyArray<string>;
}> {
  const queryClient = new QueryClient();
  const machines = new Map<string, ReadonlyArray<EnvironmentHostRecord>>([
    [
      OLD.environmentId,
      scenario.listNamesHost
        ? [machine("host-other-old"), machine(BOUND_HOST_ID)]
        : [machine("host-other-old")],
    ],
    [NEW.environmentId, [machine("host-other-new")]],
    [UNRELATED.environmentId, [machine("host-other-unrelated")]],
  ]);
  let boundTo = bindingTo(OLD);
  const reads: Record<string, number> = {};

  const hostA = hostOver(mockLocalHostEntry, queryClient, {
    "environment.host.list": ({ environmentId }) => {
      reads[environmentId] = (reads[environmentId] ?? 0) + 1;
      return { hosts: [...(machines.get(environmentId) ?? [])] };
    },
  });
  const hostB = hostOver(mockRemoteHostEntry, queryClient, {
    "environment.host.read": () => boundTo,
    "environment.host.bind": ({ environmentId }) => {
      const destination = ENVIRONMENTS.find(
        (environment) => environment.environmentId === environmentId,
      );
      if (destination === undefined) throw new Error("unknown environment");
      for (const [id, hosts] of machines) {
        machines.set(
          id,
          hosts.filter((host) => host.hostId !== BOUND_HOST_ID),
        );
      }
      if (destination.ownerKind === "organization") {
        machines.set(environmentId, [
          ...(machines.get(environmentId) ?? []),
          machine(BOUND_HOST_ID),
        ]);
      }
      boundTo = bindingTo(destination);
      return boundTo;
    },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );

  const { result } = renderHook(
    () => ({
      lists: useEnvironmentHostLists(
        hostA,
        OBSERVED.map((environment) => environment.environmentId),
        true,
      ),
      read: useEnvironmentHostReadQuery(hostB, scenario.readCached),
      bind: useEnvironmentHostBindMutation(hostB, BOUND_HOST_ID),
    }),
    { wrapper },
  );
  await waitFor(() => {
    expect(result.current.lists.size).toBe(OBSERVED.length);
  });
  if (scenario.readCached) {
    await waitFor(() => {
      expect(result.current.read.data).toEqual(boundTo);
    });
  }
  return {
    bind: async () => {
      await act(async () => {
        await result.current.bind.mutateAsync({
          environmentId: scenario.destination.environmentId,
        });
      });
    },
    listReads: () => ({ ...reads }),
    hostIdsListed: (environmentId) =>
      (result.current.lists.get(environmentId) ?? []).map(
        (record) => record.hostId,
      ),
  };
}

/**
 * One host: its own messenger over the handlers it is given, sharing the query
 * client with the other host.
 */
function hostOver(
  entry: HostDirectoryEntry,
  queryClient: QueryClient,
  handlers: MockHandlerMap<HostRpcRegistry>,
): HostClient<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `${entry.hostId}-${String(++seq)}`,
    handlers,
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(entry);
}

describe("useEnvironmentHostBindMutation", () => {
  it.each<{ readonly name: string; readonly scenario: BindScenario }>([
    {
      name: "moves a machine between teams: both lists refresh, another team's does not",
      scenario: {
        destination: NEW,
        readCached: true,
        listNamesHost: true,
      },
    },
    {
      name: "unbinds a machine to the personal environment: the team it left refreshes",
      scenario: {
        destination: PERSONAL,
        readCached: true,
        listNamesHost: true,
      },
    },
    {
      name: "finds the team a machine leaves from a cached list alone",
      scenario: {
        destination: NEW,
        readCached: false,
        listNamesHost: true,
      },
    },
    {
      name: "finds the team a machine leaves from its cached binding alone",
      scenario: {
        destination: NEW,
        readCached: true,
        listNamesHost: false,
      },
    },
  ])("$name", async ({ scenario }) => {
    const mounted = await mountBindScenario(scenario);
    const unchanged = Object.fromEntries(
      OBSERVED.map((environment) => [environment.environmentId, 1]),
    );
    expect(mounted.listReads()).toEqual(unchanged);

    await mounted.bind();

    const refreshed = [OLD, scenario.destination].map(
      (environment) => environment.environmentId,
    );
    await waitFor(() => {
      expect(mounted.listReads()).toMatchObject(
        Object.fromEntries(
          refreshed.filter((id) => id in unchanged).map((id) => [id, 2]),
        ),
      );
    });
    expect(mounted.listReads()).toEqual(
      Object.fromEntries(
        OBSERVED.map((environment) => [
          environment.environmentId,
          refreshed.includes(environment.environmentId) ? 2 : 1,
        ]),
      ),
    );
    expect(mounted.hostIdsListed(OLD.environmentId)).not.toContain(
      BOUND_HOST_ID,
    );
    if (scenario.destination.ownerKind === "organization") {
      expect(
        mounted.hostIdsListed(scenario.destination.environmentId),
      ).toContain(BOUND_HOST_ID);
    }
  });
});
