/**
 * Shared wiring for the two "does a cache-level refresh trigger flip a
 * mounted observer's isFetching" integration tests (the ephemeral queue's
 * `enqueueRateLimitFetch` and the httpFetch lane's `invalidateQueries`).
 * Not a `.test` file - vitest only collects `*.test.ts(x)`.
 *
 * Builds the production QueryClient configuration (`createAppQueryClient` -
 * the global staleTime default changes fetch semantics, see that factory's
 * doc comment) around a real `HostClient` + `MockHostMessenger` whose
 * `host.getRateLimitUsage` handler resolves the FIRST call immediately (the
 * observer's initial mount fetch) and blocks every later call until the test
 * releases it via `resolvePendingResponse`.
 */
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";

interface RateLimitSharingHarness {
  readonly queryClient: QueryClient;
  readonly client: HostClient<HostRpcRegistry>;
  /** Releases every `host.getRateLimitUsage` call after the first. */
  readonly resolvePendingResponse: () => void;
}

// A minimal valid `host.getRateLimitUsage @1.2` response - only fetch timing
// matters to these tests, not the payload.
function response() {
  return { totalTokens: 0, remainingTokens: 0, providerRateLimits: null };
}

export function createRateLimitSharingHarness(): RateLimitSharingHarness {
  const queryClient = createAppQueryClient();
  let callCount = 0;
  let resolvePending: (() => void) | null = null;
  const pending = new Promise<void>((resolve) => {
    resolvePending = resolve;
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.getRateLimitUsage": async () => {
          callCount += 1;
          if (callCount === 1) return response();
          await pending;
          return response();
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    queryClient,
    client,
    resolvePendingResponse: () => resolvePending?.(),
  };
}

export function createQueryClientWrapper(
  queryClient: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}
