import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ReactNode } from "react";
import type { RateLimitFetchEligibility } from "@/lib/rate-limit-providers";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";
import type { fetchProviderRateLimits } from "@/lib/rate-limits/provider-rate-limit-fetch";
import { EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS } from "@/lib/rate-limits/rate-limit-timing";

type ConfiguredFixture = {
  readonly providerId: string;
  readonly lane: string;
  readonly profiles?: ReadonlyArray<ProviderProfile>;
  readonly fetchEligibility?: RateLimitFetchEligibility;
};

type MockState = {
  hostId: string | null;
  client: { requestWithResponseTimeout: () => Promise<unknown> } | null;
  configured: ReadonlyArray<ConfiguredFixture>;
};

const mocks = vi.hoisted<MockState>(() => ({
  hostId: "host-a",
  client: { requestWithResponseTimeout: () => Promise.resolve({}) },
  configured: [],
}));

const fetchSpy = vi.hoisted(() =>
  vi.fn<typeof fetchProviderRateLimits>(() => Promise.resolve()),
);
const onTurnSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.hostId,
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => mocks.client,
}));
// Normalizes each fixture with the defaults a real `ConfiguredRateLimitProvider`
// always carries (`profiles`, `fetchEligibility`).
vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () =>
    mocks.configured.map((provider) => ({
      ...provider,
      profiles: provider.profiles ?? [],
      fetchEligibility: provider.fetchEligibility ?? {
        ambient: true,
        managedProfiles: true,
      },
    })),
}));
// The fetch mechanism itself is covered end-to-end in
// `provider-rate-limit-fetch.test.ts`; this suite only proves the provider
// calls it with the right targets, force value, and timing.
vi.mock("@/lib/rate-limits/provider-rate-limit-fetch", () => ({
  fetchProviderRateLimits: fetchSpy,
}));
// Stubbed so this suite can assert the wiring (called with "opencode", the
// right eligibility) without depending on the chat-turn event bus.
vi.mock("@/hooks/host/use-refresh-provider-rate-limits-on-turn", () => ({
  useRefreshProviderRateLimitsOnTurn: onTurnSpy,
}));

import { RateLimitPollProvider } from "@/providers/rate-limit-poll-provider";
import { useRefreshProviderRateLimitsOnTurn } from "@/hooks/host/use-refresh-provider-rate-limits-on-turn";

const onTurnMock = vi.mocked(useRefreshProviderRateLimitsOnTurn);

function defineVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function changeVisibility(state: "visible" | "hidden"): void {
  defineVisibility(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

function tree(): ReactNode {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <RateLimitPollProvider />
    </QueryClientProvider>
  );
}

function profile(input: {
  readonly profileId: string;
  readonly kind: ProviderProfile["kind"];
  readonly usageUpdatedAt: number | null;
  readonly authenticated?: boolean;
}): ProviderProfile {
  return {
    profileId: input.profileId,
    enabled: true,
    kind: input.kind,
    authType: "oauth",
    label: input.profileId,
    auth: {
      status:
        (input.authenticated ?? true) ? "authenticated" : "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: {
      email: `${input.profileId}@example.com`,
      tier: "Pro",
      accountUuid: `${input.profileId}-uuid`,
    },
    usageUpdatedAt: input.usageUpdatedAt,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function calledTargets(): ReadonlyArray<{
  readonly providerId: unknown;
  readonly profileId: unknown;
  readonly force: unknown;
}> {
  return fetchSpy.mock.calls.map(([, target, opts]) => ({
    providerId: target.providerId,
    profileId: target.profileId,
    force: opts.force,
  }));
}

describe("<RateLimitPollProvider />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hostId = "host-a";
    mocks.client = {
      requestWithResponseTimeout: vi.fn(() => Promise.resolve({})),
    };
    mocks.configured = [];
    fetchSpy.mockClear();
    onTurnSpy.mockClear();
    defineVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls the ephemeralProcess lane every 15 minutes", () => {
    expect(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("fetches every eligible ephemeralProcess target once on mount, with force:false and no budget", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
          profile({ profileId: "p2", kind: "managed", usageUpdatedAt: null }),
        ],
      },
      {
        providerId: "claude-code",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p3", kind: "managed", usageUpdatedAt: null }),
        ],
      },
      { providerId: "openrouter", lane: "httpFetch" },
    ];
    render(tree());

    // Three ephemeralProcess targets, none dropped by a budget; the httpFetch
    // provider never touches this fetch at all.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(calledTargets()).toEqual(
      expect.arrayContaining([
        { providerId: "codex", profileId: "p1", force: false },
        { providerId: "codex", profileId: "p2", force: false },
        { providerId: "claude-code", profileId: "p3", force: false },
      ]),
    );
  });

  it("polls again after a full interval tick", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());
    fetchSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calledTargets()).toEqual([
      { providerId: "codex", profileId: "p1", force: false },
    ]);
  });

  it("pauses the interval while the document is hidden and resumes when visible again", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());
    fetchSpy.mockClear();

    act(() => {
      changeVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 3);
    });
    // Minimized/backgrounded: no subprocess-spawning fetches at all.
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      changeVisibility("visible");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    // Brought back: polling resumes.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the window loses focus but stays visible - never keys off blur", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());
    fetchSpy.mockClear();

    // OS focus moves elsewhere (e.g. Traycer visible on a second monitor). The
    // document stays "visible", so nothing must pause.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-polls immediately when the eligible set gains a profile, without waiting for the interval", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    const { rerender } = render(tree());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    act(() => {
      mocks.configured = [
        {
          providerId: "codex",
          lane: "ephemeralProcess",
          profiles: [
            profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
            profile({ profileId: "p2", kind: "managed", usageUpdatedAt: null }),
          ],
        },
      ];
      rerender(tree());
    });

    // Membership changed (a new profile joined) - re-polls right away, for
    // BOTH targets, not only the new one.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      calledTargets()
        .map((t) => t.profileId)
        .sort(),
    ).toEqual(["p1", "p2"]);
  });

  it("a reading landing (usageUpdatedAt changing, membership unchanged) does not by itself re-poll", () => {
    const buildConfigured = (
      usageUpdatedAt: number | null,
    ): ReadonlyArray<ConfiguredFixture> => [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt }),
        ],
      },
    ];
    mocks.configured = buildConfigured(null);
    const { rerender } = render(tree());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // A sibling read landed and bumped this profile's persisted
    // `usageUpdatedAt` to "just now" - membership (who's eligible) is
    // unchanged, so the mount/membership-triggered poll must not refire.
    act(() => {
      mocks.configured = buildConfigured(Date.now());
      rerender(tree());
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not run the interval while there is no host", () => {
    mocks.hostId = null;
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "p1", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 2);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("excludes a signed-out managed profile from the polled set", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({
            profileId: "signed-out",
            kind: "managed",
            usageUpdatedAt: null,
            authenticated: false,
          }),
        ],
      },
    ];
    render(tree());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the OpenCode turn refresh mounted, with eligibility reflecting whether OpenCode is configured", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    const { rerender } = render(tree());
    expect(onTurnMock).toHaveBeenLastCalledWith("opencode", null, false);

    act(() => {
      mocks.configured = [
        { providerId: "codex", lane: "ephemeralProcess" },
        { providerId: "opencode", lane: "httpFetch" },
      ];
      rerender(tree());
    });
    expect(onTurnMock).toHaveBeenLastCalledWith("opencode", null, true);
  });
});

