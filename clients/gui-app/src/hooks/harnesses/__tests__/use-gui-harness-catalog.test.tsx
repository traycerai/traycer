import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClientProvider,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  GuiHarnessId,
  ListGuiHarnessesResponse,
  ListGuiAgentModelsResponse,
} from "@traycer/protocol/host/index";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  HARNESS_ALL_AVAILABLE_POLL_LANE,
  HARNESS_PENDING_POLL_LANE,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import { createAppQueryClient } from "@/lib/query-client";
import { getConditionPollEpisodeCoordinator } from "@/lib/query/condition-poll-episode-coordinator";
import {
  useGuiHarnessCatalog,
  useGuiHarnessesQuery,
  useGuiHarnessModelsQuery,
  useRefreshHarnessCatalog,
} from "@/hooks/harnesses/use-gui-harness-catalog";

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => hostBindingMock.current,
  useHostClient: () => hostBindingMock.current?.hostClient ?? null,
}));

const UNAVAILABLE_INITIAL_MS = 30 * 1000;
const UNAVAILABLE_SECOND_MS = 60 * 1000;
const UNAVAILABLE_THIRD_MS = 120 * 1000;
const PENDING_INITIAL_MS = 800;

function response(
  available: boolean,
  availabilityPending: boolean,
): ListGuiHarnessesResponse {
  return {
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        enabled: true,
        available,
        error: available ? null : "probe timed out",
        modes: ["gui", "tui"],
        requiresApiKey: false,
        supportedPermissionModes: [
          "supervised",
          "auto_accept_edits",
          "full_access",
        ],
        availabilityPending,
      },
    ],
  };
}

