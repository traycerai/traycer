import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  type Query,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import {
  useHostMutation,
  useHostQuery,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";

describe("useHostQuery auth readiness", () => {
  afterEach(() => {
    cleanup();
  });

  it("waits for an active request context before dispatching host RPC", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);

    const rendered = renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(fixture.requestCount.value).toBe(0);
    expect(rendered.result.current.fetchStatus).toBe("idle");

    act(() => {
      fixture.client.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-1",
        }),
      );
    });

    await waitFor(() => {
      expect(rendered.result.current.data?.ready).toBe(true);
    });
    expect(fixture.requestCount.value).toBe(1);
  });

  it("does not refetch active host queries when auth context is removed", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    act(() => {
      fixture.client.setRequestContext(null);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestCount.value).toBe(1);
  });

  it("respects a function-form `enabled` rather than collapsing it to true", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: { enabled: () => false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.requestCount.value).toBe(0);

    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: { enabled: () => true },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });
  });

  it("rejects mutations without a client with a host RPC error", async () => {
    const fixture = createHostQueryFixture();
    const rendered = renderHook(
      () =>
        useHostMutation({
          client: null,
          method: "host.status",
          options: null,
          mapVariables: () => ({}),
        }),
      { wrapper: fixture.Wrapper },
    );

    let caught: unknown;
    await act(async () => {
      try {
        await rendered.result.current.mutateAsync({});
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(HostRpcError);
    expect(caught).toMatchObject({
      code: "RPC_ERROR",
      requestId: "client-unavailable",
      method: "host.status",
      message: "Host client unavailable",
      fatalDetails: null,
    });
  });
});

// The `HostRpcError` error generic on these hooks is an unchecked assertion:
// TypeScript cannot type a promise's rejection channel, so a bare throw
// anywhere inside the queryFn/mutationFn would reach `.code`-reading
// consumers as a foreign shape (the git diff white-screen). These tests pin
// the boundary that makes the declared type true by construction.
describe("host query/mutation HostRpcError boundary", () => {
  afterEach(() => {
    cleanup();
  });

  it("normalizes a bare throw from mapResponse into a HostRpcError", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    const rendered = renderHook(
      () =>
        useHostQueryWithResponseMap({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: null,
          mapResponse: () => {
            throw new TypeError("mapResponse exploded");
          },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.error).not.toBeNull();
    });
    expect(rendered.result.current.error).toBeInstanceOf(HostRpcError);
    expect(rendered.result.current.error).toMatchObject({
      code: "RPC_ERROR",
      method: "host.status",
      message: "mapResponse exploded",
      fatalDetails: null,
    });
  });

  it("normalizes a bare throw from mapVariables into a HostRpcError", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    const rendered = renderHook(
      () =>
        useHostMutation({
          client: fixture.client,
          method: "host.status",
          options: null,
          mapVariables: () => {
            throw new Error("mapVariables exploded");
          },
        }),
      { wrapper: fixture.Wrapper },
    );

    let caught: unknown;
    await act(async () => {
      try {
        await rendered.result.current.mutateAsync({});
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(HostRpcError);
    expect(caught).toMatchObject({
      code: "RPC_ERROR",
      method: "host.status",
      message: "mapVariables exploded",
      fatalDetails: null,
    });
  });

  it("normalizes a bare throw from a caller-supplied select into a HostRpcError", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    const rendered = renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.status",
          params: {},
          options: {
            select: () => {
              throw new TypeError("select exploded");
            },
          },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(rendered.result.current.error).not.toBeNull();
    });
    expect(rendered.result.current.error).toBeInstanceOf(HostRpcError);
    expect(rendered.result.current.error).toMatchObject({
      code: "RPC_ERROR",
      method: "host.status",
      message: "select exploded",
    });
  });

  it("normalizes a bare throw from onMutate into a HostRpcError", async () => {
    const fixture = createHostQueryFixture();
    fixture.client.bind(mockLocalHostEntry);
    fixture.client.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-1",
      }),
    );

    let onErrorReceived: unknown;
    const rendered = renderHook(
      () =>
        useHostMutation({
          client: fixture.client,
          method: "host.status",
          options: {
            onMutate: () => {
              throw new TypeError("onMutate exploded");
            },
            onError: (error) => {
              onErrorReceived = error;
            },
          },
          mapVariables: () => ({}),
        }),
      { wrapper: fixture.Wrapper },
    );

    let caught: unknown;
    await act(async () => {
      try {
        await rendered.result.current.mutateAsync({});
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(HostRpcError);
    expect(caught).toMatchObject({
      code: "RPC_ERROR",
      method: "host.status",
      message: "onMutate exploded",
    });
    expect(onErrorReceived).toBeInstanceOf(HostRpcError);
  });
});

