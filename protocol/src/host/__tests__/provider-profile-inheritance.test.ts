import { describe, expect, it } from "vitest";
import type { SpendScopeKey } from "../provider-credential-home-schemas";
import { resolveInheritedProfile } from "../provider-profile-inheritance";

const accountA: SpendScopeKey = {
  providerId: "claude-code",
  accountId: "account-a",
  organizationId: "org-a",
};

describe("provider profile inheritance", () => {
  it("matches destination profiles with the same account key", () => {
    const destinationKey: SpendScopeKey = {
      providerId: "claude-code",
      accountId: "account-a",
      organizationId: "org-a",
    };

    expect(
      resolveInheritedProfile(accountA, [
        { profileId: "destination-account-a", spendScopeKey: destinationKey },
      ]),
    ).toEqual({ kind: "match", profileId: "destination-account-a" });
  });

  it("does not match a destination profile with a distinct account key", () => {
    const destinationKey: SpendScopeKey = {
      providerId: "claude-code",
      accountId: "account-b",
      organizationId: "org-a",
    };

    expect(
      resolveInheritedProfile(accountA, [
        { profileId: "account-b", spendScopeKey: destinationKey },
      ]),
    ).toEqual({ kind: "not-on-destination" });
  });

  it("returns the distinct match, missing-account and unidentified outcomes", () => {
    const destination = [
      { profileId: "ambient", spendScopeKey: null },
      { profileId: "account-a", spendScopeKey: accountA },
    ];

    expect(resolveInheritedProfile(accountA, destination)).toEqual({
      kind: "match",
      profileId: "account-a",
    });
    expect(
      resolveInheritedProfile(
        { providerId: "claude-code", accountId: "other", organizationId: null },
        destination,
      ),
    ).toEqual({ kind: "not-on-destination" });
    expect(resolveInheritedProfile(null, destination)).toEqual({
      kind: "source-unidentified",
    });
  });

  it("matches email keys only when both keys use the provider's email form", () => {
    expect(
      resolveInheritedProfile(
        { providerId: "email-only-provider", email: "person@example.test" },
        [
          {
            profileId: "email-account",
            spendScopeKey: {
              providerId: "email-only-provider",
              email: "person@example.test",
            },
          },
        ],
      ),
    ).toEqual({ kind: "match", profileId: "email-account" });
  });
});
