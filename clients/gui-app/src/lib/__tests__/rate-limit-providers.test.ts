import { describe, expect, it } from "vitest";
import type {
  ProviderAuthStatus,
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  isRateLimitCapableProvider,
  isRateLimitProviderConfigured,
  rateLimitFetchLane,
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
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
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
