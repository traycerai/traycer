import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import {
  PROVIDERS_LIST_LIMITED_REFRESH_MS,
  PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS,
  PROVIDERS_LIST_PENDING_REFRESH_MS,
  PROVIDERS_LIST_REFRESH_MS,
  providersListRefetchInterval,
  providersListRefetchIntervalForQuery,
} from "@/hooks/providers/providers-list-refetch-interval";

function profile(
  rateLimitStatus: ProviderProfileRateLimitStatus,
): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus,
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  const providerId: ProviderId = "claude-code";
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    ...overrides,
  };
}

const candidateVersionPending: ProviderCliState["candidates"] = [
  {
    kind: "bundled",
    path: "/bin/claude",
    available: true,
    version: null,
    versionPending: true,
  },
];

describe("providersListRefetchInterval", () => {
  it("uses the steady catalog cadence when data is undefined (cold query)", () => {
    expect(providersListRefetchInterval(undefined, 0)).toBe(
      PROVIDERS_LIST_REFRESH_MS,
    );
  });

  it("uses the steady catalog cadence when nothing is pending or limited", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [providerState({ profiles: [profile("ok")] })],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_REFRESH_MS);
  });

  it("polls fast while an auth probe is pending", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [providerState({ authPending: true })],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("polls fast while an availability probe is pending", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [providerState({ availabilityPending: true })],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("polls fast while a candidate's version probe is pending", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [providerState({ candidates: candidateVersionPending })],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("bounds the interval to 30s while a profile is near its rate limit", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [providerState({ profiles: [profile("near_limit")] })],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_LIMITED_REFRESH_MS);
  });

  it("bounds the interval to 30s while a profile is at its hard limit", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [providerState({ profiles: [profile("hard_limit")] })],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_LIMITED_REFRESH_MS);
  });

  it("prefers the pending cadence over the limited cadence when both apply", () => {
    expect(
      providersListRefetchInterval(
        {
          providers: [
            providerState({
              authPending: true,
              profiles: [profile("hard_limit")],
            }),
          ],
        },
        0,
      ),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("ignores a DISABLED provider's pending probes so it never drives the fast-poll", () => {
    const disabledPending = {
      providers: [
        providerState({
          enabled: false,
          authPending: true,
          availabilityPending: true,
          candidates: candidateVersionPending,
        }),
      ],
    };
    expect(providersListRefetchInterval(disabledPending, 0)).toBe(
      PROVIDERS_LIST_REFRESH_MS,
    );
  });

  it("still fast-polls an enabled provider alongside a disabled pending one", () => {
    const mixed = {
      providers: [
        providerState({ providerId: "claude-code", availabilityPending: true }),
        providerState({
          providerId: "codex",
          enabled: false,
          availabilityPending: true,
        }),
      ],
    };
    expect(providersListRefetchInterval(mixed, 0)).toBe(
      PROVIDERS_LIST_PENDING_REFRESH_MS,
    );
  });

  it("keeps fast-polling right up to the budget, then backs off to the bounded cadence", () => {
    const pending = {
      providers: [providerState({ availabilityPending: true })],
    };
    expect(
      providersListRefetchInterval(
        pending,
        PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS,
      ),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
    expect(
      providersListRefetchInterval(
        pending,
        PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS + 1,
      ),
    ).toBe(PROVIDERS_LIST_LIMITED_REFRESH_MS);
  });
});

describe("providersListRefetchIntervalForQuery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Stand-in for the shared TanStack Query every observer of one providers.list
  // query receives; the budget is keyed to this object identity.
  function queryWith(data: { providers: ProviderCliState[] }): {
    state: { data: { providers: ProviderCliState[] } };
  } {
    return { state: { data } };
  }

  const pending = { providers: [providerState({ availabilityPending: true })] };
  const calm = { providers: [providerState({ profiles: [profile("ok")] })] };

  it("caps a stuck pending flag: fast-poll within budget, bounded past it, budget resets when pending clears", () => {
    vi.useFakeTimers();
    const query = queryWith(pending);

    // First pending observation starts the budget clock -> fast-poll.
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_PENDING_REFRESH_MS,
    );

    // Still pending, still within budget -> fast-poll.
    vi.advanceTimersByTime(PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS - 1);
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_PENDING_REFRESH_MS,
    );

    // Budget overrun -> back off so a stuck flag can't perpetually 800ms-poll.
    vi.advanceTimersByTime(2);
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_LIMITED_REFRESH_MS,
    );

    // Pending clears -> steady cadence and the budget resets.
    query.state.data = calm;
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_REFRESH_MS,
    );

    // A fresh pending episode on the same query gets the full window again.
    query.state.data = pending;
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_PENDING_REFRESH_MS,
    );
  });

  it("scopes the budget to the query, so a late-mounting observer cannot re-arm the fast-poll", () => {
    vi.useFakeTimers();
    const query = queryWith(pending);

    // Budget starts on the first observer's read, then overruns.
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_PENDING_REFRESH_MS,
    );
    vi.advanceTimersByTime(PROVIDERS_LIST_PENDING_FAST_POLL_BUDGET_MS + 1);

    // A second observer reads the SAME shared query object: it inherits the
    // elapsed budget and stays bounded rather than restarting the 800ms poll.
    expect(providersListRefetchIntervalForQuery(query)).toBe(
      PROVIDERS_LIST_LIMITED_REFRESH_MS,
    );

    // A DIFFERENT query (e.g. a host/key switch) starts its own fresh budget.
    const otherHostQuery = queryWith(pending);
    expect(providersListRefetchIntervalForQuery(otherHostQuery)).toBe(
      PROVIDERS_LIST_PENDING_REFRESH_MS,
    );
  });
});
