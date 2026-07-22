import { describe, expect, it } from "vitest";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  isRateLimitCapableProvider,
  isRateLimitProfileFetchEligible,
  isRateLimitProviderConfigured,
  rateLimitFetchLane,
  resolveRateLimitFetchEligibility,
} from "@/lib/rate-limit-providers";

function state(
  overrides: Partial<ProviderCliState> & { readonly providerId: ProviderId },
): ProviderCliState {
  return {
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    ...overrides,
  };
}

describe("rateLimitFetchLane", () => {
  it("maps codex and claude-code to the ephemeralProcess (subprocess) lane", () => {
    expect(rateLimitFetchLane("codex")).toBe("ephemeralProcess");
    expect(rateLimitFetchLane("claude-code")).toBe("ephemeralProcess");
  });

  it("maps openrouter and kilocode to the httpFetch (cheap GET) lane", () => {
    expect(rateLimitFetchLane("openrouter")).toBe("httpFetch");
    expect(rateLimitFetchLane("kilocode")).toBe("httpFetch");
  });
});

describe("isRateLimitCapableProvider", () => {
  it("accepts the four rate-limit-capable providers and rejects others", () => {
    expect(isRateLimitCapableProvider("codex")).toBe(true);
    expect(isRateLimitCapableProvider("kilocode")).toBe(true);
    expect(isRateLimitCapableProvider("cursor")).toBe(false);
    expect(isRateLimitCapableProvider("traycer")).toBe(false);
  });
});

describe("isRateLimitProviderConfigured", () => {
  it("treats authenticated and configured (credential present) as eligible", () => {
    expect(
      isRateLimitProviderConfigured(
        state({ providerId: "codex", auth: authStatus("authenticated") }),
      ),
    ).toBe(true);
    expect(
      isRateLimitProviderConfigured(
        state({ providerId: "openrouter", auth: authStatus("configured") }),
      ),
    ).toBe(true);
  });

  it("excludes providers with no usable credential", () => {
    for (const status of [
      "unauthenticated",
      "unavailable",
      "unknown",
    ] as const) {
      expect(
        isRateLimitProviderConfigured(
          state({ providerId: "codex", auth: authStatus(status) }),
        ),
      ).toBe(false);
    }
  });

  it("excludes providers whose verdict has not settled", () => {
    expect(
      isRateLimitProviderConfigured(
        state({ providerId: "codex", authPending: true }),
      ),
    ).toBe(false);
    expect(
      isRateLimitProviderConfigured(
        state({ providerId: "codex", availabilityPending: true }),
      ),
    ).toBe(false);
  });

  it("excludes a provider the user has disabled", () => {
    expect(
      isRateLimitProviderConfigured(
        state({ providerId: "codex", enabled: false }),
      ),
    ).toBe(false);
  });
});

function authStatus(status: ProviderAuthStatus): ProviderCliState["auth"] {
  return { status, badgeText: null, label: null, detail: null };
}

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  status: ProviderAuthStatus,
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label: profileId,
    auth: authStatus(status),
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
    accentColor: null,
  };
}

describe("resolveRateLimitFetchEligibility", () => {
  it("uses a present ambient row as the definitive ambient verdict and keeps the no-profile fallback summary-based", () => {
    for (const summaryStatus of ["authenticated", "configured"] as const) {
      const ambientSignedOut = state({
        providerId: "codex",
        auth: authStatus(summaryStatus),
        profiles: [profile("ambient", "ambient", "unauthenticated")],
      });

      expect(resolveRateLimitFetchEligibility(ambientSignedOut)).toEqual({
        ambient: false,
        managedProfiles: true,
      });
      expect(isRateLimitProviderConfigured(ambientSignedOut)).toBe(false);
    }

    expect(
      isRateLimitProviderConfigured(
        state({ providerId: "codex", auth: authStatus("authenticated") }),
      ),
    ).toBe(true);
  });

  it("keeps an authenticated managed target eligible while another managed profile is pending, but still honors provider gates", () => {
    const managed = profile("managed", "managed", "authenticated");
    const pending = state({
      providerId: "codex",
      authPending: true,
      profiles: [managed],
    });

    const pendingEligibility = resolveRateLimitFetchEligibility(pending);
    expect(pendingEligibility.managedProfiles).toBe(true);
    expect(isRateLimitProfileFetchEligible(pendingEligibility, managed)).toBe(
      true,
    );

    for (const overrides of [
      { enabled: false },
      { availabilityPending: true },
    ]) {
      const gated = resolveRateLimitFetchEligibility(
        state({ providerId: "codex", profiles: [managed], ...overrides }),
      );
      expect(gated.managedProfiles).toBe(false);
      expect(isRateLimitProfileFetchEligible(gated, managed)).toBe(false);
    }
  });
});
