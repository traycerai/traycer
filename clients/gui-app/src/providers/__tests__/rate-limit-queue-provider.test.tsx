import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { ReactNode } from "react";
import type { RateLimitFetchEligibility } from "@/lib/rate-limit-providers";
import { PROVIDER_RATE_LIMITS_STALE_TIME_MS } from "@/lib/rate-limit-providers";

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
  profileSelection: {
    activeChatSettings: null;
    lastProfileByHarness: Readonly<Record<string, string | null>>;
  };
};

const mocks = vi.hoisted<MockState>(() => ({
  hostId: "host-a",
  client: { requestWithResponseTimeout: () => Promise.resolve({}) },
  configured: [],
  profileSelection: { activeChatSettings: null, lastProfileByHarness: {} },
}));

vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.hostId,
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.client,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => mocks.client,
}));
// Normalizes each fixture with the defaults a real `ConfiguredRateLimitProvider`
// always carries (`profiles`, `fetchEligibility`), so most existing test bodies
// below - written against the pre-profile-aware polling scheduler - keep
// passing unchanged: an empty `profiles` array + ambient-eligible is exactly
// the single-ambient-candidate shape `selectBackgroundRateLimitTargets`
// resolves a profile-less provider to.
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
// Only the HOOK is stubbed (its real implementation depends on the epic
// canvas store, chat session registry, etc., none of which is mounted here).
// `resolveRateLimitProfileId` stays real: `background-rate-limit-targets.ts`
// imports it directly to resolve each provider's selected profile id, and a
// bare mock here would drop that export out from under it.
vi.mock(
  "@/hooks/rate-limits/use-rate-limit-profile-selection",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/rate-limits/use-rate-limit-profile-selection")
      >();
    return {
      ...actual,
      useRateLimitProfileSelection: () => mocks.profileSelection,
    };
  },
);
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  configureRateLimitQueue: vi.fn(),
  enqueueRateLimitFetch: vi.fn(() => Promise.resolve()),
}));

import {
  RateLimitQueueProvider,
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
} from "@/providers/rate-limit-queue-provider";
import {
  configureRateLimitQueue,
  enqueueRateLimitFetch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";

const configureSpy = vi.mocked(configureRateLimitQueue);
const enqueueSpy = vi.mocked(enqueueRateLimitFetch);

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
      <RateLimitQueueProvider />
    </QueryClientProvider>
  );
}

