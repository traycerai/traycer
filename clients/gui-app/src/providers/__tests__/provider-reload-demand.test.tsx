/**
 * One renderer reload against a warm host: how many host requests do the
 * provider-facing readers issue in total?
 *
 * Real pieces: `ProvidersChangedStreamMount`, two `providers.list` observers,
 * two `agent.gui.listHarnesses` observers, and the ephemeral rate-limit lane
 * (`fetchProviderRateLimits` -> `mapResponseToProviderRateLimitEnvelope`) for
 * the four managed-capable providers. Faked: only the `providers.changed`
 * session (controlled by the test) and the host itself, a `MockHostMessenger`
 * whose `calls` log counts every request that leaves the client, whichever
 * entry point (`requestWithSignal`, `requestWithOptions`,
 * `requestWithResponseTimeout`) sent it.
 *
 * Timing uses real timers: the mount coalesces invalidations over a 50ms
 * window, and each step below waits past it so a stray refresh has landed
 * before the next step is taken. Scenario J is the one exception: the stream's
 * 5s reopen backoff is stepped with a fake `setTimeout` for that window only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import { HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useGuiHarnessesQueryForClient } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { queryKeys } from "@/lib/query-keys";
import { providersListQueryKey } from "@/lib/query-keys/providers-query-keys";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  __resetProviderRateLimitFetchesForTests,
  fetchProviderRateLimits,
} from "@/lib/rate-limits/provider-rate-limit-fetch";
import type { RateLimitUsageResponse } from "@/lib/rate-limits/rate-limit-envelope";
import { ProvidersChangedStreamMount } from "@/providers/providers-changed-stream-mount";

const HOST_ID = mockLocalHostEntry.hostId;

/** Longer than the mount's 50ms coalescing window. */
const PAST_COALESCING_WINDOW_MS = 90;

const MANAGED_PROVIDERS = [
  "codex",
  "claude-code",
  "grok",
  "antigravity",
] as const satisfies ReadonlyArray<RateLimitProviderId>;

interface OpenedProvidersStream {
  readonly emitChanged: (providerId: ProviderId) => void;
  readonly emitStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

interface ProvidersStreamState {
  readonly opened: Array<OpenedProvidersStream>;
  support: StreamMethodSupport | null;
  hostId: string | null;
}

const streamState = vi.hoisted((): ProvidersStreamState => ({
  opened: [],
  support: "supported",
  hostId: null,
}));

const stubWsStreamClient = vi.hoisted((): { readonly stub: true } => ({
  stub: true,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/providers-changed-stream-client",
  () => ({
    ProvidersChangedStreamClient: class {
      constructor(options: {
        readonly onChanged: (providerId: ProviderId) => void;
        readonly onConnectionStatus: (
          status: StreamConnectionStatus,
          reason: StreamCloseReason | null,
        ) => void;
      }) {
        streamState.opened.push({
          emitChanged: options.onChanged,
          emitStatus: options.onConnectionStatus,
        });
      }

      close(): void {}
    },
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => stubWsStreamClient,
  useStreamMethodSupport: () => streamState.support,
  useStreamHostId: () => streamState.hostId,
}));

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function availableRateLimits(
  providerId: RateLimitProviderId,
): RateLimitUsageResponse {
  const usage = { usedPercent: 10, resetsAt: null, durationMinutes: 300 };
  switch (providerId) {
    case "codex":
      return {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "codex",
          available: true,
          planType: "plus",
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          extraWindows: [],
          credits: null,
          individualLimit: null,
          resetCredits: null,
          rateLimitReachedType: null,
        },
      };
    case "claude-code":
      return {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "claude-code",
          available: true,
          subscriptionType: "max",
          fiveHour: usage,
          sevenDay: null,
          sevenDayOpus: null,
          sevenDaySonnet: null,
          modelScoped: [],
          extraUsage: null,
        },
      };
    case "grok":
      return {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "grok",
          available: true,
          subscriptionTier: "SuperGrok",
          periodType: "USAGE_PERIOD_TYPE_WEEKLY",
          periodStart: 1_784_678_400_000,
          periodEnd: 1_785_283_200_000,
          period: { ...usage, durationMinutes: 10_080 },
          monthlyLimit: null,
          onDemandCap: null,
          onDemandUsed: null,
          prepaidBalance: null,
        },
      };
    case "antigravity":
      return {
        totalTokens: 0,
        remainingTokens: 0,
        providerRateLimits: {
          provider: "antigravity",
          available: true,
          planName: null,
          groups: [],
        },
      };
    default:
      throw new Error(`no fixture for rate-limit provider ${providerId}`);
  }
}

