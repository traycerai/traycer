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
import type { RateLimitUnavailableReason } from "@traycer/protocol/host";
import type { ProviderRateLimitTanstackOptions } from "@/hooks/host/provider-rate-limit-query-options";
import type { ConfiguredRateLimitProvider } from "@/hooks/rate-limits/use-configured-rate-limit-providers";
import type { RateLimitProfileSelection } from "@/hooks/rate-limits/use-rate-limit-profile-selection";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import type { ProviderRateLimitEnvelope } from "@/lib/rate-limits/rate-limit-envelope";
import {
  buildProviderRateLimitEnvelopeFromSnapshot,
  NO_EPISODE,
} from "@/lib/rate-limits/rate-limit-envelope";
import {
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
  TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS,
} from "@/lib/rate-limits/rate-limit-timing";
import {
  pruneScheduledTransientReads,
  rateLimitAccountLedgerKey,
  scheduledTransientReadOwed,
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

// The provider list these rows hand the cluster is the host's answer: an entry
// whose account is gone from it is gone because the host said so, which is the
// one thing that ends an entry's life.
vi.mock(
  "@/hooks/rate-limits/use-configured-rate-limit-providers",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-configured-rate-limit-providers")
      >();
    return { ...actual, useRateLimitProvidersAnswered: () => true };
  },
);

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

/** A second account the host has, so a list without Codex is still a list. */
const GROK: ConfiguredRateLimitProvider = {
  providerId: "grok",
  profiles: [],
  lane: "ephemeralProcess",
  fetchEligibility: { ambient: true, managedProfiles: true },
};

function transientEnvelope(
  reason: RateLimitUnavailableReason,
): ProviderRateLimitEnvelope {
  // Through the production builder, because the episode stamp it carries is
  // what decides whether a re-read is owed, and `previous` is what a run of
  // failures carries it over from.
  return buildProviderRateLimitEnvelopeFromSnapshot(
    mocks.results.get("codex:")?.data,
    { provider: "codex", available: false, reason },
    Date.now(),
  );
}

/** How many reads asked the host to pass its floors, which only a person may. */
function forcedReads(): number {
  return mocks.fetch.mock.calls.filter((call) => call[2].force).length;
}

function reading(envelope: ProviderRateLimitEnvelope): void {
  mocks.results.set("codex:", { data: envelope, isError: false });
}

function tree(
  queryClient: QueryClient,
  providers: ReadonlyArray<ConfiguredRateLimitProvider>,
): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Popover>
          <StatusBarRateLimitCluster
            hostId={HOST_ID}
            providers={providers}
            profileSelection={PROFILE_SELECTION}
            editing={false}
          />
        </Popover>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.results = new Map();
  mocks.reading = new Set();
  pruneScheduledTransientReads(HOST_ID, new Set());
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  pruneScheduledTransientReads(HOST_ID, new Set());
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

describe("a transient account's scheduled re-read", () => {
  it("happens once per episode, through the read it schedules and the failure after it", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    const view = render(tree(queryClient, [CODEX]));

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
      view.rerender(tree(queryClient, [CODEX]));
    });
    // And it failed the same way: the account is transient and idle again,
    // exactly as it was before the scheduled read. Nothing ended the episode,
    // so nothing is owed - this is the sequence that used to arm a fresh timer
    // on every failure, a read a minute for as long as the account kept
    // failing.
    mocks.reading.delete("codex:");
    reading(transientEnvelope("timeout"));
    act(() => {
      view.rerender(tree(queryClient, [CODEX]));
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("comes back for the next episode, on an answer that landed with the strip gone", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    const view = render(tree(queryClient, [CODEX]));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    // The usage region is hidden, so there is no strip at all - and this is
    // where the reviewer's sequence lands: a background read answers the
    // account authoritatively, and the read after it times out. Nothing was
    // drawing either answer, and both are in the envelope the next strip
    // reads. So the episode that spent its one-shot is over.
    view.unmount();
    reading(transientEnvelope("cli_not_found"));
    reading(transientEnvelope("timeout"));

    render(tree(queryClient, [CODEX]));
    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(2);

    // And still one for this episode.
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(2);
    expect(forcedReads()).toBe(0);
  });

  it("gives a run of failures its own delay when the run before it ended between commits", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    const view = render(tree(queryClient, [CODEX]));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS - 1_000);
    });
    // An answer and the failure after it, both folded into the envelope before
    // React commits anything: a profile refresh and a usage read settling in
    // one batch do exactly this. The strip never draws the answer, so the
    // account looks transient throughout - and the run of failures it is in is
    // a different one.
    reading(transientEnvelope("cli_not_found"));
    reading(transientEnvelope("timeout"));
    act(() => {
      view.rerender(tree(queryClient, [CODEX]));
    });

    // One second later, which was the OLD run's deadline. A timer that
    // outlived its run would read the current target here and spend this run's
    // one-shot 59 seconds early.
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.collect).not.toHaveBeenCalled();

    // Its own full delay, from when it started.
    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS - 1_000);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("gives the next run its own read even when the clock is corrected backwards", () => {
    const answeredAt = Date.now();
    reading(transientEnvelope("cli_not_found"));
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    const view = render(tree(queryClient, [CODEX]));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    // The wall clock goes back to where the first answer was dated, which is
    // what a correction does. An episode named by a clock reading would hand
    // the next run the identity this one already spent, and the strip would
    // say "Couldn't load, retrying" for fifteen minutes without retrying.
    view.unmount();
    vi.setSystemTime(answeredAt);
    reading(transientEnvelope("cli_not_found"));
    reading(transientEnvelope("timeout"));

    render(tree(queryClient, [CODEX]));
    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(2);
  });

  it("stays spent when the provider is hidden and shown again", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    render(tree(queryClient, [CODEX]));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    // The arrangement's per-provider checkbox, twice. Nothing answered the
    // account in between, so this is the same run of failures and it has had
    // the read it was promised - however many times the segment leaves the
    // strip and comes back.
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        hiddenProviders: ["codex"],
      });
    });
    act(() => {
      useLayoutStore.getState().setArrangement({
        ...useLayoutStore.getState().arrangement,
        hiddenProviders: [],
      });
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("stays spent across a hide and a show with nothing answered in between", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    const view = render(tree(queryClient, [CODEX]));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    // Hidden and shown again, with the same failure in the envelope: the
    // gesture is not an answer, so it is the same episode and the read it
    // promised has been made. A one-shot re-armed by the mount would read
    // again here, and again at every hide after it.
    view.unmount();
    render(tree(queryClient, [CODEX]));
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);
  });

  it("keeps no entry for an account the host no longer has", () => {
    reading(transientEnvelope("timeout"));
    const queryClient = newQueryClient();
    const view = render(tree(queryClient, [CODEX]));

    act(() => {
      vi.advanceTimersByTime(TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS);
    });
    expect(mocks.collect).toHaveBeenCalledTimes(1);

    // The host stops reporting this account - signed out of it, or its profile
    // deleted - and goes on reporting others, which is what tells the strip
    // the difference between an account that is gone and a list that has not
    // answered. Its entry would otherwise sit in the map for the life of the
    // window.
    const episode = mocks.results.get("codex:")?.data?.episode ?? NO_EPISODE;
    act(() => {
      view.rerender(tree(queryClient, [GROK]));
    });
    expect(
      scheduledTransientReadOwed(
        rateLimitAccountLedgerKey(HOST_ID, "codex", null),
        episode,
      ),
    ).toBe(true);
  });
});
