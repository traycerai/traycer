import "fake-indexeddb/auto";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { createIndexedDbViewReplicaBackend } from "@traycer-clients/shared/view-replica/indexeddb-backend";
import { ViewReplicaStore } from "@traycer-clients/shared/view-replica/store";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import {
  historyReplicaAddress,
  historyReplicaService,
} from "@/lib/view-replica/history-replica";
import {
  VIEW_REPLICA_DB_NAME,
  viewReplicaStore,
} from "@/lib/view-replica/view-replica-store";
import {
  historyPage,
  taskIds,
  taskLight,
} from "@/lib/view-replica/__tests__/replica-fixtures";

const HOST_ID = "host-test";
const USER_ID = "user-test";

type PendingRequest = (
  method: string,
  params: unknown,
) => Promise<ListTasksResponse>;

const mockHostClient = {
  getActiveHostId: vi.fn(() => HOST_ID),
  getRequestContextUserId: vi.fn(() => USER_ID),
  onChange: vi.fn(() => () => undefined),
  request: vi.fn<PendingRequest>(),
  requestWithSignal: vi.fn(
    (method: string, params: unknown): Promise<ListTasksResponse> =>
      mockHostClient.request(method, params),
  ),
  requestWithSignalRequiringHostMethodVersion: vi.fn(
    (method: string, params: unknown): Promise<ListTasksResponse> =>
      mockHostClient.request(method, params),
  ),
};

vi.mock("@/lib/host", () => ({
  useHostClient: () => mockHostClient,
  useHostRuntimeClient: () => mockHostClient,
  useHostBinding: () => ({
    hostId: HOST_ID,
    hostClient: {
      ...mockHostClient,
      createRequesterForHostId: () => mockHostClient,
    },
  }),
}));

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

/** A previous session's replica: written to the database, not to this memory. */
async function seedPreviousSession(): Promise<void> {
  const previous = new ViewReplicaStore(
    createIndexedDbViewReplicaBackend(
      () => globalThis.indexedDB,
      VIEW_REPLICA_DB_NAME,
    ),
  );
  await previous.warm(USER_ID);
  const address = historyReplicaAddress(
    USER_ID,
    HOST_ID,
    LIST_CLOUD_TASKS_REQUEST,
  );
  if (address === null) throw new Error("Expected a History address");
  previous.write(
    historyReplicaService,
    address,
    historyPage([taskLight("cached-one", null), taskLight("cached-two", null)]),
    { observedAt: 100, sourceGeneration: null },
  );
  await previous.drain();
}

describe("useCloudEpicTasksQuery with the replica tier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The serving tier never answers: the pool is unreachable.
    mockHostClient.request.mockImplementation(() => new Promise(() => undefined));
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: USER_ID, userName: "Test", email: "t@example.com" },
      contextMetadata: { userId: USER_ID, username: "test-user" },
      shareableTeams: [],
      subscriptionStatus: null,
    });
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
  });

  afterEach(async () => {
    cleanup();
    resetNegotiatedManifests();
    await viewReplicaStore.evict({ kind: "identity-retired" });
  });

  it("paints the cached History rows once the replica is warm, with no answer from the serving tier", async () => {
    await seedPreviousSession();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useCloudEpicTasksQuery(LIST_CLOUD_TASKS_REQUEST, { enabled: true }),
      { wrapper: makeWrapper(queryClient) },
    );
    expect(result.current.tasks).toEqual([]);

    await act(async () => {
      await viewReplicaStore.warm(USER_ID);
    });

    await waitFor(() => {
      expect(
        taskIds({ tasks: [...result.current.tasks], hasMore: false }),
      ).toEqual(["cached-one", "cached-two"]);
    });
  });
});