function isManagedProvider(
  providerId: string | undefined,
): providerId is RateLimitProviderId {
  return MANAGED_PROVIDERS.some((id) => id === providerId);
}

function providerIdOf(params: unknown): string {
  if (
    typeof params === "object" &&
    params !== null &&
    "providerId" in params &&
    typeof params.providerId === "string"
  ) {
    return params.providerId;
  }
  throw new Error("request carried no providerId");
}

interface HostCounts {
  readonly providersList: number;
  readonly listHarnesses: number;
  readonly rateLimit: Readonly<Record<string, number>>;
}

interface HarnessOptions {
  /** `providers.list` calls stay in flight until `releaseProvidersList`. */
  readonly providersListGated: boolean;
  /** `agent.gui.listHarnesses` calls stay in flight until `releaseHarnesses`. */
  readonly harnessesGated: boolean;
  /** 1-based `providers.list` call numbers that fail with an application error. */
  readonly failingProvidersListCalls: ReadonlyArray<number>;
}

const UNGATED: HarnessOptions = {
  providersListGated: false,
  harnessesGated: false,
  failingProvidersListCalls: [],
};

const GATED: HarnessOptions = {
  ...UNGATED,
  providersListGated: true,
  harnessesGated: true,
};

interface ReloadHarness {
  readonly queryClient: QueryClient;
  readonly counts: () => HostCounts;
  readonly releaseInitialReads: () => void;
  readonly releaseHarnesses: () => void;
  /** Answers the pending `host.getRateLimitUsage` reads of one provider; later
   *  reads of it answer immediately. */
  readonly resolveRateLimit: (providerId: RateLimitProviderId) => void;
  readonly startRateLimitReads: (
    providerIds: ReadonlyArray<RateLimitProviderId>,
    force: boolean,
  ) => void;
  readonly mountObservers: () => void;
  readonly mountStream: () => void;
  readonly mountReloadTree: () => void;
}

