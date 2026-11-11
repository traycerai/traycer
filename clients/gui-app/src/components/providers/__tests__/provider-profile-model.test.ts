import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { describe, expect, it } from "vitest";
import {
  profileEligibilityToggleDisabledReason,
  profileInventorySummary,
} from "@/components/providers/provider-profile-model";

type CredentialHome = NonNullable<ProviderProfile["credentialHome"]>;
type Standing = NonNullable<CredentialHome["standing"]>;

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

function credentialHome(standing: Partial<Standing>): CredentialHome {
  return {
    homeAddress: "synthetic-home",
    bindingVersion: 1,
    materialRevision: 1,
    custodyVersion: 1,
    custodyClass: "self-sufficient",
    environmentPresence: null,
    handoffEnvironmentId: null,
    materialFingerprint: "synthetic-material",
    observation: null,
    materialMatchesBinding: "yes",
    standing: {
      material: "usable",
      repairDeadline: null,
      familyVersion: null,
      authority: null,
      cause: null,
      observation: { source: "custodian", status: "answered", capturedAt: 1 },
      ...standing,
    },
  };
}

function profileWithStanding(
  standing: Partial<Standing>,
  overrides: Partial<ProviderProfile>,
): ProviderProfile {
  return buildProfile({
    credentialHome: credentialHome(standing),
    ...overrides,
  });
}

describe("profileInventorySummary", () => {
  it.each([
    ["stale", "Stale"],
    ["rejected", "Credential rejected"],
    ["refused-by-provider", "Refused by provider"],
  ] as const)(
    "badges %s standing and moves its cause to the detail",
    (material, badge) => {
      expect(
        profileInventorySummary(
          profileWithStanding({ material, cause: "plan lapsed" }, {}),
        ),
      ).toEqual({ badge, detail: "plan lapsed" });
    },
  );

  it("badges Unknown with the cause when the observation is unknown or the material is null", () => {
    const unknownObservation = profileWithStanding(
      {
        cause: "probe timed out",
        observation: { source: "custodian", status: "unknown", capturedAt: 1 },
      },
      {},
    );
    expect(profileInventorySummary(unknownObservation)).toEqual({
      badge: "Unknown",
      detail: "probe timed out",
    });
    expect(
      profileInventorySummary(
        profileWithStanding({ material: null, cause: null }, {}),
      ),
    ).toEqual({ badge: "Unknown", detail: null });
  });

  it("does not repeat the standing head word when there is no cause", () => {
    expect(
      profileInventorySummary(
        profileWithStanding({ material: "signed-out", cause: null }, {}),
      ),
    ).toEqual({ badge: "Signed out", detail: null });
  });

  it("uses the auth vocabulary and no detail for a usable standing", () => {
    expect(profileInventorySummary(profileWithStanding({}, {}))).toEqual({
      badge: "Signed in",
      detail: null,
    });
  });

  it("falls back to the auth vocabulary without a credential standing", () => {
    expect(
      profileInventorySummary(
        buildProfile({
          auth: {
            status: "unauthenticated",
            badgeText: null,
            label: null,
            detail: null,
          },
        }),
      ),
    ).toEqual({ badge: "Signed out", detail: null });
  });

  it("keeps the revoking and unreadable notices whole", () => {
    expect(
      profileInventorySummary(
        buildProfile({
          presence: { kind: "revoking", cause: "signed-out-by-person" },
        }),
      ),
    ).toEqual({ badge: "Signed in", detail: "Disconnecting: signed out." });
    expect(
      profileInventorySummary(
        buildProfile({
          readability: { kind: "unreadable", reason: "bad row" },
        }),
      ),
    ).toEqual({ badge: "Signed in", detail: "Unreadable profile: bad row" });
  });

  it("adds no copy for an absent environment presence", () => {
    expect(
      profileInventorySummary(
        buildProfile({
          credentialHome: {
            ...credentialHome({}),
            environmentPresence: {
              scope: "environment",
              environmentId: "env-1",
              state: "absent",
              retainedReason: null,
              cause: null,
            },
          },
        }),
      ),
    ).toEqual({ badge: "Signed in", detail: null });
  });
});

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
