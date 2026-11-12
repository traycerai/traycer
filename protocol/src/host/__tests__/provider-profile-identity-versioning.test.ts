import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

const providersList = hostRpcRegistry["providers.list"][10];
// The 10.9 line's response row. A frozen line of its own since 10.10 opened
// above it (`hiddenModelProviders`), so it is no longer the live schema.
const providersListResponseSchema =
  providersList.versions[9].contract.responseSchema;

const profile = {
  profileId: "managed-1",
  kind: "managed",
  authType: "oauth",
  label: "Work",
  auth: { status: "unknown", badgeText: null, label: null, detail: null },
  identity: null,
  usageUpdatedAt: null,
  rateLimitStatus: "ok",
  rateLimitLimitedScopes: null,
  duplicateOfProfileId: null,
  accentColor: null,
  ambientDriftNotice: null,
  enabled: true,
};

const currentManagedProfile = {
  ...profile,
  recordVersion: 1,
  credentialIdentity: {
    kind: "spend-scoped",
    spendScopeKey: {
      providerId: "claude-code",
      accountId: "synthetic-account",
      organizationId: "synthetic-org",
    },
    provenance: "provider credential",
  },
  credentialHome: {
    homeAddress: "/synthetic/home",
    bindingVersion: 1,
    materialRevision: 1,
    custodyVersion: 1,
    custodyClass: "self-sufficient",
    environmentPresence: null,
    handoffEnvironmentId: null,
    materialFingerprint: "synthetic-digest",
    observation: null,
    materialMatchesBinding: "unknown",
  },
};

const provider = {
  providerId: "claude-code",
  enabled: true,
  disabledBy: null,
  selected: { kind: "bundled" },
  candidates: [],
  auth: { status: "unknown", badgeText: null, label: null, detail: null },
  authPending: false,
  checkedAt: null,
  apiKey: { supported: false, configured: false, source: null },
  terminalAgentArgs: "",
  envOverrides: [],
  loginCapability: null,
  availabilityPending: false,
  nativeCapabilities: {
    supportedTabs: ["general", "env", "usage"],
    mcp: null,
    plugins: null,
    skills: null,
  },
  profiles: [
    currentManagedProfile,
    {
      ...profile,
      profileId: "future-row",
      label: "Future",
      recordVersion: 2,
      futureField: { retainedByHost: true },
    },
  ],
};

