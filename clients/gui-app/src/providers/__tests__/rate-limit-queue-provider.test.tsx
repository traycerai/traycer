import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_ACCOUNT_CONTEXT } from "@traycer/protocol/common/schemas";
import type {
  ProviderAuthStatus,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { ReactNode } from "react";
import type { RateLimitFetchEligibility } from "@/lib/rate-limit-providers";

type MockConfiguredProvider = {
  readonly providerId: string;
  readonly lane: "ephemeralProcess" | "httpFetch";
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly fetchEligibility: RateLimitFetchEligibility;
};

type MockState = {
  hostId: string | null;
  client: {
    request: () => Promise<unknown>;
    requestWithResponseTimeout: (...args: unknown[]) => Promise<unknown>;
  } | null;
  configured: ReadonlyArray<MockConfiguredProvider>;
};

const mocks = vi.hoisted<MockState>(() => ({
  hostId: "host-a",
  client: {
    request: () => Promise.resolve({}),
    requestWithResponseTimeout: () => Promise.resolve({}),
  },
  configured: [],
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mocks.hostId,
}));
// The provider now resolves its client through `useHostClientForHostId` (a
// requester PINNED to the given host id), not the mutable app-wide
// `useHostClient()`. This mock mirrors that pinned-per-host resolution: a
// `null` hostId (host loss) resolves to `null`, and a non-null hostId
// resolves to `mocks.client` - which is itself nullable, so a test can also
// simulate a pinned client that fails to resolve while a host id is still
// active (see "unbinds the queue when the pinned client cannot resolve"
// below).
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : mocks.client,
}));
vi.mock("@/hooks/rate-limits/use-configured-rate-limit-providers", () => ({
  useConfiguredRateLimitProviders: () => mocks.configured,
}));
vi.mock("@/lib/rate-limits/ephemeral-fetch-queue", () => ({
  configureRateLimitQueue: vi.fn(),
  enqueueRateLimitFetchBatch: vi.fn(() => Promise.resolve()),
}));

import {
  RateLimitQueueProvider,
  EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS,
} from "@/providers/rate-limit-queue-provider";
import {
  configureRateLimitQueue,
  enqueueRateLimitFetchBatch,
} from "@/lib/rate-limits/ephemeral-fetch-queue";
import { RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS } from "@/lib/rate-limits/rate-limit-timing";

const configureSpy = vi.mocked(configureRateLimitQueue);
const enqueueBatchSpy = vi.mocked(enqueueRateLimitFetchBatch);

function auth(status: ProviderAuthStatus): ProviderProfile["auth"] {
  return { status, badgeText: null, label: null, detail: null };
}

