import { createElement, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import {
  poolHostDirectoryEntry,
  POOL_HOST_ID,
} from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { ListEpicCollaboratorsResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicCollaboratorsQuery } from "@/hooks/epics/use-epic-collaborators-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { readAppServingDecision } from "@/lib/host/app-serving-decision";

const EPIC_ID = "shared-task";
const METHOD = "epic.listCollaborators" as const;
const clients: QueryClient[] = [];

function collaboratorResponse(label: string): ListEpicCollaboratorsResponse {
  return {
    collaborators: [
      {
        accessType: "direct",
        grantedAt: 1,
        grantedBy: "task-owner",
        role: "editor",
        user: {
          userId: `user-${label}`,
          profile: {
            avatarUrl: "",
            displayName: label,
            email: `${label}@example.test`,
            handle: label,
          },
        },
        environmentId: null,
        team: null,
      },
    ],
    collaboratorsAvailable: true,
  };
}

function nextCollaboratorsRequest(
  messenger: MockHostMessenger<HostRpcRegistry>,
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = messenger.subscribe((event) => {
      if (event.kind !== "request" || event.method !== METHOD) return;
      unsubscribe();
      resolve();
    });
  });
}

function requestContext(userId: string) {
  return createRequestContextFixture({
    identity: { userId, username: userId, providerHandle: null },
    bearerToken: `synthetic-bearer-${userId}`,
    origin: "renderer",
  });
}

interface Harness {
  readonly queryClient: QueryClient;
  readonly rootClient: HostClient<HostRpcRegistry>;
  client: HostRequester<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  setViewer(userId: string): void;
  setPeer(peer: "computer" | "pool"): void;
}

function createHarness(
  initialViewer: string,
  initialPeer: "computer" | "pool",
  answer: () =>
    | ListEpicCollaboratorsResponse
    | Promise<ListEpicCollaboratorsResponse>,
): Harness {
  const poolEntry = poolHostDirectoryEntry("wss://pool.test/rpc");
  if (poolEntry === null) throw new Error("Expected a pool peer");
  const plan = settleProcessHostRpcTierPlan(poolEntry);
  recordNegotiatedHostMethods(POOL_HOST_ID, [METHOD]);
  const queryClient = createAppQueryClient();
  clients.push(queryClient);
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: {
      ...queryClient.getDefaultOptions().queries,
      retry: false,
      retryDelay: 0,
    },
    mutations: { retry: false },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "collaborator-request",
    handlers: { [METHOD]: () => answer() },
  });
  const rootClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => {
      if (hostId === mockLocalHostEntry.hostId) return mockLocalHostEntry;
      if (hostId === POOL_HOST_ID) return poolEntry;
      return null;
    },
    messenger,
    routing: {
      plan,
      selectedHostId: () => mockLocalHostEntry.hostId,
      serving: readAppServingDecision,
    },
  });
  const client = rootClient.createRequester(
    initialPeer === "computer" ? mockLocalHostEntry : poolEntry,
  );
  const harness: Harness = {
    queryClient,
    rootClient,
    client,
    messenger,
    setViewer(userId) {
      useAuthStore.setState({
        status: "signed-in",
        contextMetadata: { userId, username: userId },
      });
      rootClient.setRequestContext(requestContext(userId));
    },
    setPeer(peer) {
      harness.client = rootClient.createRequester(
        peer === "computer" ? mockLocalHostEntry : poolEntry,
      );
    },
  };
  harness.setViewer(initialViewer);
  return harness;
}

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
}

