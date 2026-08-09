import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
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
  afterEach(() => {
    cleanup();
  });

  it("reads an E_HOST_UNSUPPORTED rejection as no replica, without surfacing an error", async () => {
    const fixture = createFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    const rendered = renderHook(
      () =>
        useChatReplicaRead({
          client: fixture.client,
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
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const requestCount = { value: 0 };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
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