function profileFixture(
  kind: "ambient" | "managed",
  profileId: string,
  status: ProviderAuthStatus,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label: kind === "ambient" ? "Terminal" : profileId,
    auth: auth(status),
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

/** A minimal ephemeralProcess provider with only its ambient login eligible
 * and no profile metadata - the shape most of these tests exercised before
 * the queue learned to fan out over every fetch-eligible profile. */
function ephemeralAmbientOnlyProvider(
  providerId: string,
): MockConfiguredProvider {
  return {
    providerId,
    lane: "ephemeralProcess",
    profiles: [],
    fetchEligibility: { ambient: true, managedProfiles: false },
  };
}

function httpFetchProvider(providerId: string): MockConfiguredProvider {
  return {
    providerId,
    lane: "httpFetch",
    profiles: [],
    fetchEligibility: { ambient: true, managedProfiles: false },
  };
}

function target(providerId: string, profileId: string | null) {
  return { providerId, accountContext: DEFAULT_ACCOUNT_CONTEXT, profileId };
}

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

describe("<RateLimitQueueProvider />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.hostId = "host-a";
    mocks.client = {
      request: vi.fn(() => Promise.resolve({})),
      requestWithResponseTimeout: vi.fn(() => Promise.resolve({})),
    };
    mocks.configured = [];
    configureSpy.mockClear();
    enqueueBatchSpy.mockClear();
    defineVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls the ephemeralProcess lane every 15 minutes, matching the httpFetch lane's own steady cadence", () => {
    expect(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("binds the serial queue to the default host on mount", () => {
    render(tree());
    const config = configureSpy.mock.calls.at(-1)?.[0] ?? null;
    expect(config).not.toBeNull();
    expect(config?.hostId).toBe("host-a");
    expect(typeof config?.request).toBe("function");
  });

  it("configures the queue with a request fn that forwards to client.requestWithResponseTimeout, never client.request", async () => {
    render(tree());
    const config = configureSpy.mock.calls.at(-1)?.[0] ?? null;
    expect(config).not.toBeNull();
    if (config === null) throw new Error("expected a queue config");

    const params = {
      accountContext: DEFAULT_ACCOUNT_CONTEXT,
      providerId: "codex" as const,
      profileId: null,
    };
    await config.request(
      "host-a",
      "host.getRateLimitUsage",
      params,
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );

    expect(mocks.client?.requestWithResponseTimeout).toHaveBeenCalledWith(
      "host.getRateLimitUsage",
      params,
      RATE_LIMIT_USAGE_RESPONSE_TIMEOUT_MS,
    );
    expect(mocks.client?.request).not.toHaveBeenCalled();
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

  it("unbinds the queue when the pinned client fails to resolve, even though a host id is still active", () => {
    // `useHostClientForHostId` yields `null` when the id it is pinned to no
    // longer resolves anywhere (not the live directory, not the client's own
    // active host) - distinct from host LOSS (`hostId` itself going `null`,
    // covered above). Both must clear the binding: a queue configured with a
    // client that can't route anywhere is exactly as unusable as one with no
    // host at all.
    const { rerender } = render(tree());
    configureSpy.mockClear();
    act(() => {
      mocks.client = null;
      rerender(tree());
    });
    expect(configureSpy).toHaveBeenLastCalledWith(null);
  });

  it("enqueues only ephemeralProcess providers immediately when they are configured", () => {
    mocks.configured = [
      ephemeralAmbientOnlyProvider("codex"),
      httpFetchProvider("openrouter"),
    ];
    render(tree());

    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith([target("codex", null)], {
      force: false,
    });
  });

  it("polls only ephemeralProcess providers each interval after the immediate enqueue", () => {
    mocks.configured = [
      ephemeralAmbientOnlyProvider("codex"),
      httpFetchProvider("openrouter"),
    ];
    render(tree());
    enqueueBatchSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });

    // Only the ephemeralProcess provider is enqueued; the httpFetch one never
    // touches the queue.
    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith([target("codex", null)], {
      force: false,
    });
  });

  it("pauses the interval while the document is hidden and resumes when visible again (guardrail 2)", () => {
    mocks.configured = [ephemeralAmbientOnlyProvider("codex")];
    render(tree());
    enqueueBatchSpy.mockClear();

    act(() => {
      changeVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 3);
    });
    // Minimized/backgrounded: no subprocess-spawning enqueues at all.
    expect(enqueueBatchSpy).not.toHaveBeenCalled();

    act(() => {
      changeVisibility("visible");
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    // Brought back: polling resumes.
    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the window loses focus but stays visible - never keys off blur (guardrail 4)", () => {
    mocks.configured = [ephemeralAmbientOnlyProvider("codex")];
    render(tree());
    enqueueBatchSpy.mockClear();

    // OS focus moves elsewhere (e.g. Traycer visible on a second monitor). The
    // document stays "visible", so nothing must pause.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-gates on the next tick when a credential is removed mid-session, without resetting the timer", () => {
    mocks.configured = [
      ephemeralAmbientOnlyProvider("codex"),
      ephemeralAmbientOnlyProvider("claude-code"),
    ];
    const { rerender } = render(tree());
    enqueueBatchSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueBatchSpy).toHaveBeenCalledTimes(2);
    enqueueBatchSpy.mockClear();

    // claude-code's credential is removed mid-session -> it drops out of the
    // configured set. The ref updates on re-render; the interval keeps running.
    act(() => {
      mocks.configured = [ephemeralAmbientOnlyProvider("codex")];
      rerender(tree());
    });
    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith([target("codex", null)], {
      force: false,
    });
    enqueueBatchSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS);
    });
    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith([target("codex", null)], {
      force: false,
    });
  });

  it("does not run the interval while there is no host", () => {
    mocks.hostId = null;
    mocks.configured = [ephemeralAmbientOnlyProvider("codex")];
    render(tree());
    act(() => {
      vi.advanceTimersByTime(EPHEMERAL_RATE_LIMIT_POLL_INTERVAL_MS * 2);
    });
    expect(enqueueBatchSpy).not.toHaveBeenCalled();
  });

  it("sweeps an ambient login plus every fetch-eligible managed profile in a single batch call", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profileFixture("ambient", "ambient", "authenticated"),
          profileFixture("managed", "p1", "authenticated"),
          profileFixture("managed", "p2", "authenticated"),
        ],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ];
    render(tree());

    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith(
      [target("codex", null), target("codex", "p1"), target("codex", "p2")],
      { force: false },
    );
  });

  it("sweeps only the eligible managed profile when the ambient login itself is not eligible", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profileFixture("ambient", "ambient", "unauthenticated"),
          profileFixture("managed", "p1", "authenticated"),
        ],
        fetchEligibility: { ambient: false, managedProfiles: true },
      },
    ];
    render(tree());

    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith([target("codex", "p1")], {
      force: false,
    });
  });

  it("excludes a managed profile whose own credential is not fetch-eligible", () => {
    mocks.configured = [
      {
        providerId: "codex",
        lane: "ephemeralProcess",
        profiles: [
          profileFixture("ambient", "ambient", "authenticated"),
          profileFixture("managed", "p1", "authenticated"),
          profileFixture("managed", "p2", "unauthenticated"),
        ],
        fetchEligibility: { ambient: true, managedProfiles: true },
      },
    ];
    render(tree());

    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith(
      [target("codex", null), target("codex", "p1")],
      { force: false },
    );
  });

  it("falls back to a single ambient target when a provider reports no profile metadata", () => {
    mocks.configured = [ephemeralAmbientOnlyProvider("codex")];
    render(tree());

    expect(enqueueBatchSpy).toHaveBeenCalledTimes(1);
    expect(enqueueBatchSpy).toHaveBeenCalledWith([target("codex", null)], {
      force: false,
    });
  });
});