function mount(harness: Harness) {
  return renderHook(
    () =>
      useEpicCollaboratorsQuery(EPIC_ID, {
        client: harness.client,
        enabled: true,
        poll: false,
        staleTime: 30_000,
      }),
    { wrapper: wrapperFor(harness.queryClient) },
  );
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  for (const client of clients.splice(0)) client.clear();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("collaborator query account scope", () => {
  it("retains same-key rows through a transient failure and withholds them after access refusal", async () => {
    let failure: "transient" | "access-refused" | null = null;
    const harness = createHarness("account-a", "pool", () => {
      if (failure === "transient") {
        throw new HostRpcError({
          code: "E_CLOUD_REQUEST_REFUSED",
          requestId: "collaborator-request",
          method: METHOD,
          message: "synthetic transient failure",
          fatalDetails: null,
        });
      }
      if (failure === "access-refused") {
        throw new HostRpcError({
          code: "FORBIDDEN",
          requestId: "collaborator-request",
          method: METHOD,
          message: "synthetic access refusal",
          fatalDetails: null,
        });
      }
      return collaboratorResponse("account-a");
    });
    const hook = mount(harness);
    await waitFor(() => {
      expect(hook.result.current.data?.directUsers[0]?.email).toBe(
        "account-a@example.test",
      );
    });

    failure = "transient";
    const transientRequest = nextCollaboratorsRequest(harness.messenger);
    await act(async () => {
      await hook.result.current.query.refetch();
    });
    await transientRequest;

    await waitFor(() => {
      expect(hook.result.current.query.error?.code).toBe(
        "E_CLOUD_REQUEST_REFUSED",
      );
    });
    expect(hook.result.current.isError).toBe(true);
    expect(hook.result.current.error?.code).toBe("E_CLOUD_REQUEST_REFUSED");
    expect(hook.result.current.data?.directUsers[0]?.email).toBe(
      "account-a@example.test",
    );

    failure = "access-refused";
    const refusalRequest = nextCollaboratorsRequest(harness.messenger);
    await act(async () => {
      await hook.result.current.query.refetch();
    });
    await refusalRequest;

    await waitFor(() => {
      expect(hook.result.current.query.error?.code).toBe("FORBIDDEN");
    });
    expect(hook.result.current.isError).toBe(true);
    expect(hook.result.current.error?.code).toBe("FORBIDDEN");
    expect(hook.result.current.data).toBeUndefined();
  });

  it("drops account A rows as account B's answer is pending, then shows B's rows", async () => {
    let currentAnswer: () =>
      | ListEpicCollaboratorsResponse
      | Promise<ListEpicCollaboratorsResponse> = () =>
      collaboratorResponse("account-a");
    const harness = createHarness("account-a", "pool", () => currentAnswer());
    const hook = mount(harness);
    await waitFor(() => {
      expect(hook.result.current.data?.directUsers[0]?.email).toBe(
        "account-a@example.test",
      );
    });

    let resolveAccountB: (
      response: ListEpicCollaboratorsResponse,
    ) => void = () => undefined;
    const accountBAnswer = new Promise<ListEpicCollaboratorsResponse>(
      (resolve) => {
        resolveAccountB = resolve;
      },
    );
    currentAnswer = () => accountBAnswer;
    const secondRequest = nextCollaboratorsRequest(harness.messenger);
    act(() => {
      harness.setViewer("account-b");
      hook.rerender();
    });

    expect(hook.result.current.data).toBeUndefined();
    await secondRequest;
    act(() => {
      resolveAccountB(collaboratorResponse("account-b"));
    });
    await waitFor(() => {
      expect(hook.result.current.data?.directUsers[0]?.email).toBe(
        "account-b@example.test",
      );
    });
  });

  it("does not project account A rows when account B's collaborator read is refused", async () => {
    let refuse = false;
    const harness = createHarness("account-a", "pool", () => {
      if (!refuse) return collaboratorResponse("account-a");
      throw new HostRpcError({
        code: "E_CLOUD_REQUEST_REFUSED",
        requestId: "collaborator-request",
        method: METHOD,
        message: "synthetic access refusal",
        fatalDetails: null,
      });
    });
    const hook = mount(harness);
    await waitFor(() => {
      expect(hook.result.current.data?.directUsers[0]?.email).toBe(
        "account-a@example.test",
      );
    });

    refuse = true;
    act(() => {
      harness.setViewer("account-b");
      hook.rerender();
    });
    expect(hook.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(hook.result.current.isError).toBe(true);
    });
    expect(hook.result.current.data).toBeUndefined();
    expect(
      harness.messenger.calls.at(-1)?.authority.bearer.identity.userId,
    ).toBe("account-b");
  });

  it("drops computer rows while the same account switches to the pool peer", async () => {
    let resolvePoolAnswer: (
      response: ListEpicCollaboratorsResponse,
    ) => void = () => undefined;
    let currentAnswer: () =>
      | ListEpicCollaboratorsResponse
      | Promise<ListEpicCollaboratorsResponse> = () =>
      collaboratorResponse("computer-peer");
    const harness = createHarness("account-a", "computer", () =>
      currentAnswer(),
    );
    const hook = mount(harness);
    await waitFor(() => {
      expect(hook.result.current.data?.directUsers[0]?.email).toBe(
        "computer-peer@example.test",
      );
    });

    const poolAnswer = new Promise<ListEpicCollaboratorsResponse>((resolve) => {
      resolvePoolAnswer = resolve;
    });
    currentAnswer = () => poolAnswer;
    const poolRequest = nextCollaboratorsRequest(harness.messenger);
    act(() => {
      harness.setPeer("pool");
      hook.rerender();
    });

    expect(hook.result.current.data).toBeUndefined();
    await poolRequest;
    expect(harness.messenger.calls.at(-1)?.authority.endpoint.hostId).toBe(
      POOL_HOST_ID,
    );
    act(() => {
      resolvePoolAnswer(collaboratorResponse("pool-peer"));
    });
    await waitFor(() => {
      expect(hook.result.current.data?.directUsers[0]?.email).toBe(
        "pool-peer@example.test",
      );
    });
  });
});
