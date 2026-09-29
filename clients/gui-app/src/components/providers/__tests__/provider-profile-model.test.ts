import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { describe, expect, it } from "vitest";
import { profileEligibilityToggleDisabledReason } from "@/components/providers/provider-profile-model";

function buildProfile(overrides: Partial<ProviderProfile>): ProviderProfile {
  return {
    profileId: "profile-1",
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
    ...overrides,
  };
}

/**
 * The host-gating redesign: a provider that is off holds every profile
 * control except the one move the host itself is waiting for - turning a
 * profile on so the provider switch has something to flip on for. See the
 * doc comment on `profileEligibilityToggleDisabledReason` in
 * `provider-profile-model.ts`.
 */
describe("profileEligibilityToggleDisabledReason", () => {
  it("holds every profile's toggle with the provider's own hint while the provider is off and another profile is already enabled", () => {
    const target = buildProfile({ profileId: "target", enabled: false });
    const other = buildProfile({ profileId: "other", enabled: true });

    expect(
      profileEligibilityToggleDisabledReason(false, "OpenCode", target, [
        target,
        other,
      ]),
    ).toBe("OpenCode is turned off. Turn it on to change its profiles.");

    // The rule holds the OTHER profile's own toggle too - it is not
    // singling out the one the caller passed in.
    expect(
      profileEligibilityToggleDisabledReason(false, "OpenCode", other, [
        target,
        other,
      ]),
    ).toBe("OpenCode is turned off. Turn it on to change its profiles.");
  });

  it("leaves the toggle live when the provider is off and no profile is enabled at all", () => {
    const target = buildProfile({ profileId: "target", enabled: false });
    const other = buildProfile({ profileId: "other", enabled: false });

    expect(
      profileEligibilityToggleDisabledReason(false, "OpenCode", target, [
        target,
        other,
      ]),
    ).toBeNull();
  });

  it("leaves an already-disabled profile's toggle live while the provider is on", () => {
    const target = buildProfile({ profileId: "target", enabled: false });

    expect(
      profileEligibilityToggleDisabledReason(true, "OpenCode", target, [
        target,
      ]),
    ).toBeNull();
  });

  it("holds the last enabled profile's toggle while the provider is on, so at least one stays enabled", () => {
    const onlyEnabled = buildProfile({ profileId: "only", enabled: true });

    expect(
      profileEligibilityToggleDisabledReason(true, "OpenCode", onlyEnabled, [
        onlyEnabled,
      ]),
    ).toBe("Enable another profile before disabling this one.");
  });

  it("lets an enabled profile's toggle move while the provider is on and another profile is also enabled", () => {
    const target = buildProfile({ profileId: "target", enabled: true });
    const other = buildProfile({ profileId: "other", enabled: true });

    expect(
      profileEligibilityToggleDisabledReason(true, "OpenCode", target, [
        target,
        other,
      ]),
    ).toBeNull();
  });
});
