import { describe, expect, it } from "vitest";
import type {
  ProviderAuthStatus,
  ProviderId,
  ProviderProfileKind,
} from "@traycer/protocol/host/provider-schemas";
import { soleSignedInProfileForSignedOutTerminal } from "../provider-ambient-auth";

function provider(input: {
  readonly providerId: ProviderId;
  readonly ambient: ProviderAuthStatus;
  readonly managed: readonly {
    readonly profileId: string;
    readonly status: ProviderAuthStatus;
    readonly enabled: boolean;
  }[];
}): {
  readonly providerId: ProviderId;
  readonly auth: { readonly status: ProviderAuthStatus };
  readonly profiles: readonly {
    readonly profileId: string;
    readonly kind: ProviderProfileKind;
    readonly enabled: boolean;
    readonly auth: { readonly status: ProviderAuthStatus };
  }[];
} {
  return {
    providerId: input.providerId,
    auth: { status: input.ambient },
    profiles: [
      {
        profileId: "ambient",
        kind: "ambient",
        enabled: true,
        auth: { status: input.ambient },
      },
      ...input.managed.map((row) => ({
        profileId: row.profileId,
        kind: "managed" as const,
        enabled: row.enabled,
        auth: { status: row.status },
      })),
    ],
  };
}

const ONE_SIGNED_IN = [
  {
    profileId: "profile-work",
    status: "authenticated" as const,
    enabled: true,
  },
];

describe("soleSignedInProfileForSignedOutTerminal", () => {
  it.each(["claude-code", "codex", "antigravity", "grok"] as const)(
    "names the one signed-in profile when %s's Terminal login is signed out",
    (providerId) => {
      expect(
        soleSignedInProfileForSignedOutTerminal(
          provider({
            providerId,
            ambient: "unauthenticated",
            managed: ONE_SIGNED_IN,
          }),
        ),
      ).toBe("profile-work");
    },
  );

  it("stays on the Terminal login when two profiles are signed in", () => {
    expect(
      soleSignedInProfileForSignedOutTerminal(
        provider({
          providerId: "claude-code",
          ambient: "unauthenticated",
          managed: [
            ...ONE_SIGNED_IN,
            {
              profileId: "profile-home",
              status: "authenticated",
              enabled: true,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it.each(["authenticated", "unknown", "unavailable"] as const)(
    "stays on the Terminal login when its verdict is %s",
    (ambient) => {
      expect(
        soleSignedInProfileForSignedOutTerminal(
          provider({
            providerId: "claude-code",
            ambient,
            managed: ONE_SIGNED_IN,
          }),
        ),
      ).toBeNull();
    },
  );

  it("does not count a disabled signed-in profile", () => {
    expect(
      soleSignedInProfileForSignedOutTerminal(
        provider({
          providerId: "claude-code",
          ambient: "unauthenticated",
          managed: [
            {
              profileId: "profile-work",
              status: "authenticated",
              enabled: false,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("names the one enabled signed-in profile when another signed-in profile is disabled", () => {
    expect(
      soleSignedInProfileForSignedOutTerminal(
        provider({
          providerId: "codex",
          ambient: "unauthenticated",
          managed: [
            {
              profileId: "profile-off",
              status: "authenticated",
              enabled: false,
            },
            {
              profileId: "profile-work",
              status: "authenticated",
              enabled: true,
            },
          ],
        }),
      ),
    ).toBe("profile-work");
  });
});
