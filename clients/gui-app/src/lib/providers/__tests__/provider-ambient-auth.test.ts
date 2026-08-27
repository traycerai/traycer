import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import { describe, expect, it } from "vitest";
import type {
  ProviderAuth,
  ProviderAuthStatus,
  ProviderCliState,
  ProviderMutationCliStateV21,
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
    enabled: true,
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
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
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

/**
 * The verdict is typed by the two fields it reads, not by one concrete state,
 * so the shape a MUTATION echo carries gets the identical answer.
 *
 * `ProviderMutationCliStateV21` is not assignable to `ProviderCliState` in
 * either direction - it has no `nativeCapabilities` and none of the
 * provider-pack-registry fields - but it shares `PROVIDER_AUTH_SCHEMA_V20` for
 * `auth` and builds `profiles` from the same `providerProfileShapeV70`. Before
 * the parameter was structural, onboarding's `awaitLogin` completion could not
 * call this at all, so it open-coded `state.auth.status === "authenticated"`
 * and silently dropped the profile half of the verdict.
 */
function mutationState(
  providerAuthStatus: ProviderAuthStatus,
  profiles: ProviderProfile[],
): ProviderMutationCliStateV21 {
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

describe("the ambient verdict on a mutation state echo", () => {
  it("honours an ambient row that authenticates before the summary converges", () => {
    const state = mutationState("unavailable", [
      ambientProfile("authenticated"),
    ]);
    expect(isProviderAmbientAuthenticated(state)).toBe(true);
    expect(isProviderAmbientSignedOut(state)).toBe(false);
  });

  it("lets a definitive signed-out ambient row beat a stale authenticated summary", () => {
    const state = mutationState("authenticated", [
      ambientProfile("unauthenticated"),
    ]);
    expect(isProviderAmbientAuthenticated(state)).toBe(false);
    expect(isProviderAmbientSignedOut(state)).toBe(true);
  });
});
