import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ListTasksRequest,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { registerCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { epicTabLocalHomeListQueryOptions } from "@/lib/cloud-epic-tasks-query/reconciler-local-home-query";
import { CloudEpicTasksVerdictWithdrawnError } from "@/lib/cloud-epic-tasks-query/verdict-withdrawn-error";
import { useAuthStore } from "@/stores/auth/auth-store";

const USER_A = "user-a";
const USER_B = "user-b";

const USER_A_PROFILE = {
  userId: USER_A,
  userName: "User A",
  email: "a@example.com",
};
const USER_A_CONTEXT = { userId: USER_A, username: USER_A };

const LOCAL_HOME_PARAMS: ListTasksRequest = {
  limit: 100,
  filters: { taskType: "epic" },
  extensionPhaseVersion: "1",
  extensionEpicVersion: "1",
};

function requestContextFor(userId: string) {
  return createRequestContextFixture({
    identity: { userId, username: userId, providerHandle: null },
    origin: "renderer",
  });
}

function createFixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let dispatchCount = 0;
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "reconciler-local-home",
      handlers: {
        "epic.listTasks": (): ListTasksResponse => {
          dispatchCount += 1;
          return { tasks: [], hasMore: false };
        },
      },
    }),
  });
  spine.setRequestContext(requestContextFor(USER_A));
  const client = spine.createRequester(mockLocalHostEntry);
  registerCloudEpicTasksClient(mockLocalHostEntry.hostId, client);
  const options = epicTabLocalHomeListQueryOptions({
    hostId: mockLocalHostEntry.hostId,
    userId: USER_A,
    params: LOCAL_HOME_PARAMS,
    cacheKeyIdentity: `${mockLocalHostEntry.hostId}:${USER_A}:1`,
  });
  return {
    client: spine,
    dispatchCount: () => dispatchCount,
    options,
    queryClient,
  };
}

describe("epicTabLocalHomeListQueryOptions", () => {
  // The reconciler seeds a run only under `signed-in`, so that is the verdict
  // a probe dispatches under; the fetcher re-reads it at dispatch.
  beforeEach(() => {
    useAuthStore.getState().setSignedIn(USER_A_PROFILE, USER_A_CONTEXT, []);
  });
  afterEach(() => {
    useAuthStore.getState().setSignedOut();
  });

  it("dispatches a current reconciliation run through the shared scoped primitive", async () => {
    const fixture = createFixture();

    await expect(
      fixture.queryClient.fetchQuery(fixture.options),
    ).resolves.toEqual({ tasks: [], hasMore: false });

    expect(fixture.dispatchCount()).toBe(1);
  });

  it("cannot dispatch or cache B's local-home page under an A reconciliation key", async () => {
    const fixture = createFixture();
    // The reconciliation run already captured A's cache identity. The live
    // requester rotates before TanStack invokes its query function: generic
    // useHostQuery used to send B's result into that A-keyed cache slot.
    fixture.client.setRequestContext(requestContextFor(USER_B));

    await expect(
      fixture.queryClient.fetchQuery(fixture.options),
    ).rejects.toThrow("request context no longer matches its cache user");

    expect(fixture.dispatchCount()).toBe(0);
    expect(
      fixture.queryClient.getQueryData<ListTasksResponse>(
        fixture.options.queryKey,
      ),
    ).toBeUndefined();
    expect(
      fixture.queryClient.getQueryState(fixture.options.queryKey)?.status,
    ).toBe("error");
  });

  it("refuses the probe without dispatching once the cloud verdict is withdrawn mid-run", async () => {
    const fixture = createFixture();
    // The run was seeded under `signed-in`; the session demotes before
    // TanStack invokes the query function. The probe carries no local-first
    // directive, so without a verdict it would be the cloud-backed list on
    // the retained bearer. The reconciler's combiner reads the error as
    // "close nothing", which is the fail-closed outcome this path wants.
    useAuthStore
      .getState()
      .setUnverifiedSession(USER_A_PROFILE, USER_A_CONTEXT);

    await expect(
      fixture.queryClient.fetchQuery(fixture.options),
    ).rejects.toBeInstanceOf(CloudEpicTasksVerdictWithdrawnError);

    expect(fixture.dispatchCount()).toBe(0);
    expect(
      fixture.queryClient.getQueryState(fixture.options.queryKey)?.status,
    ).toBe("error");
  });
});
