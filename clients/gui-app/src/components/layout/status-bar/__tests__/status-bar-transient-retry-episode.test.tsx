/**
 * The transient state's scheduled re-read, through the REAL hook, the real
 * cluster and the real ledger: only the host queries and the two read
 * functions are doubled.
 *
 * Its own file because that is the point of it. Every other row about the
 * retry hands the cluster a segment model and a target list, which is exactly
 * what cannot show this: the promise is ONE re-read per run of failures, and
 * what broke it was the hook withdrawing its own target while the read it
 * scheduled was in flight, then handing it back when that read failed - a
 * fresh timer every minute, from mocked targets that never move.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Popover } from "@/components/ui/popover";
import type {
  ProviderRateLimits,
  RateLimitUnavailableReason,
} from "@traycer/protocol/host";
import type { ProviderRateLimitTanstackOptions } from "@/hooks/host/provider-rate-limit-query-options";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
  TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS,
} from "@/lib/rate-limits/rate-limit-timing";
import {
  rateLimitAccountLedgerKey,
  releaseScheduledTransientRead,
} from "@/lib/rate-limits/rate-limit-read-ledger";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

interface QueryDouble {
  readonly data: ProviderRateLimitEnvelope | undefined;
  readonly isError: boolean;
}

interface MockState {
  results: Map<string, QueryDouble>;
  reading: Set<string>;
  collect: Mock<(scope: unknown, target: unknown) => Promise<void>>;
  fetch: Mock<
    (
      scope: unknown,
      target: unknown,
      opts: { readonly force: boolean },
    ) => Promise<void>
  >;
}

const mocks = vi.hoisted<MockState>(() => ({
  results: new Map(),
  reading: new Set(),
  collect: vi.fn((): Promise<void> => Promise.resolve()),
  fetch: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
  useHostRuntimeClient: () => null,
}));

function hostQueriesDouble(args: {
  readonly requests: ReadonlyArray<{
    readonly params: {
      readonly providerId: RateLimitProviderId;
      readonly profileId: string | null;
    };
  }>;
  readonly options: ProviderRateLimitTanstackOptions;
}) {
  return args.requests.map((request) => {
    const key = `${request.params.providerId}:${request.params.profileId ?? ""}`;
    const result = mocks.results.get(key) ?? {
      data: undefined,
      isError: false,
    };
    return {
      isFetching: mocks.reading.has(key),
      errorUpdateCount: result.isError ? 1 : 0,
      ...result,
    };
  });
}

vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueries: hostQueriesDouble,
  useHostQueriesWithResponseMap: hostQueriesDouble,
}));

vi.mock("@/hooks/rate-limits/use-provider-rate-limit-fetch-scope", () => ({
  useProviderRateLimitFetchScope: () => ({ hostId: HOST_ID }),
}));

// The boundary that talks to the host, so the spies are what count the reads a
// lifecycle made - and which of the two paths made them.
vi.mock(
  "@/lib/rate-limits/provider-rate-limit-fetch",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/lib/rate-limits/provider-rate-limit-fetch")
      >();
    return {
      ...actual,
      fetchProviderRateLimits: mocks.fetch,
      collectProviderRateLimits: mocks.collect,
    };
  },
);

import { StatusBarRateLimitCluster } from "@/components/layout/status-bar/status-bar-rate-limit-cluster";

const HOST_ID = "host-a";

const PROFILE_SELECTION: RateLimitProfileSelection = {
  shownProfiles: {},
  lastProfileByHarness: {},
};

const CODEX: ConfiguredRateLimitProvider = {
  providerId: "codex",
  profiles: [],
  lane: "ephemeralProcess",
  fetchEligibility: { ambient: true, managedProfiles: true },
};

function transientEnvelope(
  reason: RateLimitUnavailableReason,
): ProviderRateLimitEnvelope {
  const rateLimits: ProviderRateLimits = {
    provider: "codex",
    available: false,
    reason,
  };
  return {
    latest: rateLimits,
    lastGood: null,
    lastGoodAt: null,
    lastFailureAt: Date.now(),
  };
}

function liveEnvelope(): ProviderRateLimitEnvelope {
  const rateLimits: AvailableProviderRateLimits = {
    provider: "codex",
    available: true,
    planType: null,
    limitId: null,
    limitName: null,
    primary: { usedPercent: 20, resetsAt: null, durationMinutes: null },
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
  return {
    latest: rateLimits,
    lastGood: rateLimits,
    lastGoodAt: Date.now(),
    lastFailureAt: null,
  };
}

/** How many reads asked the host to pass its floors, which only a person may. */
function forcedReads(): number {
  return mocks.fetch.mock.calls.filter((call) => call[2].force).length;
}

function reading(envelope: ProviderRateLimitEnvelope): void {
  mocks.results.set("codex:", { data: envelope, isError: false });
}

function tree(queryClient: QueryClient): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Popover>
          <StatusBarRateLimitCluster
            hostId={HOST_ID}
            providers={[CODEX]}
            profileSelection={PROFILE_SELECTION}
            editing={false}
          />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.results = new Map();
  mocks.reading = new Set();
  releaseScheduledTransientRead(
    rateLimitAccountLedgerKey(HOST_ID, "codex", null),
  );
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  releaseScheduledTransientRead(
    rateLimitAccountLedgerKey(HOST_ID, "codex", null),
  );
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe("a transient account's scheduled re-read", () => {
  it("happens once per episode, through the read it schedules and the failure after it", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = render(tree(queryClient));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    // Through the collection path, the only unforced read that reaches the host
    // for an entry this renderer just wrote. Nothing here is FORCED: that is a
    // person's gesture, and the strip's own mount pull reads unforced like any
    // other automatic caller.
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(forcedReads()).toBe(0);

    // The read it just started is in flight, which the observer reports.
    mocks.reading.add("codex:");
    act(() => {
      view.rerender(tree(queryClient));
    });
    // And it failed the same way: the account is transient and idle again,
    // exactly as it was before the scheduled read. Nothing ended the episode,
    // so nothing is owed - this is the sequence that used to arm a fresh timer
    // on every failure, a read a minute for as long as the account kept
    // failing.
    mocks.reading.delete("codex:");
    reading(transientEnvelope("timeout"));
    act(() => {
      view.rerender(tree(queryClient));
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("comes back for the next episode, once a reading has landed", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = render(tree(queryClient));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    // A reading lands, which is what ends an episode.
    reading(liveEnvelope());
    act(() => {
      view.rerender(tree(queryClient));
    });
    // Then this account fails transiently again, with nothing retained: a
    // fresh episode, owed its own single re-read.
    reading(transientEnvelope("connection_failed"));
    act(() => {
      view.rerender(tree(queryClient));
    });
    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(2);

    // And still one for that episode.
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(2);
  });
});