function profile(input: {
  readonly profileId: string;
  readonly kind: ProviderProfile["kind"];
  readonly usageUpdatedAt: number | null;
}): ProviderProfile {
  return {
    profileId: input.profileId,
    enabled: true,
    kind: input.kind,
    authType: "oauth",
    label: input.profileId,
    auth: {
      status: "authenticated",
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
}> {
  return enqueueSpy.mock.calls.map((call) => ({
    providerId: call[0],
    profileId: (call[2] as { profileId: unknown }).profileId,
  }));
}

describe("<RateLimitQueueProvider />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hostId = "host-a";
    mocks.client = {
      requestWithResponseTimeout: vi.fn(() => Promise.resolve({})),
    };
    mocks.configured = [];
    mocks.profileSelection = {
      activeChatSettings: null,
      lastProfileByHarness: {},
    };
    configureSpy.mockClear();
    enqueueSpy.mockClear();
    defineVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls the ephemeralProcess lane every 5 minutes, matching the httpFetch lane's own refetchInterval", () => {
    expect(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("binds the serial queue to the default host on mount", () => {
    render(tree());
    const config = configureSpy.mock.calls.at(-1)?.[0] ?? null;
    expect(config).not.toBeNull();
    expect(config?.hostId).toBe("host-a");
    expect(typeof config?.request).toBe("function");
  });

  it("unbinds the queue when the host is lost", () => {
    const { rerender } = render(tree());
    configureSpy.mockClear();
    act(() => {
      mocks.hostId = null;
      rerender(tree());
    });
    expect(configureSpy).toHaveBeenLastCalledWith(null);
  });

  it("enqueues only ephemeralProcess providers immediately when they are configured", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "openrouter", lane: "httpFetch" },
    ];
    render(tree());

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
  });

  it("polls only ephemeralProcess providers each interval after the immediate enqueue", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "openrouter", lane: "httpFetch" },
    ];
    render(tree());
    enqueueSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });

    // Only the ephemeralProcess provider is enqueued; the httpFetch one never
    // touches the queue.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
  });

  it("pauses the interval while the document is hidden and resumes when visible again (guardrail 2)", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    render(tree());
    enqueueSpy.mockClear();

    act(() => {
      changeVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 3);
    });
    // Minimized/backgrounded: no subprocess-spawning enqueues at all.
    expect(enqueueSpy).not.toHaveBeenCalled();

    act(() => {
      changeVisibility("visible");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    // Brought back: polling resumes.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the window loses focus but stays visible - never keys off blur (guardrail 4)", () => {
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    render(tree());
    enqueueSpy.mockClear();

    // OS focus moves elsewhere (e.g. Traycer visible on a second monitor). The
    // document stays "visible", so nothing must pause.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("re-gates on the next tick when a credential is removed mid-session, without resetting the timer", () => {
    mocks.configured = [
      { providerId: "codex", lane: "ephemeralProcess" },
      { providerId: "claude-code", lane: "ephemeralProcess" },
    ];
    const { rerender } = render(tree());
    enqueueSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    enqueueSpy.mockClear();

    // claude-code's credential is removed mid-session -> it drops out of the
    // configured set. The ref updates on re-render; the interval keeps running.
    act(() => {
      mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
      rerender(tree());
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
    enqueueSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith("codex", DEFAULT_ACCOUNT_CONTEXT, {
      force: false,
      profileId: null,
    });
  });

  it("does not run the interval while there is no host", () => {
    mocks.hostId = null;
    mocks.configured = [{ providerId: "codex", lane: "ephemeralProcess" }];
    render(tree());
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 2);
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

// Background target selection over MANAGED PROFILES: each polling window
// walks `selectBackgroundRateLimitTargets` (selected-stale-first, then
// oldest, budget-capped) rather than one ambient pull per provider. See
// `background-rate-limit-targets.test.ts` for the selection function's own
// unit coverage; this suite proves the provider actually wires the live
// configured-providers + profile-selection snapshot into it on every window.
describe("<RateLimitQueueProvider /> background profile polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hostId = "host-a";
    mocks.client = {
      requestWithResponseTimeout: vi.fn(() => Promise.resolve({})),
    };
    mocks.configured = [];
    mocks.profileSelection = {
      activeChatSettings: null,
      lastProfileByHarness: {},
    };
    configureSpy.mockClear();
    enqueueSpy.mockClear();
    defineVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("enqueues each stale profile with its own profileId and the target's account context", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({
            profileId: "personal",
            kind: "managed",
            usageUpdatedAt: null,
          }),
          profile({ profileId: "work", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());

    expect(calledTargets()).toEqual(
      expect.arrayContaining([
        { providerId: "codex", profileId: "personal" },
        { providerId: "codex", profileId: "work" },
      ]),
    );
    for (const call of enqueueSpy.mock.calls) {
      expect(call[1]).toEqual(DEFAULT_ACCOUNT_CONTEXT);
      expect(call[2]).toMatchObject({ force: false });
    }
  });

  it("enqueues the selected profile ahead of an unselected, older one", () => {
    const now = Date.now();
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({
            profileId: "oldest",
            kind: "managed",
            usageUpdatedAt: now - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 100_000,
          }),
          profile({
            profileId: "selected",
            kind: "managed",
            usageUpdatedAt: now - PROVIDER_RATE_LIMITS_STALE_TIME_MS - 1_000,
          }),
        ],
      },
    ];
    mocks.profileSelection = {
      activeChatSettings: null,
      lastProfileByHarness: { codex: "selected" },
    };
    render(tree());

    expect(calledTargets().map((t) => t.profileId)).toEqual([
      "selected",
      "oldest",
    ]);
  });

  it("caps one polling window at the background target budget across providers", () => {
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
          profile({ profileId: "p4", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    render(tree());

    // 4 stale eligible targets exist, but the window budget is 3.
    expect(enqueueSpy).toHaveBeenCalledTimes(3);
  });

  it("excludes a signed-out managed profile from the polled set", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          {
            ...profile({
              profileId: "signed-out",
              kind: "managed",
              usageUpdatedAt: null,
            }),
            auth: {
              status: "unauthenticated",
              badgeText: null,
              label: null,
              detail: null,
            },
          },
        ],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ];
    render(tree());
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does not re-trigger the immediate enqueue when only a profile's usage timestamp changes across a re-render", () => {
    const buildConfigured = (
      usageUpdatedAt: number | null,
    ): ReadonlyArray<ConfiguredFixture> => [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "work", kind: "managed", usageUpdatedAt }),
        ],
      },
    ];
    mocks.configured = buildConfigured(null);
    const { rerender } = render(tree());
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    enqueueSpy.mockClear();

    // A sibling read (a different provider/profile) landed and bumped this
    // profile's persisted `usageUpdatedAt` - membership (who's eligible, who's
    // selected) is unchanged, so the immediate-enqueue effect must not refire.
    act(() => {
      mocks.configured = buildConfigured(Date.now() - 1_000);
      rerender(tree());
    });
    expect(enqueueSpy).not.toHaveBeenCalled();

    // The next scheduled window still runs on its own cadence regardless.
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("re-triggers the immediate enqueue when eligibility actually changes", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profile({ profileId: "work", kind: "managed", usageUpdatedAt: null }),
        ],
      },
    ];
    const { rerender } = render(tree());
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    enqueueSpy.mockClear();

    act(() => {
      mocks.configured = [
        {
          providerId: "codex",
          lane: "ephemeralProcess",
          profiles: [
            profile({
              profileId: "work",
              kind: "managed",
              usageUpdatedAt: null,
            }),
            profile({
              profileId: "second",
              kind: "managed",
              usageUpdatedAt: null,
            }),
          ],
        },
      ];
      rerender(tree());
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
  });
});
