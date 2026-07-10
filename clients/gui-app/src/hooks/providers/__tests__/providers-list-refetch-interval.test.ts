import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
  ProviderProfile,
  ProviderProfileRateLimitStatus,
} from "@traycer/protocol/host/provider-schemas";
import {
  PROVIDERS_LIST_LIMITED_REFRESH_MS,
  PROVIDERS_LIST_PENDING_REFRESH_MS,
  PROVIDERS_LIST_REFRESH_MS,
  providersListRefetchInterval,
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

describe("providersListRefetchInterval", () => {
  it("uses the steady catalog cadence when data is undefined (cold query)", () => {
    expect(providersListRefetchInterval(undefined)).toBe(
      PROVIDERS_LIST_REFRESH_MS,
    );
  });

  it("uses the steady catalog cadence when nothing is pending or limited", () => {
    expect(
      providersListRefetchInterval({
        providers: [providerState({ profiles: [profile("ok")] })],
      }),
    ).toBe(PROVIDERS_LIST_REFRESH_MS);
  });

  it("polls fast while an auth probe is pending", () => {
    expect(
      providersListRefetchInterval({
        providers: [providerState({ authPending: true })],
      }),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("polls fast while an availability probe is pending", () => {
    expect(
      providersListRefetchInterval({
        providers: [providerState({ availabilityPending: true })],
      }),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("polls fast while a candidate's version probe is pending", () => {
    expect(
      providersListRefetchInterval({
        providers: [
          providerState({
            candidates: [
              {
                kind: "bundled",
                path: "/bin/claude",
                available: true,
                version: null,
                versionPending: true,
              },
            ],
          }),
        ],
      }),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });

  it("bounds the interval to 30s while a profile is near its rate limit", () => {
    expect(
      providersListRefetchInterval({
        providers: [providerState({ profiles: [profile("near_limit")] })],
      }),
    ).toBe(PROVIDERS_LIST_LIMITED_REFRESH_MS);
  });

  it("bounds the interval to 30s while a profile is at its hard limit", () => {
    expect(
      providersListRefetchInterval({
        providers: [providerState({ profiles: [profile("hard_limit")] })],
      }),
    ).toBe(PROVIDERS_LIST_LIMITED_REFRESH_MS);
  });

  it("prefers the pending cadence over the limited cadence when both apply", () => {
    expect(
      providersListRefetchInterval({
        providers: [
          providerState({
            authPending: true,
            profiles: [profile("hard_limit")],
          }),
        ],
      }),
    ).toBe(PROVIDERS_LIST_PENDING_REFRESH_MS);
  });
});
