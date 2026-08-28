/**
 * Focused unit coverage for `useProviderRateLimitRefresh` - the single source
 * of truth for a provider's refresh action + spinner state, shared by the
 * popover's `RateLimitProviderBlock` and the Settings card. The consumers'
 * own tests exercise this logic only through their full component trees;
 * these pin the lane routing and the per-target queue-phase fold-in directly,
 * so a regression is caught even if a consumer's test setup masks it.
 *
 * `rateLimitFetchLane` stays REAL (it is a pure provider-id classifier):
 * codex exercises the ephemeralProcess lane and openrouter the httpFetch
 * lane, so the routing under test is the true production mapping rather than
 * a mocked one.
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
import { cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";

const mocks = vi.hoisted(
  (): {
    targetPhases: Record<string, "queued" | "fetching">;
    forcedTargets: Record<string, boolean>;
    scope: { hostId: string };
    enqueue: Mock<(...args: unknown[]) => Promise<unknown>>;
  } => ({
    targetPhases: {},
    forcedTargets: {},
    scope: { hostId: "host-b" },
    enqueue: vi.fn((..._args: unknown[]) => Promise.resolve()),
  }),
);

// Keyed on the exact target, not a single flag: a mock that ignored
// `providerId`/`profileId` would still pass if the hook asked the registry
// about a DIFFERENT target, which is the whole property under test here.
//
// JSON for the same reason `rateLimitTargetsKey` uses it in the hook under
// test: a profile id is a free-form string off the provider, so `null` (follow
// the default profile) and `""` are distinct targets to the queue, and no
// separator is provably absent from an id. A `${p}:${id ?? ""}` key collapses
// the first pair and lets a `:` in an id shift the second - so the fixture
// would answer for a target the hook never asked about while still looking
// exact.
function targetKey(providerId: string, profileId: string | null): string {
  return JSON.stringify([providerId, profileId]);
}

vi.mock("@/hooks/rate-limits/use-rate-limit-queue-target-phase", () => ({
  useRateLimitQueueTargetPhase: (
    providerId: string,
    profileId: string | null,
  ) => mocks.targetPhases[targetKey(providerId, profileId)] ?? null,
  useIsRateLimitQueueTargetForced: (
    providerId: string,
    profileId: string | null,
  ) => mocks.forcedTargets[targetKey(providerId, profileId)] ?? false,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  // Wrapper (not `mocks.enqueue` directly) so `beforeEach` can swap the spy.
  enqueueRateLimitFetchForScope: (...args: unknown[]) => mocks.enqueue(...args),
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-queue-scope", () => ({
  useRateLimitQueueScope: () => mocks.scope,
}));
// No-op the fresh-on-open side effect: it has its own enqueue call that would
// pollute the spy, and its behavior is covered through the consumers' tests.
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-mount", () => ({
  useRefreshProviderRateLimitsOnMount: () => {},
}));

import { useProviderRateLimitRefresh } from "@/hooks/rate-limits/use-provider-rate-limit-refresh";

beforeEach(() => {
  mocks.targetPhases = {};
  mocks.forcedTargets = {};
  mocks.enqueue = vi.fn((..._args: unknown[]) => Promise.resolve());
});

afterEach(() => {
  cleanup();
});

describe("useProviderRateLimitRefresh refresh routing", () => {
  it("routes an ephemeralProcess provider's refresh through the serial queue with force:true, never a bare refetch", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(mocks.enqueue).toHaveBeenCalledWith(
      mocks.scope,
      "codex",
      DEFAULT_ACCOUNT_CONTEXT,
      {
        force: true,
        profileId: null,
      },
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  it("routes an httpFetch provider's refresh through its own refetch, never the queue", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe("useProviderRateLimitRefresh isRefreshing", () => {
  const refetch = () => Promise.resolve({});

  it("reflects the provider's own isFetching on both lanes", () => {
    const codex = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: true,
        refetch,
      }),
    );
    expect(codex.result.current.isRefreshing).toBe(true);

    const openrouter = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: true,
        refetch,
      }),
    );
    expect(openrouter.result.current.isRefreshing).toBe(true);
  });

  it("folds THIS target's own FETCHING phase in for an ephemeralProcess provider whose own fetch has settled", () => {
    mocks.targetPhases = { [targetKey("codex", null)]: "fetching" };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(true);
  });

  // `null` (follow the default profile) and `""` are DISTINCT targets to the
  // queue. The fixture key has to keep them apart or the suite reports on a
  // target the hook never asked about - and every assertion above would still
  // look exact while doing it.
  it("does NOT read the default profile's phase for an empty-string profile id", () => {
    mocks.targetPhases = { [targetKey("codex", null)]: "fetching" };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: "",
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("stays NOT refreshing while this target is queued but NOT yet forced, so the control can still promote it", () => {
    // `RefreshIconButton` disables on `isRefreshing` and no-ops its trigger.
    // An enqueue for an already-queued target promotes it
    // (`pending.force = true`), which is the only thing that stops the pull
    // being skipped by its second freshness/cool-down check or answered from
    // the host gauge cache - so a queued target must stay clickable.
    mocks.targetPhases = { [targetKey("codex", null)]: "queued" };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("DOES report refreshing once a queued target is already forced - the click that would promote it has happened", () => {
    // The other half of the queued rule. `RefreshIconButton` caps its internal
    // spinner at 10s, so without this the user's own request goes visually
    // idle while still waiting behind the lane - and the Settings consumers
    // render no "Queued…" label to compensate.
    mocks.targetPhases = { [targetKey("codex", null)]: "queued" };
    mocks.forcedTargets = { [targetKey("codex", null)]: true };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(true);
  });

  it("reads its OWN forced flag, not a sibling profile's, when deciding a queued target is pending", () => {
    mocks.targetPhases = { [targetKey("codex", "personal")]: "queued" };
    mocks.forcedTargets = { [targetKey("codex", "work")]: true };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: "personal",
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("reads only ITS OWN target - a sibling profile fetching on the same provider does not mark this one refreshing", () => {
    // Guards the identity the mock above is keyed on: were the hook to ask the
    // registry about the provider without its profile (or about any other
    // target), this would go green on a borrowed phase.
    mocks.targetPhases = { [targetKey("codex", "work-profile")]: "fetching" };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: "personal-profile",
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("ignores the queue phase for an httpFetch provider - its own isFetching is the complete signal", () => {
    mocks.targetPhases = { [targetKey("openrouter", null)]: "fetching" };
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "openrouter",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("is false when nothing is fetching and the queue is idle", () => {
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: true,
        isFetching: false,
        refetch,
      }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });

  it("does not report or perform a refresh when fetching is ineligible", async () => {
    const refetch = vi.fn(() => Promise.resolve({}));
    const { result } = renderHook(() =>
      useProviderRateLimitRefresh({
        providerId: "codex",
        profileId: null,
        usageUpdatedAt: null,
        hasCachedValue: false,
        fetchEligible: false,
        isFetching: true,
        refetch,
      }),
    );

    await result.current.refresh();

    expect(result.current.isRefreshing).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
