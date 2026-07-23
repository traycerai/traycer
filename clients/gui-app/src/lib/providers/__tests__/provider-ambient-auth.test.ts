import { describe, expect, it } from "vitest";
import type {
  ProviderAuth,
  ProviderAuthStatus,
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  isProviderAmbientAuthenticated,
  isProviderAmbientSignedOut,
} from "../provider-ambient-auth";

function auth(status: ProviderAuthStatus): ProviderAuth {
  return { status, badgeText: null, label: null, detail: null };
}

function ambientProfile(status: ProviderAuthStatus): ProviderProfile {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal account",
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

function providerState(
  providerAuthStatus: ProviderAuthStatus,
  profiles: ProviderProfile[],
): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: auth(providerAuthStatus),
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles,
  };
}

describe("isProviderAmbientSignedOut", () => {
  it("is true when the provider-level probe alone is unauthenticated", () => {
    const state = providerState("unauthenticated", []);
    expect(isProviderAmbientSignedOut(state)).toBe(true);
  });

  it("is true when only the ambient profile row is unauthenticated and the summary lags at unavailable", () => {
    const state = providerState("unavailable", [
      ambientProfile("unauthenticated"),
    ]);
    expect(isProviderAmbientSignedOut(state)).toBe(true);
  });

  it("is false when both sources are only transiently unknown", () => {
    const state = providerState("unknown", [ambientProfile("unknown")]);
    expect(isProviderAmbientSignedOut(state)).toBe(false);
  });

  it("is false when both sources are unavailable (not yet converged, not definitive)", () => {
    const state = providerState("unavailable", [ambientProfile("unavailable")]);
    expect(isProviderAmbientSignedOut(state)).toBe(false);
  });
});

describe("isProviderAmbientAuthenticated", () => {
  it("is true when both sources report authenticated", () => {
    const state = providerState("authenticated", [
      ambientProfile("authenticated"),
    ]);
    expect(isProviderAmbientAuthenticated(state)).toBe(true);
  });

  it("is true when the ambient profile row reports authenticated while the summary still lags at unavailable", () => {
    const state = providerState("unavailable", [
      ambientProfile("authenticated"),
    ]);
    expect(isProviderAmbientAuthenticated(state)).toBe(true);
  });

  it("is false (signed-out wins) when the provider-level probe is authenticated but the ambient row is definitively unauthenticated", () => {
    const state = providerState("authenticated", [
      ambientProfile("unauthenticated"),
    ]);
    expect(isProviderAmbientAuthenticated(state)).toBe(false);
  });

  it("is false (signed-out wins) when the ambient row is authenticated but the provider-level probe is definitively unauthenticated", () => {
    const state = providerState("unauthenticated", [
      ambientProfile("authenticated"),
    ]);
    expect(isProviderAmbientAuthenticated(state)).toBe(false);
  });

  it("is false when neither source has reached a definitive authenticated verdict", () => {
    const state = providerState("unknown", [ambientProfile("unavailable")]);
    expect(isProviderAmbientAuthenticated(state)).toBe(false);
  });
});
