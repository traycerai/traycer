import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  focusManager,
  QueryClientProvider,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  GuiHarnessId,
  ListGuiHarnessesResponse,
  ListGuiAgentCommandsResponse,
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
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import {
  HARNESS_CATALOG_REFRESH_AFTER_MS,
  harnessCatalogEntryNeedsRefresh,
  useGuiHarnessCatalog,
  useGuiHarnessCatalogForClient,
  useGuiHarnessCommandsQuery,
  useGuiHarnessesQuery,
  useGuiHarnessesQueryForClient,
  useGuiHarnessModelsQuery,
  useGuiHarnessModelsQueryForClient,
  useGuiHarnessModelsWarmup,
  useRefreshHarnessCatalog,
  useRefreshHarnessCatalogForClient,
} from "@/hooks/harnesses/use-gui-harness-catalog";

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => hostBindingMock.current,
  useHostClient: () => hostBindingMock.current?.hostClient ?? null,
  // The spine, a separate export since redesign P2.1.
  useHostRuntimeClient: () => hostBindingMock.current?.hostClient ?? null,
}));

/**
 * The default-host wrappers resolve the SELECTION LAYER's effective host, so a
 * fixture that only binds the client leaves every one of them addressing ∅.
 * Naming the effective host is part of building an app-wide host fixture.
 */