describe("useHostQuery condition cadence wiring", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
  });

  it("writes hostRpcMethod last so caller meta cannot override the stamp", async () => {
    const fixture = createConditionHostQueryFixture();
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "speech.getModelStatus",
          params: { modelId: null },
          options: {
            meta: {
              hostRpcMethod: "providers.list",
              caller: true,
            },
          },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    const query = speechQuery(fixture.queryClient);
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "speech.getModelStatus",
      caller: true,
    });
  });

  it("installs branded cadence and retry:false for condition methods by default", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const fixture = createConditionHostQueryFixture();
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "speech.getModelStatus",
          params: { modelId: null },
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = speechQuery(fixture.queryClient);
    const branded = getConditionPollEpisodeCoordinator(
      fixture.queryClient,
    ).refetchIntervalFor("speech.getModelStatus");
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(branded);
    // downloading lane starts at 1.5s.
    expect(appliedDelay(query)).toBe(1_500);
  });

  it("omits branded cadence when poll:false while still stamping and forcing retry:false", async () => {
    const fixture = createConditionHostQueryFixture();
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "speech.getModelStatus",
          params: { modelId: null },
          options: { poll: false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    const query = speechQuery(fixture.queryClient);
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "speech.getModelStatus",
    });
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(false);
  });
});

describe("useHostQuery fixed cadence wiring", () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
  });

  it("synthesizes table fixed interval and refetchIntervalInBackground:false when poll:true", async () => {
    const fixture = createFixedHostQueryFixture("epic.listCollaborators");
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "epic.listCollaborators",
          params: { epicId: "epic-1" },
          options: { poll: true },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    const query = queryForMethod(fixture.queryClient, "epic.listCollaborators");
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "epic.listCollaborators",
    });
    expect(refetchIntervalFor(query)).toBe(5 * 60 * 1000);
    expect(refetchIntervalInBackgroundFor(query)).toBe(false);
  });

  it("keeps fixed methods non-polling by default while still stamping hostRpcMethod", async () => {
    const fixture = createFixedHostQueryFixture("host.getRateLimitUsage");
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.getRateLimitUsage",
          params: {
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            providerId: "openrouter",
            profileId: null,
          },
          options: { poll: false },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    const query = queryForMethod(fixture.queryClient, "host.getRateLimitUsage");
    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "host.getRateLimitUsage",
    });
    expect(refetchIntervalFor(query)).toBe(false);
    expect(refetchIntervalInBackgroundFor(query)).toBe(false);
  });

  it("opts host.getRateLimitUsage into the table's 15-minute fixed cadence when poll:true", async () => {
    const fixture = createFixedHostQueryFixture("host.getRateLimitUsage");
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "host.getRateLimitUsage",
          params: {
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            providerId: "openrouter",
            profileId: null,
          },
          options: { poll: true },
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requestCount.value).toBe(1);
    });

    const query = queryForMethod(fixture.queryClient, "host.getRateLimitUsage");
    expect(refetchIntervalFor(query)).toBe(15 * 60 * 1000);
    expect(refetchIntervalInBackgroundFor(query)).toBe(false);
  });

  it("fires the fixed collaborator cadence on a real timer while focused", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const fixture = createFixedHostQueryFixture("epic.listCollaborators");
    renderHook(
      () =>
        useHostQuery({
          cacheKeyIdentity: undefined,
          client: fixture.client,
          method: "epic.listCollaborators",
          params: { epicId: "epic-timer" },
          options: { poll: true, staleTime: 0 },
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fixture.requestCount.value).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(fixture.requestCount.value).toBe(2);
  });
});

function speechQuery(queryClient: QueryClient): Query {
  return queryForMethod(queryClient, "speech.getModelStatus");
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

function appliedDelay(query: Query): number | false | undefined {
  const interval = refetchIntervalFor(query);
  if (!isRefetchInterval(interval)) {
    return typeof interval === "number" || interval === false
      ? interval
      : undefined;
  }
  return interval(query);
}

function refetchIntervalFor(query: Query): unknown {
  const { options } = query;
  return "refetchInterval" in options ? options.refetchInterval : undefined;
}

function refetchIntervalInBackgroundFor(query: Query): unknown {
  return Reflect.get(query.options, "refetchIntervalInBackground");
}

function isRefetchInterval(
  value: unknown,
): value is (query: Query) => number | false | undefined {
  return typeof value === "function";
}

function createHostQueryFixture(): {
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

function createConditionHostQueryFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const requestCount = { value: 0 };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
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
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
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
  return { client, queryClient, requestCount, Wrapper };
}

function createFixedHostQueryFixture(
  method: "epic.listCollaborators" | "host.getRateLimitUsage",
): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = createAppQueryClient();
  const requestCount = { value: 0 };
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-fixed-1",
      handlers: {
        "epic.listCollaborators": () => {
          if (method === "epic.listCollaborators") {
            requestCount.value += 1;
          }
          return {
            collaborators: [],
            collaboratorsAvailable: true,
          };
        },
        "host.getRateLimitUsage": () => {
          if (method === "host.getRateLimitUsage") {
            requestCount.value += 1;
          }
          return {
            totalTokens: 0,
            remainingTokens: 0,
            providerRateLimits: null,
          };
        },
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
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
  return { client, queryClient, requestCount, Wrapper };
}