function createReloadHarness(options: HarnessOptions): ReloadHarness {
  const queryClient = createAppQueryClient();
  if (options.failingProvidersListCalls.length > 0) {
    // The app default retries a failed read once after a delay, which keeps the
    // query pending rather than `error`; this scenario needs it settled in
    // `error` before the stream opens.
    queryClient.setDefaultOptions({ queries: { retry: false } });
  }
  const providersListGate = createDeferred();
  if (!options.providersListGated) providersListGate.resolve();
  const harnessesGate = createDeferred();
  if (!options.harnessesGated) harnessesGate.resolve();
  const rateLimitGates = new Map<string, Deferred>();
  for (const providerId of MANAGED_PROVIDERS) {
    rateLimitGates.set(providerId, createDeferred());
  }

  let requestCounter = 0;
  let providersListCalls = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestCounter += 1;
      return `req-${String(requestCounter)}`;
    },
    handlers: {
      "providers.list": async () => {
        providersListCalls += 1;
        await providersListGate.promise;
        if (options.failingProvidersListCalls.includes(providersListCalls)) {
          throw new Error("providers.list application error");
        }
        return { providers: [], native: null };
      },
      "agent.gui.listHarnesses": async () => {
        await harnessesGate.promise;
        return { harnesses: [] };
      },
      "host.getRateLimitUsage": async (params) => {
        const providerId = params.providerId;
        if (!isManagedProvider(providerId)) {
          throw new Error(
            `unexpected rate-limit provider ${String(providerId)}`,
          );
        }
        const gate = rateLimitGates.get(providerId);
        if (gate === undefined) throw new Error(`no gate for ${providerId}`);
        await gate.promise;
        return availableRateLimits(providerId);
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  streamState.hostId = HOST_ID;

  function ProvidersListObserver(): ReactNode {
    useProvidersListForClient(client, { enabled: true, subscribed: true });
    return null;
  }
  function HarnessesObserver(): ReactNode {
    useGuiHarnessesQueryForClient(client, { enabled: true, subscribed: true });
    return null;
  }
  const mountObservers = (): void => {
    render(
      <QueryClientProvider client={queryClient}>
        <ProvidersListObserver />
        <ProvidersListObserver />
        <HarnessesObserver />
        <HarnessesObserver />
      </QueryClientProvider>,
    );
  };
  const mountStream = (): void => {
    render(
      <QueryClientProvider client={queryClient}>
        <ProvidersChangedStreamMount />
      </QueryClientProvider>,
    );
  };

  return {
    queryClient,
    counts: () => {
      const rateLimit: Record<string, number> = {};
      for (const providerId of MANAGED_PROVIDERS) rateLimit[providerId] = 0;
      let providersList = 0;
      let listHarnesses = 0;
      for (const call of messenger.calls) {
        if (call.method === "providers.list") providersList += 1;
        else if (call.method === "agent.gui.listHarnesses") listHarnesses += 1;
        else if (call.method === "host.getRateLimitUsage") {
          const providerId = providerIdOf(call.params);
          rateLimit[providerId] = (rateLimit[providerId] ?? 0) + 1;
        }
      }
      return { providersList, listHarnesses, rateLimit };
    },
    releaseInitialReads: () => {
      providersListGate.resolve();
      harnessesGate.resolve();
    },
    releaseHarnesses: harnessesGate.resolve,
    resolveRateLimit: (providerId) => {
      rateLimitGates.get(providerId)?.resolve();
    },
    startRateLimitReads: (providerIds, force) => {
      for (const providerId of providerIds) {
        void fetchProviderRateLimits(
          {
            hostId: HOST_ID,
            queryClient,
            request: (method, params, responseTimeoutMs) =>
              client.requestWithResponseTimeout(
                method,
                params,
                responseTimeoutMs,
              ),
          },
          {
            providerId,
            accountContext: DEFAULT_ACCOUNT_CONTEXT,
            profileId: null,
          },
          { force },
        );
      }
    },
    mountObservers,
    mountStream,
    mountReloadTree: () => {
      mountStream();
      mountObservers();
    },
  };
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  });
}

async function openStream(): Promise<void> {
  const stream = streamState.opened.at(-1);
  if (stream === undefined) throw new Error("no providers stream opened");
  act(() => {
    stream.emitStatus("open", null);
  });
  await settle(PAST_COALESCING_WINDOW_MS);
}

