import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import {
  HostRpcError,
  type HostRequestAuthority,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  subscribeTaskHostRefusalReset,
  useTaskHosts,
} from "@/hooks/epic/use-task-hosts-query";
import type { ListTaskHostsResponse } from "@traycer/protocol/host/task-host-summary";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

// The real `useTaskHosts` over the real `useHostQuery` and a real `HostClient`,
// with the handler counting how often the host is asked.

const TASK_ID = "task-refused";
const VIEWER_ID = createAuthenticatedUserFixture(undefined).user.id;

function hostsOf(principalId: string): ListTaskHostsResponse {
  return {
    hosts: [
      {
        hostId: "host-1",
        label: null,
        principal: { kind: "user", id: principalId },
        reach: "same_principal",
        sandboxEnd: null,
      },
    ],
  };
}

/** A provider signed in as the given user, the viewer a verdict will name. */
function signedInProvider(userId: string): DefaultRequestContextProvider {
  const provider = new DefaultRequestContextProvider({ origin: "renderer" });
  const fixture = createAuthenticatedUserFixture(undefined);
  provider.setSignedIn({
    user: createAuthenticatedUserFixture({
      user: { ...fixture.user, id: userId },
    }),
    bearerToken: "tok-1",
    operationId: undefined,
    externalAbortSignal: undefined,
  });
  return provider;
}

function refusal(requestId: string): HostRpcError {
  return new HostRpcError({
    code: "FORBIDDEN",
    message: "refused",
    requestId,
    method: "epic.listTaskHosts",
    fatalDetails: null,
  });
}

/**
 * A real `HostClient` whose `epic.listTaskHosts` is the given handler, which
 * is told the credential each request carries.
 */
function mountFixture(
  listTaskHosts: (
    bearer: HostRequestAuthority["bearer"],
  ) => Promise<ListTaskHostsResponse>,
): {
  readonly spine: HostClient<HostRpcRegistry>;
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const messenger: MockHostMessenger<HostRpcRegistry> =
    new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "task-hosts",
      // The messenger records a call before it runs the handler, so the last
      // one is the request being answered.
      handlers: {
        "epic.listTaskHosts": () => {
          const call = messenger.calls.at(-1);
          if (call === undefined) {
            throw new Error("handler ran before the call was recorded");
          }
          return listTaskHosts(call.authority.bearer);
        },
      },
    });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    spine,
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    wrapper: (props) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      ),
  };
}

