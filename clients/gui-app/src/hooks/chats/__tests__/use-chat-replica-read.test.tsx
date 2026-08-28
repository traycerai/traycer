import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useChatReplicaRead } from "@/hooks/chats/use-chat-replica-read";

/**
 * `epic.chatReplicaRead` is optional (`degrade: { kind: "unsupported" }`
 * in the registry), so a host built before ticket 34A has never heard of it.
 * TanStack still surfaces the rejection on `.error` - this hook does not (and
 * should not) swallow that - but two things must hold for the tile's "no
 * data means no replica" reading to be safe: `.data` stays `undefined` on
 * this path (never a stale/partial value), and the hook does not burn retries
 * re-asking a host that has already answered "I don't have this method" -
 * the hook's own `retry` predicate refuses exactly this code. Neither is
 * pinned anywhere else, and the query has no `onError`, so nothing else in
 * this tree would catch a regression here.
 */
describe("useChatReplicaRead degrade path", () => {
  // The hook is viewer-scoped (unattributed replica reads never fire, and
  // the cache key carries the viewer so accounts can never share a slot) -
  // every test seeds a signed-in viewer, and the reset keeps tests
  // order-independent.
  beforeEach(() => {
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-1", username: "viewer-1" },
    });
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("never serves one account's cached replica to another (viewer rides the cache key)", async () => {
    // Deliberately NOT the shared fixture: this cache-separation proof needs
    // a SUCCESS entry that outlives the first mount, so gcTime stays at its
    // default rather than the shared fixture's instant eviction.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const requestCount = { value: 0 };
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => `req-replica-scope-${String(requestCount.value)}`,
        handlers: {
          "epic.chatReplicaRead": () => {
            requestCount.value += 1;
            return Promise.resolve({ outcome: { status: "absent" as const } });
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        props.children,
      );
    const args = {
      client,
      epicId: "epic-1",
      chatId: "chat-1",
      enabled: true,
    };

    const first = renderHook(() => useChatReplicaRead(args), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(first.result.current.data).toBeDefined();
    });
    expect(requestCount.value).toBe(1);
    first.unmount();

    // Account switch on the same renderer: the cached entry survives (real
    // gcTime), so an unscoped key would satisfy this mount from viewer-1's
    // cache with NO second request - exactly the leak under test.
    useAuthStore.setState({
      contextMetadata: { userId: "viewer-2", username: "viewer-2" },
    });
    const second = renderHook(() => useChatReplicaRead(args), {
      wrapper: Wrapper,
    });
    // Cache miss, not a served entry: no data before the fresh request lands.
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => {
      expect(second.result.current.data).toBeDefined();
    });
    expect(requestCount.value).toBe(2);
  });

  it("reads an E_HOST_UNSUPPORTED rejection as no replica, surfacing the error without retrying", async () => {
    const fixture = createFixture();
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    const client = fixture.client.createRequester(mockLocalHostEntry);

    const rendered = renderHook(
      () =>
        useChatReplicaRead({
          client,
          epicId: "epic-1",
          chatId: "chat-1",
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.isFetching).toBe(false);
    });

    // The property the tile actually leans on: `.data` stays `undefined` on
    // this path, which is what makes `replicaQuery.data?.outcome` read as
    // "no replica" - the exact same shape an `absent` doc record produces.
    expect(rendered.result.current.data).toBeUndefined();
    // The rejection is real and not swallowed - a genuine `.error`, not a
    // fabricated success.
    expect(rendered.result.current.error).toBeInstanceOf(HostRpcError);
    expect(rendered.result.current.error).toMatchObject({
      code: "E_HOST_UNSUPPORTED",
    });
    // And exactly one attempt: the hook's own `retry` predicate refuses to
    // retry E_HOST_UNSUPPORTED, so a host that already said "I don't have
    // this method" is not asked again on this mount.
    expect(fixture.requestCount.value).toBe(1);
  });
});

function createFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    // Retries ON at the client level, deliberately: the single-request
    // assertion is about the HOOK's own `retry` predicate refusing
    // E_HOST_UNSUPPORTED, and a client that never retries anything would keep
    // that assertion green even with the predicate deleted.
    defaultOptions: {
      queries: { retry: 3, retryDelay: 0, staleTime: 0, gcTime: 0 },
    },
  });
  const requestCount = { value: 0 };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-replica-1",
      handlers: {
        "epic.chatReplicaRead": () => {
          requestCount.value += 1;
          return Promise.reject(
            new HostRpcError({
              code: "E_HOST_UNSUPPORTED",
              message: "This host does not support 'epic.chatReplicaRead'.",
              requestId: "req-replica-unsupported",
              method: "epic.chatReplicaRead",
              fatalDetails: {
                code: "E_HOST_UNSUPPORTED",
                reason: "This host does not support 'epic.chatReplicaRead'.",
                incompatibleMethods: null,
                upgradeGuidance: {
                  clientShouldUpgrade: false,
                  hostShouldUpgrade: true,
                },
              },
            }),
          );
        },
      },
    }),
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, requestCount, Wrapper };
}