function harnessesQuery(queryClient: QueryClient): Query {
  const query = queryClient
    .getQueryCache()
    .getAll()
    .find((entry) => entry.queryKey.includes("agent.gui.listHarnesses"));
  if (query === undefined) {
    throw new Error("Expected agent.gui.listHarnesses query");
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

// Real-hook regression coverage for the removed model-query interval (F1 /
// R2-F1): unlike availability above, model queries must never install a
// `refetchInterval` - on success OR error - at EITHER call site
// (`useGuiHarnessModelsQuery` and `useGuiHarnessCatalog`'s batched fan-out).
// A surviving interval on a persistently-failing model fetch would keep
// hitting `OpenCodeAdapter.listModels` forever, resetting the host's 15-min
// idle clock and making a spawned-but-failing server permanently unreapable.
function harnesses(
  ids: ReadonlyArray<GuiHarnessId>,
): ListGuiHarnessesResponse["harnesses"] {
  return ids.map((id) => ({
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised"],
    availabilityPending: false,
  }));
}

function modelsResponse(count: number): ListGuiAgentModelsResponse {
  return {
    harnessId: "opencode",
    models: Array.from({ length: count }, (_unused, index) => ({
      harnessId: "opencode",
      slug: `model-${index}`,
      label: `Model ${index}`,
      description: null,
      contextWindow: null,
      maxOutputTokens: null,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
      defaultServiceTier: null,
      supportedServiceTiers: [],
      deprecationNotice: null,
      metadata: {},
    })),
  };
}

interface CatalogFixture {
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly queryClient: QueryClient;
}

function createCatalogFixture(
  handlers: Partial<{
    readonly "agent.gui.listHarnesses": () => ListGuiHarnessesResponse;
    readonly "agent.gui.listModels": () => ListGuiAgentModelsResponse;
  }>,
): CatalogFixture {
  const queryClient = createAppQueryClient();
  let requestCounter = 0;
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${String(requestCounter)}`;
      },
      handlers,
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostBindingMock.current = { hostClient: client };
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe("useGuiHarnessesQuery table cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    hostBindingMock.current = null;
    cleanup();
  });

  it("stamps hostRpcMethod, forces retry:false, and brands the interval", async () => {
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => response(true, false),
    });

    renderHook(
      () => useGuiHarnessesQuery({ enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = harnessesQuery(fixture.queryClient);
    const branded = getConditionPollEpisodeCoordinator(
      fixture.queryClient,
    ).refetchIntervalFor("agent.gui.listHarnesses");

    expect(query.options.meta).toMatchObject({
      hostRpcMethod: "agent.gui.listHarnesses",
    });
    expect(query.options.retry).toBe(false);
    expect(refetchIntervalFor(query)).toBe(branded);
    expect(appliedDelay(query)).toBe(
      HARNESS_ALL_AVAILABLE_POLL_LANE.initialDelayMs,
    );
  });

  it("resumes unavailable across a pending timer detour: 30s → 60s → 800ms → 120s", async () => {
    vi.setSystemTime(0);
    let next: ListGuiHarnessesResponse = response(false, false);
    const fetchTimes: number[] = [];
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => {
        fetchTimes.push(Date.now());
        return next;
      },
    });

    renderHook(
      () => useGuiHarnessesQuery({ enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Mount settlement enters unavailable at attempt 0.
    next = response(false, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_INITIAL_MS);
    });

    next = response(false, true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_SECOND_MS);
    });

    next = response(false, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_INITIAL_MS);
    });
    await act(async () => {
      // Unavailable counter resumes at attempt 2 → 30s * 2^2 = 120s.
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_THIRD_MS);
    });

    const deltas = fetchTimes
      .slice(1)
      .map((time, index) => time - fetchTimes[index]);
    expect(deltas).toEqual([
      UNAVAILABLE_INITIAL_MS,
      UNAVAILABLE_SECOND_MS,
      PENDING_INITIAL_MS,
      UNAVAILABLE_THIRD_MS,
    ]);
  });

  it("applies the unavailable exponential schedule on the real timer", async () => {
    vi.setSystemTime(0);
    const fetchTimes: number[] = [];
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => {
        fetchTimes.push(Date.now());
        return response(false, false);
      },
    });

    renderHook(
      () => useGuiHarnessesQuery({ enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_INITIAL_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_SECOND_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_THIRD_MS);
    });

    const deltas = fetchTimes
      .slice(1)
      .map((time, index) => time - fetchTimes[index]);
    expect(deltas).toEqual([
      UNAVAILABLE_INITIAL_MS,
      UNAVAILABLE_SECOND_MS,
      UNAVAILABLE_THIRD_MS,
    ]);
  });

  it("resets a capped unavailable episode before the explicit catalog refresh", async () => {
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => response(false, false),
    });

    renderHook(
      () => useGuiHarnessesQuery({ enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const query = harnessesQuery(fixture.queryClient);
    for (let index = 0; index < 4; index += 1) {
      fixture.queryClient.setQueryData(query.queryKey, response(false, false));
    }
    expect(appliedDelay(query)).toBe(5 * 60 * 1_000);

    const { result } = renderHook(() => useRefreshHarnessCatalog(), {
      wrapper: fixture.Wrapper,
    });
    await result.current();

    expect(appliedDelay(query)).toBe(UNAVAILABLE_INITIAL_MS);
  });

  it("clears unavailable progress when the all-available reset lane is entered", async () => {
    let next: ListGuiHarnessesResponse = response(false, false);
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => next,
    });

    renderHook(
      () => useGuiHarnessesQuery({ enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const query = harnessesQuery(fixture.queryClient);

    next = response(false, false);
    await act(async () => {
      await query.fetch();
    });
    expect(appliedDelay(query)).toBe(UNAVAILABLE_SECOND_MS);

    next = response(true, false);
    await act(async () => {
      await query.fetch();
    });
    expect(appliedDelay(query)).toBe(
      HARNESS_ALL_AVAILABLE_POLL_LANE.initialDelayMs,
    );

    next = response(false, false);
    await act(async () => {
      await query.fetch();
    });
    expect(appliedDelay(query)).toBe(UNAVAILABLE_INITIAL_MS);
  });

  it("uses the pending error lane for cold recovery", async () => {
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => {
        throw new Error("harness catalog unavailable");
      },
    });

    renderHook(
      () => useGuiHarnessesQuery({ enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(appliedDelay(harnessesQuery(fixture.queryClient))).toBe(
      HARNESS_PENDING_POLL_LANE.initialDelayMs,
    );
  });
});

describe("useGuiHarnessModelsQuery (interval removal regression)", () => {
  afterEach(() => {
    vi.useRealTimers();
    hostBindingMock.current = null;
    cleanup();
  });

  it("fetches once and schedules no background refetch in steady state", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fixture = createCatalogFixture({
      "agent.gui.listModels": () => {
        callCount += 1;
        return modelsResponse(2);
      },
    });

    renderHook(
      () =>
        useGuiHarnessModelsQuery("opencode", null, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(callCount).toBe(1);

    // Well past the old 15-min steady-state interval - nothing should fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    });
    expect(callCount).toBe(1);
  });

  it("keeps an inactive invalidated model catalog cached past TanStack's default GC window", async () => {
    vi.useFakeTimers();
    const fixture = createCatalogFixture({
      "agent.gui.listModels": () => modelsResponse(2),
    });

    const hook = renderHook(
      () =>
        useGuiHarnessModelsQuery("opencode", null, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    hook.unmount();

    const modelQuery = fixture.queryClient
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey.includes("agent.gui.listModels"));
    if (modelQuery === undefined) {
      throw new Error("Expected the model catalog query to be cached");
    }
    expect(modelQuery.state.data).toEqual(modelsResponse(2));
    await fixture.queryClient.invalidateQueries({
      queryKey: modelQuery.queryKey,
      refetchType: "none",
    });
    expect(modelQuery.state.isInvalidated).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    });

    expect(fixture.queryClient.getQueryData(modelQuery.queryKey)).toEqual(
      modelsResponse(2),
    );
  });

  it("produces zero background requests past the 15-minute mark when the model fetch persistently fails", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fixture = createCatalogFixture({
      "agent.gui.listModels": () => {
        callCount += 1;
        throw new Error("opencode server unavailable");
      },
    });

    const { result } = renderHook(
      () =>
        useGuiHarnessModelsQuery("opencode", null, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    // Let TanStack's single finite initial retry (the only retry policy left
    // on this query) run its course.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(result.current.isError).toBe(true);
    const callsAfterInitialFailure = callCount;
    expect(callsAfterInitialFailure).toBeGreaterThan(0);

    // The regression guard: 15+ minutes of a persistently failing server
    // must not produce a single additional request - a surviving error
    // backoff would re-hit the server forever and defeat the idle reaper.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    });
    expect(callCount).toBe(callsAfterInitialFailure);
  });
});

describe("useGuiHarnessCatalog (batched interval removal regression)", () => {
  afterEach(() => {
    vi.useRealTimers();
    hostBindingMock.current = null;
    cleanup();
  });

  it("fetches the batched model fan-out once and schedules no background refetch in steady state", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => ({ harnesses: harnesses(["opencode"]) }),
      "agent.gui.listModels": () => {
        callCount += 1;
        return modelsResponse(1);
      },
    });

    renderHook(
      () => useGuiHarnessCatalog(null, { enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(callCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    });
    expect(callCount).toBe(1);
  });

  it("keeps an inactive batched model catalog cached past TanStack's default GC window", async () => {
    vi.useFakeTimers();
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => ({ harnesses: harnesses(["opencode"]) }),
      "agent.gui.listModels": () => modelsResponse(1),
    });

    const hook = renderHook(
      () => useGuiHarnessCatalog(null, { enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    hook.unmount();

    const modelQuery = fixture.queryClient
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey.includes("agent.gui.listModels"));
    if (modelQuery === undefined) {
      throw new Error("Expected the batched model catalog query to be cached");
    }
    expect(modelQuery.state.data).toEqual(modelsResponse(1));
    await fixture.queryClient.invalidateQueries({
      queryKey: modelQuery.queryKey,
      refetchType: "none",
    });
    expect(modelQuery.state.isInvalidated).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    });

    expect(fixture.queryClient.getQueryData(modelQuery.queryKey)).toEqual(
      modelsResponse(1),
    );
  });

  it("produces zero batched background requests past the 15-minute mark when a harness's model fetch persistently fails", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => ({ harnesses: harnesses(["opencode"]) }),
      "agent.gui.listModels": () => {
        callCount += 1;
        throw new Error("opencode server unavailable");
      },
    });

    renderHook(
      () => useGuiHarnessCatalog(null, { enabled: true, subscribed: true }),
      { wrapper: fixture.Wrapper },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    const callsAfterInitialFailure = callCount;
    expect(callsAfterInitialFailure).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    });
    expect(callCount).toBe(callsAfterInitialFailure);
  });
});