function closeStream(): void {
  const stream = streamState.opened.at(-1);
  if (stream === undefined) throw new Error("no providers stream opened");
  act(() => {
    stream.emitStatus("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "test close",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
  });
}

/**
 * The 4 rate-limit reads resolve one by one, each followed by a settled window.
 * Returns how many `providers.list` reads had been issued when only the last
 * read was still outstanding.
 */
async function resolveRateLimitReadsOneByOne(
  harness: ReloadHarness,
): Promise<number> {
  let providersListBeforeLastRead = 0;
  for (const [index, providerId] of MANAGED_PROVIDERS.entries()) {
    if (index === MANAGED_PROVIDERS.length - 1) {
      providersListBeforeLastRead = harness.counts().providersList;
    }
    harness.resolveRateLimit(providerId);
    await settle(PAST_COALESCING_WINDOW_MS);
  }
  return providersListBeforeLastRead;
}

const EVERY_RATE_LIMIT_ONCE = {
  codex: 1,
  "claude-code": 1,
  grok: 1,
  antigravity: 1,
};

/**
 * A reload's total demand: `providers.list` is read once at mount and once
 * more, after the last rate-limit read settles, to converge the profile rows
 * those reads updated.
 */
const RELOAD_DEMAND: HostCounts = {
  providersList: 2,
  listHarnesses: 1,
  rateLimit: EVERY_RATE_LIMIT_ONCE,
};

function deltaSince(before: HostCounts, after: HostCounts): HostCounts {
  const rateLimit: Record<string, number> = {};
  for (const providerId of MANAGED_PROVIDERS) {
    rateLimit[providerId] =
      (after.rateLimit[providerId] ?? 0) - (before.rateLimit[providerId] ?? 0);
  }
  return {
    providersList: after.providersList - before.providersList,
    listHarnesses: after.listHarnesses - before.listHarnesses,
    rateLimit,
  };
}

const NO_RATE_LIMIT_READS = {
  codex: 0,
  "claude-code": 0,
  grok: 0,
  antigravity: 0,
};

async function refetchProvidersList(harness: ReloadHarness): Promise<void> {
  await act(async () => {
    await harness.queryClient.invalidateQueries({
      queryKey: providersListQueryKey(HOST_ID),
    });
  });
}

function expectProvidersListErroredWithData(harness: ReloadHarness): void {
  const state = harness.queryClient.getQueryState(
    providersListQueryKey(HOST_ID),
  );
  expect({
    status: state?.status,
    hasData: state?.data !== undefined,
  }).toEqual({ status: "error", hasData: true });
}

/** Scenario A: stream opens with the initial catalog reads still in flight. */
async function reloadWithStreamOpeningDuringInitialReads(
  harness: ReloadHarness,
): Promise<number> {
  harness.mountReloadTree();
  harness.startRateLimitReads(MANAGED_PROVIDERS, false);
  await settle(10);
  await openStream();
  harness.releaseInitialReads();
  await settle(PAST_COALESCING_WINDOW_MS);
  return resolveRateLimitReadsOneByOne(harness);
}

describe("one renderer reload against a warm host", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    resetHostConnectionRegistryForTest();
    __resetProviderRateLimitFetchesForTests();
    streamState.opened.length = 0;
    streamState.support = "supported";
    streamState.hostId = null;
  });

  it("A: stream opens while the initial reads are in flight -> one convergence read, after the last rate-limit read settles", async () => {
    const harness = createReloadHarness(GATED);

    const providersListBeforeLastRead =
      await reloadWithStreamOpeningDuringInitialReads(harness);

    expect({
      providersListBeforeLastRateLimitRead: providersListBeforeLastRead,
      final: harness.counts(),
    }).toEqual({
      providersListBeforeLastRateLimitRead: 1,
      final: RELOAD_DEMAND,
    });
  });

  it("B: initial reads resolve before the stream opens -> one convergence read, after the last rate-limit read settles", async () => {
    const harness = createReloadHarness(UNGATED);

    harness.mountReloadTree();
    harness.startRateLimitReads(MANAGED_PROVIDERS, false);
    await settle(PAST_COALESCING_WINDOW_MS);
    await openStream();
    const providersListBeforeLastRead =
      await resolveRateLimitReadsOneByOne(harness);

    expect({
      providersListBeforeLastRateLimitRead: providersListBeforeLastRead,
      final: harness.counts(),
    }).toEqual({
      providersListBeforeLastRateLimitRead: 1,
      final: RELOAD_DEMAND,
    });
  });

  it("C: a providers.changed frame after the reload settles -> exactly one more providers.list and listHarnesses read", async () => {
    const harness = createReloadHarness(GATED);
    await reloadWithStreamOpeningDuringInitialReads(harness);
    const before = harness.counts();

    act(() => {
      streamState.opened.at(-1)?.emitChanged("codex");
    });
    await settle(PAST_COALESCING_WINDOW_MS);

    expect(deltaSince(before, harness.counts())).toEqual({
      providersList: 1,
      listHarnesses: 1,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });

  it("D: the stream closes and re-opens after the reload settles -> exactly one catch-up providers.list and listHarnesses read", async () => {
    const harness = createReloadHarness(GATED);
    await reloadWithStreamOpeningDuringInitialReads(harness);
    const before = harness.counts();

    closeStream();
    await openStream();

    expect(deltaSince(before, harness.counts())).toEqual({
      providersList: 1,
      listHarnesses: 1,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });

  it("F: no providers.changed stream for the host -> rate-limit reads still converge providers.list, once", async () => {
    streamState.support = "unsupported";
    const harness = createReloadHarness(UNGATED);

    harness.mountReloadTree();
    harness.startRateLimitReads(MANAGED_PROVIDERS, false);
    await settle(PAST_COALESCING_WINDOW_MS);
    expect(streamState.opened).toHaveLength(0);
    const before = harness.counts();
    await resolveRateLimitReadsOneByOne(harness);

    expect(deltaSince(before, harness.counts())).toEqual({
      providersList: 1,
      listHarnesses: 0,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });

  it("G: two rate-limit reads resolving in the same tick -> exactly one convergence read", async () => {
    const harness = createReloadHarness(UNGATED);
    harness.mountReloadTree();
    harness.startRateLimitReads(["codex", "claude-code"], false);
    await settle(PAST_COALESCING_WINDOW_MS);
    await openStream();
    const before = harness.counts();

    harness.resolveRateLimit("codex");
    harness.resolveRateLimit("claude-code");
    await settle(PAST_COALESCING_WINDOW_MS);

    expect(deltaSince(before, harness.counts())).toEqual({
      providersList: 1,
      listHarnesses: 0,
      rateLimit: NO_RATE_LIMIT_READS,
    });
    expect(harness.counts().rateLimit).toEqual({
      ...NO_RATE_LIMIT_READS,
      codex: 1,
      "claude-code": 1,
    });
  });

  it("H: one more rate-limit read after the reload settles -> exactly one more providers.list read", async () => {
    const harness = createReloadHarness(GATED);
    await reloadWithStreamOpeningDuringInitialReads(harness);
    const before = harness.counts();

    harness.startRateLimitReads(["codex"], true);
    await settle(PAST_COALESCING_WINDOW_MS);

    expect(deltaSince(before, harness.counts())).toEqual({
      providersList: 1,
      listHarnesses: 0,
      rateLimit: { ...NO_RATE_LIMIT_READS, codex: 1 },
    });
  });

  it("I: a providers.list read that errored before the first open is retried once by it; a read answered during the handshake is not", async () => {
    const harness = createReloadHarness({
      providersListGated: false,
      harnessesGated: true,
      failingProvidersListCalls: [1],
    });
    harness.mountObservers();
    await settle(PAST_COALESCING_WINDOW_MS);
    expect(
      harness.queryClient.getQueryState(providersListQueryKey(HOST_ID))?.status,
    ).toBe("error");

    harness.mountStream();
    await settle(10);
    harness.releaseHarnesses();
    await settle(PAST_COALESCING_WINDOW_MS);
    await openStream();

    expect(harness.counts()).toEqual({
      providersList: 2,
      listHarnesses: 1,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });

  it("I2: a providers.list read that errored after pre-subscribe data was cached is retried by the first open", async () => {
    const harness = createReloadHarness({
      ...UNGATED,
      failingProvidersListCalls: [2],
    });
    harness.mountObservers();
    await settle(PAST_COALESCING_WINDOW_MS);
    await refetchProvidersList(harness);
    expectProvidersListErroredWithData(harness);

    harness.mountStream();
    await settle(10);
    await openStream();

    expect(harness.counts()).toEqual({
      providersList: 3,
      listHarnesses: 2,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });

  it("I3: pre-subscribe data whose refetch errored during the handshake is still caught up by the first open", async () => {
    const harness = createReloadHarness({
      ...UNGATED,
      failingProvidersListCalls: [2],
    });
    harness.mountObservers();
    await settle(PAST_COALESCING_WINDOW_MS);
    harness.mountStream();
    await settle(10);
    await refetchProvidersList(harness);
    expectProvidersListErroredWithData(harness);
    await openStream();

    expect(harness.counts()).toEqual({
      providersList: 3,
      listHarnesses: 2,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });

  it("K: the last in-flight rate-limit read is removed from the cache while fetching -> the convergence read still happens, once", async () => {
    const harness = createReloadHarness(UNGATED);
    harness.mountReloadTree();
    harness.startRateLimitReads(["codex", "claude-code"], false);
    await settle(PAST_COALESCING_WINDOW_MS);
    await openStream();
    const before = harness.counts();

    harness.resolveRateLimit("codex");
    await settle(PAST_COALESCING_WINDOW_MS);
    const afterFirstRead = harness.counts();
    act(() => {
      harness.queryClient.removeQueries({
        queryKey: queryKeys.hostMethod<
          HostRpcRegistry,
          "host.getRateLimitUsage"
        >(HOST_ID, "host.getRateLimitUsage", {
          accountContext: DEFAULT_ACCOUNT_CONTEXT,
          providerId: "claude-code",
          profileId: null,
        }),
      });
    });
    await settle(PAST_COALESCING_WINDOW_MS);

    expect({
      whileOneReadStillInFlight: deltaSince(before, afterFirstRead)
        .providersList,
      afterItWasRemoved: deltaSince(before, harness.counts()).providersList,
    }).toEqual({ whileOneReadStillInFlight: 0, afterItWasRemoved: 1 });
  });

  it("L: while one rate-limit read is still in flight no convergence happens, however long; exactly one once it settles", async () => {
    const harness = createReloadHarness(UNGATED);
    harness.mountReloadTree();
    harness.startRateLimitReads(MANAGED_PROVIDERS, false);
    await settle(PAST_COALESCING_WINDOW_MS);
    await openStream();
    const before = harness.counts();

    harness.resolveRateLimit("codex");
    harness.resolveRateLimit("claude-code");
    await settle(PAST_COALESCING_WINDOW_MS);
    harness.resolveRateLimit("grok");
    await settle(PAST_COALESCING_WINDOW_MS * 3);
    const withStragglerInFlight = deltaSince(before, harness.counts());
    harness.resolveRateLimit("antigravity");
    await settle(PAST_COALESCING_WINDOW_MS);
    const afterStragglerSettled = deltaSince(before, harness.counts());

    expect({
      withStragglerInFlight: withStragglerInFlight.providersList,
      afterStragglerSettled: afterStragglerSettled.providersList,
    }).toEqual({ withStragglerInFlight: 0, afterStragglerSettled: 1 });
  });

  it("J: a first subscribe attempt closes before opening, a read lands, then a later attempt opens -> that read is caught up", async () => {
    const harness = createReloadHarness(GATED);
    harness.mountReloadTree();
    await settle(10);
    expect(streamState.opened).toHaveLength(1);

    // Only `setTimeout` is faked, and only across the reopen backoff: the
    // query cache schedules its own notifications on it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    closeStream();
    harness.releaseInitialReads();
    await vi.advanceTimersByTimeAsync(0);
    act(() => {
      vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 2);
    });
    vi.useRealTimers();
    expect(streamState.opened).toHaveLength(2);
    await openStream();

    expect(harness.counts()).toEqual({
      providersList: 2,
      listHarnesses: 2,
      rateLimit: NO_RATE_LIMIT_READS,
    });
  });
});
