import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { resolveSeededProfileId } from "../resolve-seeded-profile-id";

/**
 * Ticket 07 (protocol-schema-contract-compat review's Major finding): a
 * settled-empty `profiles[]` (old host, or flag-off/unsupported provider)
 * must be judged "no support here" and clear the pin - distinct from an
 * unsettled query, which must hold the pin verbatim.
 */

function profile(
  profileId: string,
  kind: "ambient" | "managed",
): ProviderProfile {
  return {
    profileId,
    kind,
    authType: "oauth",
    label: profileId,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

describe("resolveSeededProfileId", () => {
  it("passes an already-ambient profileId through untouched, regardless of settled/profiles", () => {
    expect(resolveSeededProfileId(null, undefined, false)).toBeNull();
    expect(resolveSeededProfileId(null, [], true)).toBeNull();
    expect(
      resolveSeededProfileId(null, [profile("work", "managed")], true),
    ).toBeNull();
  });

  it("preserves a non-null profileId while unsettled, even with an empty/undefined profiles array", () => {
    expect(resolveSeededProfileId("work-uuid", undefined, false)).toBe(
      "work-uuid",
    );
    expect(resolveSeededProfileId("work-uuid", [], false)).toBe("work-uuid");
  });

  it("ticket 07: clears a non-null profileId to null once settled with an empty profiles array", () => {
    expect(resolveSeededProfileId("work-uuid", [], true)).toBeNull();
  });

  it("ticket 07: clears a non-null profileId to null once settled with an undefined profiles entry (provider not found in a settled response)", () => {
    expect(resolveSeededProfileId("work-uuid", undefined, true)).toBeNull();
  });

  it("keeps a still-live profile id when settled and the profile is present", () => {
    const profiles = [
      profile("ambient", "ambient"),
      profile("work-uuid", "managed"),
    ];
    expect(resolveSeededProfileId("work-uuid", profiles, true)).toBe(
      "work-uuid",
    );
  });

  it("resolves a tombstoned/removed profile id to null when settled with a non-empty but non-matching profiles array (ambient-only, flag-on host - unchanged behavior)", () => {
    const profiles = [profile("ambient", "ambient")];
    expect(resolveSeededProfileId("work-uuid", profiles, true)).toBeNull();
  });
});