function setEffectiveHostId(hostId: string | null): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: hostId,
    targetHostId: hostId,
    effectiveHostId: hostId,
    leases: [],
    selectionRevision: 1,
  });
}

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
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestCounter += 1;
        return `req-${String(requestCounter)}`;
      },
      handlers,
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  hostBindingMock.current = { hostClient: client };
  setEffectiveHostId(mockLocalHostEntry.hostId);
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
    useSelectionAuthorityStore.getState().reset();
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
    useSelectionAuthorityStore.getState().reset();
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
    useSelectionAuthorityStore.getState().reset();
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
      () =>
        useGuiHarnessCatalog(null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
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
      () =>
        useGuiHarnessCatalog(null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
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
      () =>
        useGuiHarnessCatalog(null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
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

describe("useGuiHarnessCatalog cache-only label reader (MED5)", () => {
  afterEach(() => {
    vi.useRealTimers();
    hostBindingMock.current = null;
    useSelectionAuthorityStore.getState().reset();
    cleanup();
  });

  it("surfaces cached catalog labels to a visible-only reader that never fetches", async () => {
    vi.useFakeTimers();
    let harnessCalls = 0;
    let modelCalls = 0;
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => {
        harnessCalls += 1;
        return { harnesses: harnesses(["opencode"]) };
      },
      "agent.gui.listModels": () => {
        modelCalls += 1;
        return modelsResponse(2);
      },
    });

    // The prefetch/owner warms the host-keyed cache once.
    const owner = renderHook(
      () =>
        useGuiHarnessCatalog(null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(harnessCalls).toBe(1);
    expect(modelCalls).toBe(1);
    owner.unmount();

    // A VISIBLE-but-not-owning reader (enabled:false) reads the same cache with
    // no live publisher and issues zero requests, yet gets friendly labels.
    const reader = renderHook(
      () =>
        useGuiHarnessCatalog(null, {
          enabled: false,
          subscribed: true,
          modelsFetch: "cached-only",
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(harnessCalls).toBe(1);
    expect(modelCalls).toBe(1);
    expect(reader.result.current.harnesses).toHaveLength(1);
    expect(reader.result.current.harnesses[0].models).toHaveLength(2);
    expect(reader.result.current.harnesses[0].models[0].label).toBe("Model 0");
  });

  it("detaches a hidden reader: subscribed:false yields no catalog even with a warm cache", async () => {
    vi.useFakeTimers();
    const fixture = createCatalogFixture({
      "agent.gui.listHarnesses": () => ({ harnesses: harnesses(["opencode"]) }),
      "agent.gui.listModels": () => modelsResponse(2),
    });
    const owner = renderHook(
      () =>
        useGuiHarnessCatalog(null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    owner.unmount();

    const hidden = renderHook(
      () =>
        useGuiHarnessCatalog(null, {
          enabled: false,
          subscribed: false,
          modelsFetch: "cached-only",
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hidden.result.current.harnesses).toHaveLength(0);
  });
});

// Coverage for the composer host-scoping migration: every `…ForClient`
// catalog hook takes its client explicitly rather than resolving the
// app-wide default via `useHostBinding()`. These guard the two invariants a
// regression to the old default-host resolution would break: a refresh must
// hit ONLY the client's own host (never bleed into a sibling host's cache),
// and a `null` client (a composer whose host hasn't resolved yet) must
// disable the query outright rather than quietly falling back to whatever
// `useHostBinding()` currently reports.
describe("…ForClient catalog hooks are scoped to the client argument, not the app-wide default", () => {
  afterEach(() => {
    hostBindingMock.current = null;
    useSelectionAuthorityStore.getState().reset();
    cleanup();
  });

  interface HostCallCounts {
    harnesses: number;
    models: number;
    commands: number;
  }

  function buildHostClient(
    queryClient: QueryClient,
    hostId: string,
    calls: HostCallCounts,
  ): HostClient<HostRpcRegistry> {
    let requestCounter = 0;
    const entry = {
      hostId,
      label: hostId,
      kind: "local" as const,
      websocketUrl: `ws://127.0.0.1:0/${hostId}`,
      version: "0.0.0-mock",
      transportDialability: "dialable" as const,
    };
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (id) => (id === entry.hostId ? entry : null),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestCounter += 1;
          return `req-${hostId}-${String(requestCounter)}`;
        },
        handlers: {
          "agent.gui.listHarnesses": () => {
            calls.harnesses += 1;
            return { harnesses: harnesses(["opencode"]) };
          },
          "agent.gui.listModels": () => {
            calls.models += 1;
            return modelsResponse(1);
          },
          "agent.gui.listCommands": (): ListGuiAgentCommandsResponse => {
            calls.commands += 1;
            return { harnessId: "opencode", commands: [] };
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: `tok-${hostId}`,
      }),
    );
    return spine.createRequester(entry);
  }

  it("useRefreshHarnessCatalogForClient invalidates only the target host's three catalog methods, leaving another host's cache untouched", async () => {
    const queryClient = createAppQueryClient();
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const hostACalls: HostCallCounts = { harnesses: 0, models: 0, commands: 0 };
    const hostBCalls: HostCallCounts = { harnesses: 0, models: 0, commands: 0 };
    const clientA = buildHostClient(queryClient, "host-a", hostACalls);
    const clientB = buildHostClient(queryClient, "host-b", hostBCalls);

    renderHook(
      () => {
        useGuiHarnessesQueryForClient(clientA, {
          enabled: true,
          subscribed: true,
        });
        useGuiHarnessModelsQueryForClient(clientA, "opencode", null, {
          enabled: true,
          subscribed: true,
        });
        useGuiHarnessCommandsQuery(clientA, "opencode", [], {
          enabled: true,
          subscribed: true,
        });
      },
      { wrapper: Wrapper },
    );
    renderHook(
      () => {
        useGuiHarnessesQueryForClient(clientB, {
          enabled: true,
          subscribed: true,
        });
        useGuiHarnessModelsQueryForClient(clientB, "opencode", null, {
          enabled: true,
          subscribed: true,
        });
        useGuiHarnessCommandsQuery(clientB, "opencode", [], {
          enabled: true,
          subscribed: true,
        });
      },
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(hostACalls).toEqual({ harnesses: 1, models: 1, commands: 1 });
      expect(hostBCalls).toEqual({ harnesses: 1, models: 1, commands: 1 });
    });

    const { result } = renderHook(
      () => useRefreshHarnessCatalogForClient(clientB),
      { wrapper: Wrapper },
    );
    await act(async () => {
      await result.current();
    });

    // Host B's three catalog methods were re-fetched by the refresh...
    await waitFor(() => {
      expect(hostBCalls).toEqual({ harnesses: 2, models: 2, commands: 2 });
    });
    // ...and host A's cache - a DIFFERENT client, never passed to the
    // refresh - was never touched. A regression that resolved the refresh
    // target through the app-wide default (rather than the `client`
    // argument) would either refresh the wrong host or refresh both.
    expect(hostACalls).toEqual({ harnesses: 1, models: 1, commands: 1 });
  });

  it("useGuiHarnessesQueryForClient(null, …) disables the query outright - never falls back to the app-wide default host", async () => {
    const queryClient = createAppQueryClient();
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    // A live default-host binding IS present (mirrors a real app where some
    // OTHER host is the app-wide default) - if `client: null` ever fell back
    // to it, this fixture would make that fallback observable as fetched
    // data. `useGuiHarnessesQueryForClient` never reads `useHostBinding()`,
    // so the fixture is a negative control: it must never be consulted.
    const defaultHostCalls: HostCallCounts = {
      harnesses: 0,
      models: 0,
      commands: 0,
    };
    hostBindingMock.current = {
      hostClient: buildHostClient(
        queryClient,
        "default-host",
        defaultHostCalls,
      ),
    };
    setEffectiveHostId("default-host");

    const { result } = renderHook(
      () =>
        useGuiHarnessesQueryForClient(null, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    expect(defaultHostCalls).toEqual({ harnesses: 0, models: 0, commands: 0 });
  });

  it("useGuiHarnessCatalogForClient(null, …) reports an empty catalog that is NOT loading - a disabled query is not a fetch in flight", async () => {
    const queryClient = createAppQueryClient();
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    const defaultHostCalls: HostCallCounts = {
      harnesses: 0,
      models: 0,
      commands: 0,
    };
    hostBindingMock.current = {
      hostClient: buildHostClient(
        queryClient,
        "default-host",
        defaultHostCalls,
      ),
    };
    setEffectiveHostId("default-host");

    const { result } = renderHook(
      () =>
        useGuiHarnessCatalogForClient(null, null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await Promise.resolve();
    });

    // The underlying query is disabled (`isPending: true` forever, see the
    // sibling test) - the composed catalog must not surface that as
    // "loading", or every consumer (the picker rail, the palette) would spin
    // for a fetch that never starts.
    expect(result.current.harnesses).toEqual([]);
    expect(result.current.harnessesLoading).toBe(false);
    expect(result.current.modelsLoading).toBe(false);
    expect(result.current.harnessesError).toBeNull();
    expect(defaultHostCalls).toEqual({ harnesses: 0, models: 0, commands: 0 });
  });
});

// The intent-edge freshness predicate, as a unit: the in-flight arm cannot be
// proven through a mocked transport (it honors the abort before its handler
// runs, so the canceled first request of a cancel-and-re-issue never shows in
// an RPC count), but on a real host both requests arrive - the picker's
// intent-rpc suite counts the OTHER arms and leans on this one directly.
describe("harnessCatalogEntryNeedsRefresh", () => {
  it("never reports an in-flight entry as due - refetch() defaults to cancelRefetch, so 'due' would cancel and re-issue the request underway", () => {
    // The cold browse-commit race: the enabled-transition fetch has already
    // dispatched (dataUpdatedAt still 0) when the selection intent edge asks.
    expect(
      harnessCatalogEntryNeedsRefresh({
        dataUpdatedAt: 0,
        isError: false,
        isFetching: true,
      }),
    ).toBe(false);
    // Same while an errored entry's recovery refetch is already underway.
    expect(
      harnessCatalogEntryNeedsRefresh({
        dataUpdatedAt: 1,
        isError: true,
        isFetching: true,
      }),
    ).toBe(false);
  });

  it("keeps the due arms: never-loaded, errored and aged entries refresh; a fresh one does not", () => {
    expect(
      harnessCatalogEntryNeedsRefresh({
        dataUpdatedAt: 0,
        isError: false,
        isFetching: false,
      }),
    ).toBe(true);
    expect(
      harnessCatalogEntryNeedsRefresh({
        dataUpdatedAt: Date.now(),
        isError: true,
        isFetching: false,
      }),
    ).toBe(true);
    expect(
      harnessCatalogEntryNeedsRefresh({
        dataUpdatedAt: Date.now() - HARNESS_CATALOG_REFRESH_AFTER_MS - 1,
        isError: false,
        isFetching: false,
      }),
    ).toBe(true);
    expect(
      harnessCatalogEntryNeedsRefresh({
        dataUpdatedAt: Date.now(),
        isError: false,
        isFetching: false,
      }),
    ).toBe(false);
  });
});

// Coverage for the cold-host narrowing: the all-harness `listModels` fan-out
// belongs to the app-load fill alone (`modelsFetch: "all-harnesses"`); every
// user-facing surface passes `"cached-only"` and warms specific harnesses
// through its own targeted query on the shared cache slot. TanStack's no-data
// path ignores `staleTime`, so before this scope existed ANY enabled catalog
// mount on a cold (non-prefetched, usually remote) host fanned `listModels`
// across every available harness - one spawned provider server per rail entry,
// on first picker open.
describe('useGuiHarnessCatalogForClient modelsFetch: "cached-only"', () => {
  afterEach(() => {
    hostBindingMock.current = null;
    useSelectionAuthorityStore.getState().reset();
    cleanup();
  });

  interface ScopedFixture {
    readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
    readonly client: HostClient<HostRpcRegistry>;
    /** Harness ids of every `agent.gui.listModels` request, in arrival order. */
    readonly modelCalls: GuiHarnessId[];
  }

  function createScopedFixture(
    ids: ReadonlyArray<GuiHarnessId>,
    listModelsHandler:
      | (() => Promise<ListGuiAgentModelsResponse> | ListGuiAgentModelsResponse)
      | null,
  ): ScopedFixture {
    const queryClient = createAppQueryClient();
    const modelCalls: GuiHarnessId[] = [];
    let requestCounter = 0;
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => {
          requestCounter += 1;
          return `req-${String(requestCounter)}`;
        },
        handlers: {
          "agent.gui.listHarnesses": () => ({ harnesses: harnesses(ids) }),
          "agent.gui.listModels": (params) => {
            modelCalls.push(params.harnessId);
            return listModelsHandler === null
              ? modelsResponse(1)
              : listModelsHandler();
          },
        },
      }),
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
    return { Wrapper, client, modelCalls };
  }

  it("issues ZERO listModels on a cold cache, and reports entries as not loading rather than eternally pending", async () => {
    const fixture = createScopedFixture(["opencode", "claude"], null);
    const { result } = renderHook(
      () =>
        useGuiHarnessCatalogForClient(fixture.client, null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "cached-only",
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(result.current.harnesses).toHaveLength(2);
    });
    // The fan-out (were it enabled) dispatches in an effect right after the
    // harness list lands - give it that beat so this asserts absence where
    // absence would show, not before the code under test could have run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.modelCalls).toEqual([]);
    // The trap the `isLoading` predicate exists for: a disabled observer on a
    // no-data slot is `isPending` forever, and surfacing that as "loading"
    // would spin every consumer for a fetch that never starts.
    expect(result.current.harnesses[0].modelsLoading).toBe(false);
    expect(result.current.modelsLoading).toBe(false);
  });

  it('"all-harnesses" on the same fixture still fans out across every available harness - the positive control for the zero above', async () => {
    const fixture = createScopedFixture(["opencode", "claude"], null);
    renderHook(
      () =>
        useGuiHarnessCatalogForClient(fixture.client, null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "all-harnesses",
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect([...fixture.modelCalls].sort()).toEqual(["claude", "opencode"]);
    });
  });

  it("surfaces models a targeted per-harness query fetched into the shared slot, leaving every other harness unfetched", async () => {
    const fixture = createScopedFixture(["opencode", "claude"], null);
    const { result } = renderHook(
      () => ({
        catalog: useGuiHarnessCatalogForClient(fixture.client, null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "cached-only",
        }),
        // The picker's composition: its own standalone query for the harness
        // it is actually about (selected/browsed), same cache slot.
        selected: useGuiHarnessModelsQueryForClient(
          fixture.client,
          "opencode",
          null,
          { enabled: true, subscribed: true },
        ),
      }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      const entry = result.current.catalog.harnesses.find(
        (harness) => harness.id === "opencode",
      );
      expect(entry?.models).toHaveLength(1);
    });
    expect(fixture.modelCalls).toEqual(["opencode"]);
    const claude = result.current.catalog.harnesses.find(
      (harness) => harness.id === "claude",
    );
    expect(claude?.models).toHaveLength(0);
    expect(claude?.modelsLoading).toBe(false);
  });

  it("reports modelsLoading for exactly the harness a targeted fetch is filling, while it is in flight", async () => {
    // The initializer is unreachable: a Promise executor runs synchronously,
    // so `release` is the real resolver before the fixture is even built -
    // but TS cannot see that, and a `| null` type would narrow the later call
    // to `null`.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createScopedFixture(["opencode", "claude"], async () => {
      await gate;
      return modelsResponse(1);
    });
    const { result } = renderHook(
      () => ({
        catalog: useGuiHarnessCatalogForClient(fixture.client, null, {
          enabled: true,
          subscribed: true,
          modelsFetch: "cached-only",
        }),
        selected: useGuiHarnessModelsQueryForClient(
          fixture.client,
          "opencode",
          null,
          { enabled: true, subscribed: true },
        ),
      }),
      { wrapper: fixture.Wrapper },
    );
    // The cached-only entry tracks the SHARED slot's fetch state, so the
    // in-flight targeted fetch shows as loading on the catalog entry too...
    await waitFor(() => {
      const entry = result.current.catalog.harnesses.find(
        (harness) => harness.id === "opencode",
      );
      expect(entry?.modelsLoading).toBe(true);
    });
    // ...while a slot nothing is filling stays honestly not-loading.
    const claudeDuring = result.current.catalog.harnesses.find(
      (harness) => harness.id === "claude",
    );
    expect(claudeDuring?.modelsLoading).toBe(false);
    release();
    await waitFor(() => {
      const entry = result.current.catalog.harnesses.find(
        (harness) => harness.id === "opencode",
      );
      expect(entry?.models).toHaveLength(1);
      expect(entry?.modelsLoading).toBe(false);
    });
  });

  it("useGuiHarnessModelsWarmup fetches its one subject harness exactly once, and nothing for a null subject", async () => {
    const fixture = createScopedFixture(["opencode", "claude"], null);
    const noSubject = renderHook(
      () =>
        useGuiHarnessModelsWarmup(fixture.client, null, {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.modelCalls).toEqual([]);
    noSubject.unmount();

    const warm = renderHook(
      () =>
        useGuiHarnessModelsWarmup(fixture.client, "claude", {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(fixture.modelCalls).toEqual(["claude"]);
    });
    warm.unmount();
    // Cache-only contract: a warm slot is never re-pulled by a remount.
    renderHook(
      () =>
        useGuiHarnessModelsWarmup(fixture.client, "claude", {
          enabled: true,
          subscribed: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.modelCalls).toEqual(["claude"]);
  });
});
