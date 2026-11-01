import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Query } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { createAppQueryClient } from "@/lib/query-client";

describe("useHostQueries enabled handling", () => {
  afterEach(() => {
    cleanup();
  });

  it("respects a function-form `enabled` rather than collapsing it to true", async () => {
    const fixture = createHostQueriesFixture();
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    const client = fixture.client.createRequester(mockLocalHostEntry);

    renderHook(
      () =>
        useHostQueries({
          client,
          cacheKeyIdentity: undefined,
          requests: [{ method: "host.status", params: {} }],
          options: { enabled: () => false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestCount.value).toBe(0);

    renderHook(
      () =>
        useHostQueries({
          client,
          cacheKeyIdentity: undefined,
          requests: [{ method: "host.status", params: {} }],
          options: { enabled: () => true },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });
  });

  it("refuses each dispatch when preflight throws, sending nothing", async () => {
    const fixture = createHostQueriesFixture();
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    const client = fixture.client.createRequester(mockLocalHostEntry);

    const { result } = renderHook(
      () =>
        useHostQueries({
          client,
          cacheKeyIdentity: undefined,
          requests: [
            { method: "host.status", params: {} },
            { method: "host.status", params: {} },
          ],
          preflight: () => {
            throw new Error("verdict withdrawn");
          },
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(result.current.every((query) => query.error !== null)).toBe(true);
    });
    for (const query of result.current) {
      expect(query.error).toBeInstanceOf(HostRpcError);
      expect(query.error).toMatchObject({
        code: "RPC_ERROR",
        method: "host.status",
        message: "verdict withdrawn",
      });
    }
    expect(fixture.requestCount.value).toBe(0);
  });

  it("keeps a combined result stable when its query data is unchanged", async () => {
    const fixture = createHostQueriesFixture();
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );
    const client = fixture.client.createRequester(mockLocalHostEntry);

    const { result, rerender } = renderHook(
      () =>
        useHostQueries<
          HostRpcRegistry,
          "host.status",
          {
            readonly data:
              | ResponseOfMethod<HostRpcRegistry, "host.status">
              | undefined;
          }
        >({
          client,
          cacheKeyIdentity: undefined,
          requests: [{ method: "host.status", params: {} }],
          options: null,
          combine: (results) => ({ data: results[0]?.data }),
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    const combined = result.current;
    rerender();

    expect(result.current).toBe(combined);
  });
});

describe("useHostQueries condition cadence", () => {
  afterEach(() => {
    cleanup();
  });

  it("leaves the client's own retry in place for a condition reader that opts out", async () => {
    // The same contract `useHostQuery` answers, through the other helper that
    // builds these options: `retry: false` belongs to the BRANDED poller,
    // whose episode re-asks on its error lanes. A reader that opts out owns no
    // episode, so no lane can recover it - it keeps the app client's ordinary
    // retry, the only recovery it has left.
    const fixture = createConditionHostQueriesFixture();

    renderHook(
      () =>
        useHostQueries({
          client: fixture.client,
          cacheKeyIdentity: undefined,
          requests: [
            { method: "speech.getModelStatus", params: { modelId: null } },
          ],
          options: { poll: false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    const query = queryForMethod(fixture.queryClient, "speech.getModelStatus");
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "speech.getModelStatus",
    });
    const clientRetry = fixture.queryClient.getDefaultOptions().queries?.retry;
    // The app client's retry must be something a forced `retry: false` is NOT,
    // or this case would pass on the very option it exists to forbid.
    expect(clientRetry).not.toBe(false);
    expect(clientRetry).not.toBeUndefined();
    expect(query.options.retry).toBe(clientRetry);
    expect(refetchIntervalFor(query)).toBe(false);
  });
});

function refetchIntervalFor(query: Query): unknown {
  const { options } = query;
  return "refetchInterval" in options ? options.refetchInterval : undefined;
}

function queryForMethod(queryClient: QueryClient, method: string): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes(method));
  if (query === undefined) {
    throw new Error(`Expected query for ${method}`);
  }
  return query;
}

/**
 * The plural helper over a CONDITION-policy method, on the app's own query
 * client: its real retry default is what an opted-out reader must keep, and a
 * bare `new QueryClient()` would answer `false` there - the same value the
 * forced option has, which no assertion could tell apart.
 */
function createConditionHostQueriesFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const requestCount = { value: 0 };
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-speech-1",
      handlers: {
        "speech.getModelStatus": () => {
          requestCount.value += 1;
          return {
            modelId: "default",
            installed: false,
            downloadState: "downloading",
            downloadProgress: 0.1,
            sizeBytes: null,
            errorMessage: null,
            engineAvailable: true,
          };
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-1",
    }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    requestCount,
    Wrapper,
  };
}

function createHostQueriesFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
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
      requestId: () => "req-1",
      handlers: {
        "host.status": () => {
          requestCount.value += 1;
          return {
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            // `null` = this fixture's host did not report the durable attempt,
            // which is exactly what host.status@1.2-and-older peers send.
            updateOperation: null,
            updateTransaction: null,
            storeFormats: null,
            install: null,
            processMemory: null,
            crossHostMessaging: null,
            sessions: null,
            updatesExternallyManaged: null,
          };
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
