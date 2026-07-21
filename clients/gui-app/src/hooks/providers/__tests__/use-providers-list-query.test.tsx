import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  PROVIDERS_LIMITED_POLL_LANE,
  PROVIDERS_PENDING_POLL_LANE,
  PROVIDERS_STEADY_POLL_LANE,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";

function profile(
  rateLimitStatus: ProviderProfileRateLimitStatus,
): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    ...overrides,
  };
}

const candidateVersionPending: ProviderCliState["candidates"] = [
  {
    kind: "bundled",
    path: "/bin/claude",
    available: true,
    version: null,
    versionPending: true,
  },
];

interface ProvidersFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly requestCount: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  setResponse: (providers: ReadonlyArray<ProviderCliState>) => void;
  setError: (error: Error | null) => void;
}

function createProvidersFixture(): ProvidersFixture {
  const queryClient = createAppQueryClient();
  const requestCount = { value: 0 };
  let providers: ReadonlyArray<ProviderCliState> = [
    providerState({ profiles: [profile("ok")] }),
  ];
  let error: Error | null = null;
  let requestSeq = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq += 1;
        return `req-${String(requestSeq)}`;
      },
      handlers: {
        "providers.list": () => {
          requestCount.value += 1;
          if (error !== null) throw error;
          return { providers: [...providers] };
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
  return {
    client,
    queryClient,
    requestCount,
    Wrapper,
    setResponse: (next) => {
      providers = next;
    },
    setError: (next) => {
      error = next;
    },
  };
}

function providersQuery(queryClient: QueryClient): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes("providers.list"));
  if (query === undefined) {
    throw new Error("Expected providers.list query");
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

function isRefetchInterval(
  value: unknown,
): value is (query: Query) => number | false | undefined {
  return typeof value === "function";
}

describe("useProvidersListForClient table cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    cleanup();
    vi.useRealTimers();
  });

  it("stamps hostRpcMethod, forces retry:false, and uses the branded interval", async () => {
    const fixture = createProvidersFixture();
    renderHook(
      () =>
        useProvidersListForClient(fixture.client, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = providersQuery(fixture.queryClient);
    const branded = getConditionPollEpisodeCoordinator(
      fixture.queryClient,
    ).refetchIntervalFor("providers.list");

    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "providers.list",
    });
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(branded);
    expect(appliedDelay(query)).toBe(PROVIDERS_STEADY_POLL_LANE.initialDelayMs);
  });

  it("applies the pending exponential schedule on the real timer", async () => {
    const fixture = createProvidersFixture();
    fixture.setResponse([providerState({ availabilityPending: true })]);
    const fetchTimes: number[] = [];
    vi.setSystemTime(0);

    const originalList = fixture.client.requestWithSignal.bind(fixture.client);
    vi.spyOn(fixture.client, "requestWithSignal").mockImplementation(
      async (method, params, signal) => {
        if (method === "providers.list") {
          fetchTimes.push(Date.now());
        }
        return originalList(method, params, signal);
      },
    );

    renderHook(
      () =>
        useProvidersListForClient(fixture.client, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_400);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_800);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_600);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const deltas = fetchTimes
      .slice(1)
      .map((time, index) => time - fetchTimes[index]);
    expect(deltas).toEqual([
      800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000,
    ]);
  });

  it("prefers pending cadence over limited and ignores disabled pending probes", async () => {
    const fixture = createProvidersFixture();

    fixture.setResponse([
      providerState({
        authPending: true,
        profiles: [profile("hard_limit")],
      }),
    ]);
    renderHook(
      () =>
        useProvidersListForClient(fixture.client, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(appliedDelay(providersQuery(fixture.queryClient))).toBe(
      PROVIDERS_PENDING_POLL_LANE.initialDelayMs,
    );

    fixture.setResponse([
      providerState({
        enabled: false,
        authPending: true,
        availabilityPending: true,
        candidates: candidateVersionPending,
      }),
    ]);
    await act(async () => {
      await providersQuery(fixture.queryClient).fetch();
    });
    // Disabled providers never drive the pending lane; limited profiles are
    // still visible on disabled rows, but this fixture has none → steady.
    expect(appliedDelay(providersQuery(fixture.queryClient))).toBe(
      PROVIDERS_STEADY_POLL_LANE.initialDelayMs,
    );

    fixture.setResponse([providerState({ profiles: [profile("near_limit")] })]);
    await act(async () => {
      await providersQuery(fixture.queryClient).fetch();
    });
    expect(appliedDelay(providersQuery(fixture.queryClient))).toBe(
      PROVIDERS_LIMITED_POLL_LANE.initialDelayMs,
    );

    fixture.setResponse([
      providerState({ candidates: candidateVersionPending }),
    ]);
    await act(async () => {
      await providersQuery(fixture.queryClient).fetch();
    });
    expect(appliedDelay(providersQuery(fixture.queryClient))).toBe(
      PROVIDERS_PENDING_POLL_LANE.initialDelayMs,
    );
  });

  it("uses the pending error lane for cold recovery, then the classified data lane", async () => {
    const fixture = createProvidersFixture();
    fixture.setError(new Error("providers unavailable"));

    renderHook(
      () =>
        useProvidersListForClient(fixture.client, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(appliedDelay(providersQuery(fixture.queryClient))).toBe(
      PROVIDERS_PENDING_POLL_LANE.initialDelayMs,
    );

    fixture.setError(null);
    fixture.setResponse([providerState({ profiles: [profile("ok")] })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        PROVIDERS_PENDING_POLL_LANE.initialDelayMs,
      );
    });
    expect(appliedDelay(providersQuery(fixture.queryClient))).toBe(
      PROVIDERS_STEADY_POLL_LANE.initialDelayMs,
    );
  });
});