describe("providers.list@10.9 additive response projection", () => {
  it("keeps valid identity facts and surfaces one future row as unreadable", () => {
    const parsed = providersListResponseSchema.parse({ providers: [provider] });
    const profiles = parsed.providers[0]?.profiles;

    expect(profiles).toHaveLength(2);
    expect(profiles?.[0]).toMatchObject({
      profileId: "managed-1",
      recordVersion: 1,
      credentialIdentity: {
        kind: "spend-scoped",
        spendScopeKey: { accountId: "synthetic-account" },
      },
      credentialHome: {
        bindingVersion: 1,
        materialRevision: 1,
        custodyVersion: 1,
      },
    });
    expect(profiles?.[1]).toMatchObject({
      profileId: "future-row",
      enabled: false,
      readability: {
        kind: "unreadable",
        reason: "Profile row uses an unsupported or invalid shape",
      },
    });
  });

  it.each([
    {
      name: "delivery refusal and profile presence",
      fallback: "delivery-and-presence",
      currentProfile: {
        ...currentManagedProfile,
        deliveryRefusal: "synthetic-future-delivery-refusal",
        presence: { kind: "synthetic-future-presence" },
      },
    },
    {
      name: "credential identity kind",
      fallback: "credential-identity",
      currentProfile: {
        ...currentManagedProfile,
        credentialIdentity: { kind: "synthetic-future-identity" },
      },
    },
    {
      name: "credential home custody class",
      fallback: "credential-home",
      currentProfile: {
        ...currentManagedProfile,
        credentialHome: {
          ...currentManagedProfile.credentialHome,
          custodyClass: "synthetic-future-custody",
        },
      },
    },
    {
      name: "credential standing material",
      fallback: "standing",
      currentProfile: {
        ...currentManagedProfile,
        credentialHome: {
          ...currentManagedProfile.credentialHome,
          standing: {
            material: "synthetic-future-material",
            repairDeadline: null,
            familyVersion: null,
            authority: null,
            cause: null,
            observation: {
              source: "install",
              status: "answered",
              capturedAt: 1,
            },
          },
        },
      },
    },
    {
      name: "revoking profile presence cause",
      fallback: "revoking-presence-cause",
      currentProfile: {
        ...currentManagedProfile,
        presence: {
          kind: "revoking",
          cause: "synthetic-future-presence-cause",
        },
      },
    },
    {
      name: "credential home environment presence cause",
      fallback: "environment-presence-cause",
      currentProfile: {
        ...currentManagedProfile,
        credentialHome: {
          ...currentManagedProfile.credentialHome,
          environmentPresence: {
            scope: "environment",
            environmentId: "synthetic-environment",
            state: "revoking",
            retainedReason: null,
            cause: "synthetic-future-environment-cause",
          },
        },
      },
    },
  ])(
    "keeps the current profile readable when $name is from the future",
    ({ currentProfile, fallback }) => {
      const parsed = providersListResponseSchema.parse({
        providers: [
          {
            ...provider,
            profiles: [currentProfile],
          },
        ],
      });
      const profiles = parsed.providers[0]?.profiles;
      const parsedProfile = profiles?.[0];

      expect(profiles).toHaveLength(1);
      expect(parsedProfile).toMatchObject({
        profileId: "managed-1",
        enabled: true,
        recordVersion: 1,
      });
      expect(parsedProfile?.readability?.kind).not.toBe("unreadable");
      switch (fallback) {
        case "delivery-and-presence":
          expect(parsedProfile).toMatchObject({
            credentialIdentity: currentManagedProfile.credentialIdentity,
            credentialHome: currentManagedProfile.credentialHome,
            deliveryRefusal: null,
          });
          expect(parsedProfile?.presence).toBeUndefined();
          break;
        case "credential-identity":
          expect(parsedProfile?.credentialIdentity).toBeUndefined();
          expect(parsedProfile?.credentialHome).toMatchObject(
            currentManagedProfile.credentialHome,
          );
          break;
        case "credential-home":
          expect(parsedProfile?.credentialIdentity).toMatchObject(
            currentManagedProfile.credentialIdentity,
          );
          expect(parsedProfile?.credentialHome).toBeUndefined();
          break;
        case "standing":
          expect(parsedProfile?.credentialIdentity).toMatchObject(
            currentManagedProfile.credentialIdentity,
          );
          expect(parsedProfile?.credentialHome).toMatchObject({
            homeAddress: "/synthetic/home",
            bindingVersion: 1,
            custodyVersion: 1,
          });
          expect(parsedProfile?.credentialHome?.standing).toBeUndefined();
          break;
        case "revoking-presence-cause":
          expect(parsedProfile?.credentialIdentity).toMatchObject(
            currentManagedProfile.credentialIdentity,
          );
          expect(parsedProfile?.credentialHome).toMatchObject(
            currentManagedProfile.credentialHome,
          );
          expect(parsedProfile?.presence).toEqual({
            kind: "revoking",
            cause: null,
          });
          break;
        case "environment-presence-cause":
          expect(parsedProfile?.credentialIdentity).toMatchObject(
            currentManagedProfile.credentialIdentity,
          );
          expect(parsedProfile?.credentialHome).toMatchObject({
            homeAddress: "/synthetic/home",
            environmentPresence: {
              scope: "environment",
              environmentId: "synthetic-environment",
              state: "revoking",
              retainedReason: null,
              cause: null,
            },
          });
          break;
      }
    },
  );

  it.each([
    {
      name: "environment presence with a known foreign entry",
      homePresence: {
        scope: "environment",
        environmentId: "synthetic-environment",
        state: "absent",
        retainedReason: "foreign-entry",
        cause: null,
      },
      expectedRetainedReason: "foreign-entry",
      profilePresence: { kind: "revoking", cause: "host-left-environment" },
    },
    {
      name: "local presence with a known foreign entry",
      homePresence: {
        scope: "local",
        state: "absent",
        retainedReason: "foreign-entry",
        cause: "signed-out-by-person",
      },
      expectedRetainedReason: "foreign-entry",
      profilePresence: { kind: "revoking", cause: "signed-out-by-person" },
    },
    {
      name: "environment presence with a future retained reason",
      homePresence: {
        scope: "environment",
        environmentId: "synthetic-environment",
        state: "absent",
        retainedReason: "synthetic-future-retained-reason",
        cause: null,
      },
      expectedRetainedReason: null,
      profilePresence: { kind: "revoking", cause: "host-left-environment" },
    },
    {
      name: "local presence with a future retained reason",
      homePresence: {
        scope: "local",
        state: "absent",
        retainedReason: "synthetic-future-retained-reason",
        cause: "signed-out-by-person",
      },
      expectedRetainedReason: null,
      profilePresence: { kind: "revoking", cause: "signed-out-by-person" },
    },
  ])(
    "keeps the home and account-absence state for $name",
    ({ homePresence, expectedRetainedReason, profilePresence }) => {
      const parsed = providersListResponseSchema.parse({
        providers: [
          {
            ...provider,
            profiles: [
              {
                ...currentManagedProfile,
                credentialHome: {
                  ...currentManagedProfile.credentialHome,
                  environmentPresence: homePresence,
                },
                presence: profilePresence,
              },
            ],
          },
        ],
      });
      const parsedProfile = parsed.providers[0]?.profiles[0];

      expect(parsedProfile).toMatchObject({
        profileId: "managed-1",
        enabled: true,
        recordVersion: 1,
        credentialIdentity: currentManagedProfile.credentialIdentity,
        credentialHome: {
          homeAddress: "/synthetic/home",
          bindingVersion: 1,
          materialRevision: 1,
          environmentPresence: {
            ...homePresence,
            retainedReason: expectedRetainedReason,
          },
        },
        presence: profilePresence,
      });
      expect(parsedProfile?.readability?.kind).not.toBe("unreadable");
    },
  );

  it("keeps an unknown readability kind row-wide unreadable", () => {
    const parsed = providersListResponseSchema.parse({
      providers: [
        {
          ...provider,
          profiles: [
            {
              ...currentManagedProfile,
              readability: {
                kind: "synthetic-future-readability",
                reason: null,
              },
            },
          ],
        },
      ],
    });
    const parsedProfile = parsed.providers[0]?.profiles[0];

    expect(parsed.providers[0]?.profiles).toHaveLength(1);
    expect(parsedProfile).toMatchObject({
      profileId: "managed-1",
      enabled: false,
      readability: {
        kind: "unreadable",
        reason: "Profile row uses an unsupported or invalid shape",
      },
    });
  });

  it("strips identity facts through the frozen 10.8 response schema", () => {
    const frozen108 = providersList.versions[8].contract.responseSchema;
    const parsed = frozen108.parse({
      providers: [
        {
          ...provider,
          profiles: [
            {
              ...currentManagedProfile,
              credentialHome: {
                ...currentManagedProfile.credentialHome,
                environmentPresence: {
                  scope: "environment",
                  environmentId: "synthetic-environment",
                  state: "absent",
                  retainedReason: "foreign-entry",
                  cause: null,
                },
              },
              presence: {
                kind: "revoking",
                cause: "host-left-environment",
              },
            },
          ],
        },
      ],
    });
    const parsedProfile = parsed.providers[0]?.profiles[0];

    expect(parsedProfile).toBeDefined();
    expect(parsedProfile).not.toHaveProperty("recordVersion");
    expect(parsedProfile).not.toHaveProperty("credentialIdentity");
    expect(parsedProfile).not.toHaveProperty("credentialHome");
    expect(parsedProfile).not.toHaveProperty("presence");
  });

  it("carries optional usage reporting in 10.9 and strips it for 10.8", () => {
    expect(providersList.latestMinor).toBe(10);
    const usageReporting = { ...provider, usageReporting: true };
    const carried = providersListResponseSchema.parse({
      providers: [usageReporting],
    });
    expect(carried.providers[0]).toHaveProperty("usageReporting", true);

    // And on the LIVE line, not only the frozen 10.9 one: every other check
    // here reads a frozen row, so dropping the field from the live row would
    // otherwise pass this suite.
    const live = providersList.versions[10].contract.responseSchema;
    const onLive = live.parse({ providers: [usageReporting] });
    expect(onLive.providers[0]).toHaveProperty("usageReporting", true);

    const frozen108 = providersList.versions[8].contract.responseSchema;
    const downgraded = frozen108.parse({ providers: [usageReporting] });
    expect(downgraded.providers[0]).not.toHaveProperty("usageReporting");

    const olderHost = providersListResponseSchema.parse({
      providers: [provider],
    });
    expect(olderHost.providers[0]).not.toHaveProperty("usageReporting");
  });
});
