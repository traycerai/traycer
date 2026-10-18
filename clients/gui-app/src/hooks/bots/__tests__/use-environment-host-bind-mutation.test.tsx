/**
 * Binding or unbinding a machine (Tracy Bots) changes which machines an
 * environment lists, and that list is the same through every host. So the
 * bind's success refreshes `environment.host.list` on every host scope, not
 * only the host the bind was sent to: a list read through host A, held by
 * Settings or Home, follows a bind made through host B.
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
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  EnvironmentHostBinding,
  EnvironmentHostRecord,
} from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useEnvironmentHostBindMutation } from "@/hooks/bots/use-environment-host-bind-mutation";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";

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

const TEAM_ID = "env-team";

const BINDING: EnvironmentHostBinding = {
  hostId: mockRemoteHostEntry.hostId,
  environment: {
    environmentId: TEAM_ID,
    ownerKind: "organization",
    ownerId: "team-1",
    roomId: "room-team",
    label: "Acme",
  },
  explicit: true,
  enrolledByUserId: "user-1",
  canUnbind: true,
};

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

/**
 * One host: its own messenger, answering `environment.host.list` with whatever
 * machines the shared cloud-backed state holds at that moment, and counting
 * the list reads it served.
 */
function hostOver(
  entry: HostDirectoryEntry,
  queryClient: QueryClient,
  cloudMachines: { current: ReadonlyArray<EnvironmentHostRecord> },
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly listReads: () => number;
} {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `${entry.hostId}-${String(++seq)}`,
    handlers: {
      "environment.host.list": () => ({ hosts: [...cloudMachines.current] }),
      "environment.host.bind": () => {
        cloudMachines.current = [
          ...cloudMachines.current,
          machine(BINDING.hostId),
        ];
        return BINDING;
      },
    },
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
  return {
    client: spine.createRequester(entry),
    listReads: () =>
      messenger.calls.filter((call) => call.method === "environment.host.list")
        .length,
  };
}

describe("useEnvironmentHostBindMutation", () => {
  it("refreshes an environment's machine list read through another host", async () => {
    const queryClient = new QueryClient();
    const cloudMachines: { current: ReadonlyArray<EnvironmentHostRecord> } = {
      current: [machine("host-already-bound")],
    };
    const hostA = hostOver(mockLocalHostEntry, queryClient, cloudMachines);
    const hostB = hostOver(mockRemoteHostEntry, queryClient, cloudMachines);
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        lists: useEnvironmentHostLists(hostA.client, [TEAM_ID], true),
        bind: useEnvironmentHostBindMutation(
          hostB.client,
          mockRemoteHostEntry.hostId,
        ),
      }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.lists.get(TEAM_ID)).toHaveLength(1);
    });
    expect(hostA.listReads()).toBe(1);

    await act(async () => {
      await result.current.bind.mutateAsync({ environmentId: TEAM_ID });
    });

    await waitFor(() => {
      expect(result.current.lists.get(TEAM_ID)).toHaveLength(2);
    });
    expect(hostA.listReads()).toBe(2);
    expect(
      result.current.lists.get(TEAM_ID)?.map((record) => record.hostId),
    ).toEqual(["host-already-bound", BINDING.hostId]);
  });
});
