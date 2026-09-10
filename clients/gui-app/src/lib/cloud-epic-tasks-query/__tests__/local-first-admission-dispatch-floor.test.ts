import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  HostMethodVersionUnsatisfiedError,
  type IHostMessenger,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
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
 * An unverified session may send exactly one cloud-shaped page: the local-first
 * initial leg, and only to a host that honours the `localFirstPhase` directive.
 * A pre-`@1.6` host parses that field against a frozen request schema, STRIPS
 * it, and runs the released cloud-backed list on the retained credential - the
 * spend the admission exists to prevent, under a flag the host discarded.
 *
 * The version fact and the request are two different connections, and this
 * pins that the leg no longer tries to bridge that gap on this side. It used to
 * probe `host.status` to force a handshake and decide on what that wrote, which
 * narrows the window without closing it: probe and page are separate dials, and
 * the host can be replaced between them. So the floor now RIDES ON the request
 * and the transport answers it from the connection carrying the frame
 * (`ws-rpc-client.test.ts` pins the enforcement itself).
 *
 * What is pinnable here is therefore propagation, and it is worth pinning
 * separately: a floor the caller forgets to attach is silently no floor at all,
 * and every transport-level test still passes.
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
 * A client whose MESSENGER rejects, which is where a floor refusal is actually
 * decided. Deliberately not a `MockHostMessenger` handler: the mock re-stamps a
 * thrown `HostRpcError` into a fresh base-class instance to correct its
 * requestId, so a subclass thrown from a handler arrives as a plain
 * `HostRpcError` and an `instanceof` pin on it would fail for a reason that
 * exists only in the fixture. The real refusal never reaches a resolver at all.
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

function fetchInitialLeg(): Promise<ListTasksResponse> {
  return fetchCloudEpicTasksFirstPageByHostId(HOST_ID, USER_ID, {
    request: LIST_CLOUD_TASKS_REQUEST,
    abortSignal: undefined,
    localFirstPhase: "initial",
    requestContextPolicy: "require-current",
  });
}

beforeEach(() => {
  resetNegotiatedManifests();
  // The retained evidence a render-time read would admit on. Every case below
  // leaves it in place, so nothing here passes merely because the registry was
  // empty - the question is whether the DISPATCH still depends on it.
  recordNegotiatedHostManifest(HOST_ID, {
    "epic.listTasks": { major: 1, minor: 6 },
  });
});

afterEach(() => {
  resetNegotiatedManifests();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("the local-first initial leg's dispatch-time version floor", () => {
  it("attaches the `epic.listTasks@1.6` floor to the request itself when the session is unverified", async () => {
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    const fixture = createFixture({
      listTasks: () => ({ tasks: [], hasMore: false }),
    });

    await expect(fetchInitialLeg()).resolves.toEqual({
      tasks: [],
      hasMore: false,
    });

    expect(fixture.messenger.calls).toHaveLength(1);
    expect(fixture.messenger.calls[0]?.method).toBe("epic.listTasks");
    expect(fixture.messenger.calls[0]?.requiredHostMethodVersion).toEqual({
      method: "epic.listTasks",
      version: { major: 1, minor: 6 },
    });
  });

  it("sends NO floor for a signed-in session - the capability is authorized whatever the peer's minor is", async () => {
    // The control. Without it, a floor attached unconditionally would satisfy
    // the assertion above while quietly making every signed-in list refusable
    // on an older host.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const fixture = createFixture({
      listTasks: () => ({ tasks: [], hasMore: false }),
    });

    await expect(fetchInitialLeg()).resolves.toEqual({
      tasks: [],
      hasMore: false,
    });

    expect(fixture.messenger.calls[0]?.requiredHostMethodVersion).toBeNull();
  });

  it("reports the transport's floor refusal as a withdrawn verdict, not as a transport failure", async () => {
    // Where the refusal is DECIDED moved into the transport; where it is
    // HANDLED must not. `query-client.ts` suppresses retries and the error
    // toast for this type by name - a raw `HostMethodVersionUnsatisfiedError`
    // would instead retry into the same downgraded host and surface as a
    // failure the reader cannot act on.
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    createFixtureRejectingWith(
      new HostMethodVersionUnsatisfiedError({
        requirement: {
          method: "epic.listTasks",
          version: { major: 1, minor: 6 },
        },
        negotiated: { major: 1, minor: 5 },
        requestId: "req-dispatch-floor",
        method: "epic.listTasks",
        hostId: HOST_ID,
      }),
    );

    await expect(fetchInitialLeg()).rejects.toBeInstanceOf(
      CloudEpicTasksVerdictWithdrawnError,
    );
  });

  it("lets an unrelated dispatch failure through unchanged", async () => {
    // The second control: the `catch` re-shapes ONE type. Collapsing every
    // failure into a withdrawn verdict would silence real host errors on the
    // one page an unverified session sends.
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    createFixtureRejectingWith(new Error("host exploded (test)"));

    await expect(fetchInitialLeg()).rejects.toThrow("host exploded (test)");
  });
});