describe("subscribeTaskHostRefusalReset", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("refetches a still-mounted refused read when the session is announced verified", async () => {
    // The verdict is withdrawn and returns inside one act, so the observer
    // never renders disabled: the reset is the only thing that can start the
    // refetch, and it must still reach a read it has just returned to pending.
    const hostRefuses = { value: true };
    const requests = { value: 0 };
    const { client, queryClient, wrapper } = mountFixture(() => {
      requests.value += 1;
      return hostRefuses.value
        ? Promise.reject(refusal(`task-hosts-${String(requests.value)}`))
        : Promise.resolve(hostsOf(VIEWER_ID));
    });
    const provider = signedInProvider(VIEWER_ID);
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const mounted = renderHook(() => useTaskHosts(client, TASK_ID), {
      wrapper,
    });
    await vi.waitFor(() => {
      expect(mounted.result.current.isError).toBe(true);
    });

    hostRefuses.value = false;
    act(() => {
      useAuthStore.setState({ status: "unverified" });
      useAuthStore.setState({ status: "signed-in" });
      provider.announceSessionVerified();
    });

    // The reset runs once the cancel of the picked reads resolves, so wait for
    // its outcome: the refetch it allows, not an idle pending read.
    await vi.waitFor(() => {
      expect(requests.value).toBe(2);
      expect(mounted.result.current.data?.hosts[0]?.hostId).toBe("host-1");
    });
    expect(mounted.result.current.isError).toBe(false);

    unsubscribe();
    provider.dispose();
  });

  it("re-asks a read still in flight when the verdict returns, so a refusal that settles afterwards does not stay terminal", async () => {
    const heldRefusal = Promise.withResolvers<ListTaskHostsResponse>();
    const requests = { value: 0 };
    const { client, queryClient, wrapper } = mountFixture(() => {
      requests.value += 1;
      return requests.value === 1
        ? heldRefusal.promise
        : Promise.resolve(hostsOf(VIEWER_ID));
    });
    const provider = signedInProvider(VIEWER_ID);
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const mounted = renderHook(() => useTaskHosts(client, TASK_ID), {
      wrapper,
    });
    await vi.waitFor(() => {
      expect(requests.value).toBe(1);
      expect(mounted.result.current.isFetching).toBe(true);
    });

    act(() => {
      provider.announceSessionVerified();
    });
    heldRefusal.reject(refusal("task-hosts-1"));

    await vi.waitFor(() => {
      expect(requests.value).toBe(2);
      expect(mounted.result.current.data?.hosts[0]?.hostId).toBe("host-1");
    });
    expect(mounted.result.current.isError).toBe(false);

    unsubscribe();
    provider.dispose();
  });

  it("does not refetch a viewer's read under a newer viewer's credential that commits right after the verdict", async () => {
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-a", username: "viewer-a" },
    });
    const viewerBContext = createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-b",
    });
    const heldFirst = Promise.withResolvers<ListTaskHostsResponse>();
    const requests = { value: 0, carryingViewerB: 0 };
    const { spine, client, queryClient, wrapper } = mountFixture((bearer) => {
      requests.value += 1;
      if (bearer === viewerBContext.credentials) {
        requests.carryingViewerB += 1;
      }
      if (requests.value === 1) return heldFirst.promise;
      // The host answers for the credential the request carries.
      return Promise.resolve(
        hostsOf(
          bearer === viewerBContext.credentials ? "viewer-b" : "viewer-a",
        ),
      );
    });
    const provider = signedInProvider("viewer-a");
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const mounted = renderHook(() => useTaskHosts(client, TASK_ID), {
      wrapper,
    });
    await vi.waitFor(() => {
      expect(requests.value).toBe(1);
      expect(mounted.result.current.isFetching).toBe(true);
    });

    // The next viewer's credential commits in the same turn as the verdict,
    // ahead of the store viewer the A observer is still keyed to.
    act(() => {
      provider.announceSessionVerified();
      spine.setRequestContext(viewerBContext);
    });
    heldFirst.reject(refusal("task-hosts-1"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // The store still names viewer A, so no observer is keyed to B: a request
    // carrying B's credential could only be a refetch of A's read.
    expect(requests.carryingViewerB).toBe(0);
    const viewerAReads = queryClient
      .getQueryCache()
      .findAll({ predicate: (query) => query.queryKey.at(-1) === "viewer-a" });
    expect(viewerAReads).toHaveLength(1);
    expect(viewerAReads[0]?.state.data).not.toEqual(hostsOf("viewer-b"));

    unsubscribe();
    provider.dispose();
  });

  it("resets a failed read in the turn the verdict is announced", async () => {
    const requests = { value: 0 };
    const { client, queryClient, wrapper } = mountFixture(() => {
      requests.value += 1;
      return requests.value === 1
        ? Promise.reject(refusal("task-hosts-1"))
        : Promise.resolve(hostsOf(VIEWER_ID));
    });
    const provider = signedInProvider(VIEWER_ID);
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const mounted = renderHook(() => useTaskHosts(client, TASK_ID), {
      wrapper,
    });
    await vi.waitFor(() => {
      expect(mounted.result.current.isError).toBe(true);
    });

    act(() => {
      provider.announceSessionVerified();
      const reads = queryClient.getQueryCache().findAll({
        predicate: (query) => query.queryKey.at(-1) === VIEWER_ID,
      });
      expect(reads.map((read) => read.state.status)).toEqual(["pending"]);
      expect(reads.map((read) => read.state.fetchStatus)).toEqual(["fetching"]);
    });
    await vi.waitFor(() => {
      expect(mounted.result.current.data?.hosts[0]?.hostId).toBe("host-1");
    });

    unsubscribe();
    provider.dispose();
  });

  it("leaves another viewer's failed read alone when the verdict names a different viewer", async () => {
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-a", username: "viewer-a" },
    });
    const requests = { value: 0 };
    const { client, queryClient, wrapper } = mountFixture(() => {
      requests.value += 1;
      return Promise.reject(refusal(`task-hosts-${String(requests.value)}`));
    });
    const provider = signedInProvider("viewer-b");
    const unsubscribe = subscribeTaskHostRefusalReset({
      requestContextProvider: provider,
      queryClient,
    });

    const mounted = renderHook(() => useTaskHosts(client, TASK_ID), {
      wrapper,
    });
    await vi.waitFor(() => {
      expect(mounted.result.current.isError).toBe(true);
    });

    act(() => {
      provider.announceSessionVerified();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(requests.value).toBe(1);
    expect(mounted.result.current.isError).toBe(true);

    unsubscribe();
    provider.dispose();
  });
});
