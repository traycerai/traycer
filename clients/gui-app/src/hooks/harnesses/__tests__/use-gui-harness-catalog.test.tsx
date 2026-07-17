import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
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
import { createAppQueryClient } from "@/lib/query-client";
import {
  nextHarnessAvailabilityRefetchInterval,
  useGuiHarnessCatalog,
  useGuiHarnessModelsQuery,
} from "@/hooks/harnesses/use-gui-harness-catalog";

const hostBindingMock = vi.hoisted(() => ({
  current: null as { readonly hostClient: unknown } | null,
}));
vi.mock("@/lib/host/runtime", () => ({
  useHostBinding: () => hostBindingMock.current,
}));

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const RETRY_MIN_MS = 30 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

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

const PENDING_REFRESH_MS = 800;

describe("nextHarnessAvailabilityRefetchInterval", () => {
  it("keeps the steady-state interval before any data arrives", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "no-data",
        dataUpdateCount: 0,
        data: undefined,
      }),
    ).toBe(FIFTEEN_MIN_MS);
  });

  it("keeps the steady-state interval when every harness is available", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "all-available",
        dataUpdateCount: 1,
        data: response(true, false),
      }),
    ).toBe(FIFTEEN_MIN_MS);
  });

  it("fast-polls at 800ms when any harness has availabilityPending", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "pending",
        dataUpdateCount: 1,
        data: response(false, true),
      }),
    ).toBe(PENDING_REFRESH_MS);
  });

  it("retries at the host-cache TTL on the first unavailable result", () => {
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: "first-unavailable",
        dataUpdateCount: 1,
        data: response(false, false),
      }),
    ).toBe(RETRY_MIN_MS);
  });

  it("backs off exponentially toward the ceiling across successive fetches", () => {
    const hash = "backoff";
    const intervals = [1, 2, 3, 4, 5, 6].map((dataUpdateCount) =>
      nextHarnessAvailabilityRefetchInterval({
        queryHash: hash,
        dataUpdateCount,
        data: response(false, false),
      }),
    );
    expect(intervals).toEqual([
      RETRY_MIN_MS, // 30s
      RETRY_MIN_MS * 2, // 1m
      RETRY_MIN_MS * 4, // 2m
      RETRY_MIN_MS * 8, // 4m
      RETRY_MAX_MS, // capped at 5m
      RETRY_MAX_MS,
    ]);
  });

  it("does not advance the backoff when re-evaluated for the same fetch", () => {
    const hash = "same-fetch";
    const first = nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 7,
      data: response(false, false),
    });
    const second = nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 7,
      data: response(false, false),
    });
    expect(first).toBe(RETRY_MIN_MS);
    expect(second).toBe(RETRY_MIN_MS);
  });

  it("resets the backoff once the catalog recovers", () => {
    const hash = "recovery";
    nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 1,
      data: response(false, false),
    });
    nextHarnessAvailabilityRefetchInterval({
      queryHash: hash,
      dataUpdateCount: 2,
      data: response(false, false),
    });
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: hash,
        dataUpdateCount: 3,
        data: response(true, false),
      }),
    ).toBe(FIFTEEN_MIN_MS);
    // A later drop starts the backoff over from the host-cache TTL.
    expect(
      nextHarnessAvailabilityRefetchInterval({
        queryHash: hash,
        dataUpdateCount: 4,
        data: response(false, false),
      }),
    ).toBe(RETRY_MIN_MS);
  });
});

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
