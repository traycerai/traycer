import type { QueryClient } from "@tanstack/react-query";
import { hostRpcRegistry } from "@traycer/protocol/host";
import type { HostRpcRegistry } from "@traycer/protocol/host";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  poolEntry,
  remoteEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  cloudEpicTasksQueryKey,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import {
  directHistoryGrant,
  poolListedTaskAt16,
  settledPoolPageAt16,
} from "@/lib/history-composition/test-support/history-wire-fixtures";
import { updateEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { useAuthStore } from "@/stores/auth/auth-store";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

export const TITLE_TEST_USER_ID = "task-title-test-user";
export const TITLE_TEST_HOME_HOST_ID = "task-title-test-home";
export const TITLE_TEST_PINNED_HOST_ID = "task-title-test-pinned";

const TITLE_UPDATE_METHODS = {
  "epic.updateTitle": { major: 1, minor: 0 },
} as const;

export function createTitleRequesterFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const entries = new Map<string, HostDirectoryEntry>([
    [POOL_HOST_ID, poolEntry],
    [TITLE_TEST_HOME_HOST_ID, remoteEntry(TITLE_TEST_HOME_HOST_ID, null)],
    [TITLE_TEST_PINNED_HOST_ID, remoteEntry(TITLE_TEST_PINNED_HOST_ID, null)],
  ]);
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "task-title-request",
    handlers: { "epic.updateTitle": () => ({ updated: true }) },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    schedulingPolicy: hostRpcSchedulingPolicy,
    findHostById: (hostId) => entries.get(hostId) ?? null,
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "task-title-test-bearer",
      identity: {
        userId: TITLE_TEST_USER_ID,
        username: "Task title test user",
        providerHandle: null,
      },
    }),
  );
  for (const hostId of entries.keys()) {
    recordNegotiatedHostManifest(hostId, TITLE_UPDATE_METHODS);
  }
  return { client, messenger };
}

export function mountPoolServingWithHomeOffline(): void {
  const authority = mountTestSelectionAuthority({
    hosts: [],
    localHostId: TITLE_TEST_HOME_HOST_ID,
    pool: "ready",
  });
  if (authority.snapshot().servingPeer?.kind !== "pool") {
    throw new Error("The offline home fixture must be served by the pool");
  }
}

export function seedPoolCloudHistoryRow(
  queryClient: QueryClient,
  epicId: string,
): void {
  queryClient.setQueryData(
    cloudEpicTasksQueryKey(
      POOL_HOST_ID,
      TITLE_TEST_USER_ID,
      LIST_CLOUD_TASKS_REQUEST,
    ),
    settledPoolPageAt16(
      [
        poolListedTaskAt16({
          id: epicId,
          title: "Task title",
          grant: directHistoryGrant("owner", TITLE_TEST_USER_ID),
          pinned: false,
          updatedAt: 1,
        }),
      ],
      { hasMore: false, nextCursor: undefined },
      TITLE_TEST_USER_ID,
    ),
  );
}

export function titleUpdateCalls(
  messenger: MockHostMessenger<HostRpcRegistry>,
): ReadonlyArray<{
  readonly hostId: string;
  readonly epicId: string | undefined;
  readonly title: string | undefined;
}> {
  return messenger.calls
    .filter((call) => call.method === "epic.updateTitle")
    .map((call) => {
      const epicDelta = updateEpicRequestSchema.parse(call.params).epicDelta;
      if (epicDelta === null) throw new Error("Expected a task title delta");
      return {
        hostId: call.authority.endpoint.hostId,
        epicId: epicDelta.id,
        title: epicDelta.title,
      };
    });
}

export function signInTaskTitleTestUser(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: TITLE_TEST_USER_ID,
      userName: "Task title test user",
      email: "task-title@example.invalid",
    },
    { userId: TITLE_TEST_USER_ID, username: "Task title test user" },
    [],
  );
}

export function resetTitleRequesterFixture(): void {
  useSelectionAuthorityStore.getState().reset();
  useAuthStore.getState().setSignedOut();
  resetNegotiatedManifests();
}
