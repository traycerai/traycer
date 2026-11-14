import { assert, describe, expect, it } from "vitest";
import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  validateVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import { checkSurfaceCompatibility } from "@traycer/protocol/framework/surface-compat";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  buildUnreadableProviderProfile,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { resolveUnavailableMethodDegrade } from "@traycer/protocol/host-transport/remote/unavailable-method-degrade";

/**
 * Row contract for `environment.providers.list@1.0`. Registration, the
 * released floor and unsupported degrade are the redesign wire table.
 * Here: the shared profile rows, a provider entry with no accounts, and
 * the handshake when a peer does not advertise the method.
 */
const METHOD = "environment.providers.list";
const line = hostRpcRegistry[METHOD];
const responseSchema = line[1].versions[0].contract.responseSchema;

const auth = {
  status: "authenticated" as const,
  badgeText: null,
  label: null,
  detail: null,
};

/** A managed sign-in row with no computer-local facts and no `apiKey`. */
function neutralRow(profileId: string, label: string) {
  return {
    profileId,
    kind: "managed" as const,
    authType: "oauth" as const,
    label,
    auth,
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown" as const,
    ambientDriftNotice: null,
    enabled: true,
  };
}

const ABSENT_ON_A_TEAM_ROW = [
  "aliases",
  "terminalOnThisComputer",
  "launchCommand",
  "presence",
  "credentialHome",
  "credentialIdentity",
  "deliveryRefusal",
  "environmentProfileId",
  "otherNames",
  "personNotice",
  "reusedTombstone",
] as const satisfies readonly (keyof ProviderProfile)[];

const listedProfiles = [
  neutralRow("profile-sign-in", "Sign in"),
  {
    ...neutralRow("profile-api-key", "API key"),
    apiKey: { supported: false as const, configured: true as const },
  },
  neutralRow("profile-setup-token", "Setup token"),
];

describe("environment.providers.list rows", () => {
  it("keeps a readable managed row for a sign-in, an API key and a setup token", () => {
    const wire = {
      profileSyncEnabled: true,
      providers: [
        { providerId: "claude-code" as const, profiles: listedProfiles },
      ],
      onHostOnly: [{ providerId: "claude-code" as const }],
      removedProfiles: [],
      native: null,
    };
    const parsed = responseSchema.parse(wire);
    expect(parsed).not.toHaveProperty("onHostOnly");
    expect(parsed).not.toHaveProperty("removedProfiles");
    expect(parsed).not.toHaveProperty("native");

    const profiles = parsed.providers[0]?.profiles;
    assert.isDefined(profiles);
    expect(profiles).toHaveLength(3);
    expect(
      profiles.map((profile) => [profile.profileId, profile.label]),
    ).toEqual([
      ["profile-sign-in", "Sign in"],
      ["profile-api-key", "API key"],
      ["profile-setup-token", "Setup token"],
    ]);
    // `rateLimitLimitedScopes` and `duplicateOfProfileId` are omitted on the
    // wire. The shared row catch fills null, so the row stays readable.
    for (const row of profiles) {
      expect(row).toMatchObject({
        kind: "managed",
        authType: "oauth",
        enabled: true,
        identity: null,
        usageUpdatedAt: null,
        rateLimitStatus: "unknown",
        ambientDriftNotice: null,
        rateLimitLimitedScopes: null,
        duplicateOfProfileId: null,
      });
      expect(row.readability).toBeUndefined();
      for (const key of ABSENT_ON_A_TEAM_ROW) {
        expect(row[key]).toBeUndefined();
      }
    }
    expect(profiles.map((profile) => profile.apiKey)).toEqual([
      undefined,
      { supported: false, configured: true },
      undefined,
    ]);
  });

  it("rejects a provider entry whose profiles list is empty", () => {
    expect(
      responseSchema.safeParse({
        profileSyncEnabled: true,
        providers: [{ providerId: "claude-code", profiles: [] }],
      }).success,
    ).toBe(false);
  });

  it("turns an unknown row into the shared unreadable fallback and keeps the other row", () => {
    const parsed = responseSchema.parse({
      profileSyncEnabled: true,
      providers: [
        {
          providerId: "claude-code" as const,
          profiles: [
            neutralRow("profile-sign-in", "Sign in"),
            {
              ...neutralRow("profile-future", "Future"),
              recordVersion: 2,
            },
          ],
        },
      ],
    });
    const profiles = parsed.providers[0]?.profiles;
    assert.isDefined(profiles);
    expect(profiles).toHaveLength(2);
    const kept = profiles[0];
    const future = profiles[1];
    assert.isDefined(kept);
    assert.isDefined(future);
    expect(kept).toMatchObject({
      profileId: "profile-sign-in",
      label: "Sign in",
      enabled: true,
    });
    expect(kept.readability).toBeUndefined();
    expect(future).toEqual(
      buildUnreadableProviderProfile({
        profileId: "profile-future",
        label: "Future",
        kind: "managed",
        reason: "Profile row uses an unsupported or invalid shape",
      }),
    );
  });
});

describe("environment.providers.list handshake", () => {
  it("advertises the method on the optional manifest and treats a peer without it as advisory", () => {
    expect(() =>
      validateVersionedRpcRegistry({
        [METHOD]: hostRpcRegistry[METHOD],
      }),
    ).not.toThrow();
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    expect(split.optionalManifest[METHOD]).toEqual({ major: 1, minor: 0 });
    expect(split.manifest[METHOD]).toBeUndefined();

    const mine = buildProtocolSurface({
      unary: { [METHOD]: hostRpcRegistry[METHOD] },
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: {},
    });
    const theirs = buildProtocolSurface({
      unary: {},
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: {},
    });
    const result = checkSurfaceCompatibility({
      mine,
      theirs,
      theirsLabel: "released",
      exceptions: [],
    });
    expect(result.blocking).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        method: METHOD,
        family: "unary",
        severity: "advisory",
      }),
    ]);
    expect(result.findings[0]?.detail).toContain("unsupported");
  });

  it("answers unsupported when the peer does not advertise the method", async () => {
    await expect(
      resolveUnavailableMethodDegrade({
        registry: hostRpcRegistry,
        method: METHOD,
        methodRegistry: line,
        clientCanonical: { major: 1, minor: 0 },
        clientManifest: { [METHOD]: { major: 1, minor: 0 } },
        hostManifest: {},
        params: { environmentId: "env-1" },
        requestId: "req-providers-list",
        execute: () => Promise.reject(new Error("fallback must not run")),
      }),
    ).rejects.toMatchObject({
      code: "E_HOST_UNSUPPORTED",
      method: METHOD,
      fatalDetails: {
        code: "E_HOST_UNSUPPORTED",
        upgradeGuidance: {
          clientShouldUpgrade: false,
          hostShouldUpgrade: true,
        },
      },
    });
  });
});
