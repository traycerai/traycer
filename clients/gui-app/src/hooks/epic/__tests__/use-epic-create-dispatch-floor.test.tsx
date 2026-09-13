import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  CreateEpicRequest,
  CreateEpicResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useEpicCreateForClient } from "@/hooks/epic/use-epic-create-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * `epic.create` under an unverified session is admissible only on a host that
 * serves the local-first line, because `epic.create@1.0` on an older process is
 * the CLOUD-backed create, on the retained credential - and unlike the list
 * leg, what it leaves behind if it lands is an epic.
 *
 * `epic.create` advertises no version of its own, so the subject of the floor
 * is `epic.listTasks`: a host on the local-first list line is the host on the
 * local-first create line. That indirection is the reason the requirement
 * names its own method instead of being implied by the call.
 *
 * This pins propagation only; `ws-rpc-client.test.ts` pins that a floor is
 * actually enforced against the dispatching connection's handshake. Both halves
 * are needed - an unattached floor and an unenforced one look identical from
 * either side alone.
 */

const HOST_ID = mockLocalHostEntry.hostId;
const USER_ID = "user-1";
const PROFILE = { userId: USER_ID, userName: "A", email: "a@example.com" };
const CONTEXT = { userId: USER_ID, username: USER_ID };

const CREATE_VARIABLES: CreateEpicRequest = {
  epic: {
    id: "epic-1",
    title: "Epic",
    initialUserPrompt: "hi",
    ticketCount: 0,
    specCount: 0,
    storyCount: 0,
    reviewCount: 0,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    createdBy: USER_ID,
    version: "1",
  },
  repoIdentifiers: [],
  workspaces: [],
  chat: null,
};

const CREATE_RESPONSE: CreateEpicResponse = {
  roomInfo: null,
  task: null,
  initialTurnStarted: null,
};

function createFixture(): {
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly client: HostClient<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-create-floor",
    handlers: { "epic.create": () => CREATE_RESPONSE },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      identity: { userId: USER_ID, username: USER_ID, providerHandle: null },
      origin: "renderer",
    }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  return {
    messenger,
    client: spine.createRequester(mockLocalHostEntry),
    Wrapper,
  };
}

afterEach(() => {
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("useEpicCreateForClient's dispatch-time version floor", () => {
  it("floors an unverified create on `epic.create@1.1` - the method it is actually dispatching", async () => {
    // The floor's subject was `epic.listTasks@1.6` until `epic.create` gained
    // a second minor to negotiate. That proxy rested on "a host on the
    // local-first list line is the host on the local-first create line" -
    // true, but it tied two methods' release histories together with a claim
    // nothing enforced, and it asked about a method this request never calls.
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    const fixture = createFixture();

    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });
    await rendered.result.current.mutateAsync(CREATE_VARIABLES);

    expect(fixture.messenger.calls).toHaveLength(1);
    expect(fixture.messenger.calls[0]?.method).toBe("epic.create");
    expect(fixture.messenger.calls[0]?.requiredHostMethodVersion).toEqual({
      method: "epic.create",
      version: { major: 1, minor: 1 },
    });
    // The property the rename exists for, asserted as itself rather than left
    // implied by two literals that happen to match: the floor is about the
    // very method being dispatched, so no future edit can drift the two apart
    // without reddening here.
    expect(fixture.messenger.calls[0]?.requiredHostMethodVersion?.method).toBe(
      fixture.messenger.calls[0]?.method,
    );
  });

  it("sends NO floor for a signed-in session, which may create on any host", async () => {
    // The control: a floor attached unconditionally would make an ordinary
    // signed-in create refusable on a host that has always been allowed to
    // serve it.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const fixture = createFixture();

    const rendered = renderHook(() => useEpicCreateForClient(fixture.client), {
      wrapper: fixture.Wrapper,
    });
    await rendered.result.current.mutateAsync(CREATE_VARIABLES);

    expect(fixture.messenger.calls[0]?.requiredHostMethodVersion).toBeNull();
  });
});
