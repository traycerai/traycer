import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { ListTasksResponse } from "@traycer/protocol/host/epic/unary-schemas";
import { createAppQueryClient } from "@/lib/query-client";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  fetchCloudEpicTasksFirstPageByHostId,
  registerCloudEpicTasksClient,
  LIST_CLOUD_TASKS_REQUEST,
} from "@/lib/cloud-epic-tasks-query";
import { CloudEpicTasksVerdictWithdrawnError } from "@/lib/cloud-epic-tasks-query/verdict-withdrawn-error";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * The History first page spends the cloud only under a verdict, and the
 * verdict is read at DISPATCH, not at render. A session that is not `signed-in`
 * is refused before any list call leaves: there is no local-first initial leg
 * and no version floor for an unverified session any more - the host's local
 * rows reach History through its own `epic.localHistory.read` contribution, a
 * separate read that spends nothing.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const USER_ID = "user-a";
const PROFILE = { userId: USER_ID, userName: "A", email: "a@example.com" };
const CONTEXT = { userId: USER_ID, username: USER_ID };

function createFixture(options: {
  readonly listTasks: () => ListTasksResponse;
}): {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
} {
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-dispatch-floor",
    handlers: { "epic.listTasks": () => options.listTasks() },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(createAppQueryClient()),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: { userId: USER_ID, username: USER_ID, providerHandle: null },
      origin: "renderer",
    }),
  );
  registerCloudEpicTasksClient(
    HOST_ID,
    spine.createRequester(mockLocalHostEntry),
  );
  return { messenger };
}

/**
 * A client whose MESSENGER rejects every request, which is where a host
 * dispatch failure is actually decided. Deliberately not a
 * `MockHostMessenger` handler: the mock re-stamps a thrown `HostRpcError` into
 * a fresh base-class instance to correct its requestId, so the error that
 * arrives would not be the one thrown.
 */
function createFixtureRejectingWith(cause: Error): void {
  const rejecting: IHostMessenger<HostRpcRegistry> = {
    request: () => Promise.reject(cause),
    requestWithResponseTimeout: () => Promise.reject(cause),
  };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(createAppQueryClient()),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger: rejecting,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: { userId: USER_ID, username: USER_ID, providerHandle: null },
      origin: "renderer",
    }),
  );
  registerCloudEpicTasksClient(
    HOST_ID,
    spine.createRequester(mockLocalHostEntry),
  );
}

function fetchFirstPage(): Promise<ListTasksResponse> {
  return fetchCloudEpicTasksFirstPageByHostId(HOST_ID, USER_ID, {
    request: LIST_CLOUD_TASKS_REQUEST,
    abortSignal: undefined,
    localFirstPhase: undefined,
    requestContextPolicy: "require-current",
  });
}

afterEach(() => {
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("the History first page's dispatch-time cloud verdict", () => {
  it("refuses an unverified session before any list call is sent", async () => {
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    const fixture = createFixture({
      listTasks: () => ({ tasks: [], hasMore: false }),
    });

    await expect(fetchFirstPage()).rejects.toBeInstanceOf(
      CloudEpicTasksVerdictWithdrawnError,
    );

    expect(
      fixture.messenger.calls.filter(
        (call) => call.method === "epic.listTasks",
      ),
    ).toEqual([]);
  });

  it("sends the list call of a signed-in session with no version floor", async () => {
    // The control. Without it a refusal that fired for every session would
    // satisfy the case above, and a floor attached unconditionally would make
    // every signed-in list refusable on an older host.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const fixture = createFixture({
      listTasks: () => ({ tasks: [], hasMore: false }),
    });

    await expect(fetchFirstPage()).resolves.toMatchObject({
      tasks: [],
      hasMore: false,
    });

    const listCalls = fixture.messenger.calls.filter(
      (call) => call.method === "epic.listTasks",
    );
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.requiredHostMethodVersion).toBeNull();
  });

  it("lets an unrelated dispatch failure through unchanged", async () => {
    // The `catch` that re-shapes a refusal must not collapse real host errors
    // into a withdrawn verdict.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    createFixtureRejectingWith(new Error("host exploded (test)"));

    await expect(fetchFirstPage()).rejects.toThrow("host exploded (test)");
  });
});