// Staleness is judged live, at the moment each poll tick runs, over the
// candidate's own PERSISTED `usageUpdatedAt` - never a value baked in once at
// mount or memoized alongside the candidate list. `vi.useFakeTimers()` also
// fakes `Date`, so advancing the virtual clock ages a fixture's fixed
// `usageUpdatedAt` exactly the way real elapsed time would.
describe("<RateLimitPollProvider /> per-target freshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hostId = "host-a";
    mocks.client = {
      requestWithResponseTimeout: vi.fn(() => Promise.resolve({})),
    };
    mocks.configured = [];
    fetchSpy.mockClear();
    onTurnSpy.mockClear();
    defineVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not fetch a target whose persisted reading is still fresh, then fetches it once it has aged past the stale floor", () => {
    const freshAt = Date.now() - 1_000;
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({
            profileId: "work",
            kind: "managed",
            usageUpdatedAt: freshAt,
          }),
        ],
      },
    ];
    render(tree());
    // Fresh (1s old, well under the 5-minute floor) - skipped on mount.
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    // The fixture's `usageUpdatedAt` never moves, but the virtual clock the
    // next tick reads `Date.now()` against has - now (15min + 1s) old, past
    // `PROVIDER_RATE_LIMITS_STALE_TIME_MS` (5 min), so this tick fetches it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calledTargets()).toEqual([
      { providerId: "codex", profileId: "work", force: false },
    ]);
  });

  it("fetches a never-read (usageUpdatedAt: null) target on every tick", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "work", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips a target that stays inside the stale floor across an elapsed window shorter than the poll interval, via a forced membership re-check", () => {
    // Advance to just short of the 5-minute floor, then force a re-poll via a
    // membership change (not the 15-minute interval, which would trivially
    // exceed the floor on its own) - proving the check reads live elapsed
    // time rather than only firing once per interval tick.
    const freshAt = Date.now();
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({
            profileId: "work",
            kind: "managed",
            usageUpdatedAt: freshAt,
          }),
          profile({
            profileId: "membership-bump",
            kind: "managed",
            usageUpdatedAt: null,
          }),
        ],
      },
    ];
    const { rerender } = render(tree());
    expect(calledTargets().map((t) => t.profileId)).toEqual([
      "membership-bump",
    ]);
    fetchSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1_000);
    });
    act(() => {
      mocks.configured = [
        {
          providerId: "codex",
          lane: "ephemeralProcess",
          profiles: [
            profile({
              profileId: "work",
              kind: "managed",
              usageUpdatedAt: freshAt,
            }),
            profile({
              profileId: "membership-bump",
              kind: "managed",
              usageUpdatedAt: null,
            }),
            profile({
              profileId: "new-member",
              kind: "managed",
              usageUpdatedAt: null,
            }),
          ],
        },
      ];
      rerender(tree());
    });

    // "work" is still inside its floor at this elapsed time - skipped again.
    expect(
      calledTargets()
        .map((t) => t.profileId)
        .sort(),
    ).toEqual(["membership-bump", "new-member"]);
  });
});
