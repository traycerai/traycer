import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";

const providersList = hostRpcRegistry["providers.list"][10];

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
    {
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
    },
    {
      ...profile,
      profileId: "future-row",
      label: "Future",
      recordVersion: 2,
      futureField: { retainedByHost: true },
    },
  ],
};

describe("providers.list@10.9 profile identity projection", () => {
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

  it("strips identity facts through the frozen 10.8 response schema", () => {
    const frozen108 = providersList.versions[8].contract.responseSchema;
    const parsed = frozen108.parse({ providers: [provider] });
    const parsedProfile = parsed.providers[0]?.profiles[0];

    expect(parsedProfile).toBeDefined();
    expect(parsedProfile).not.toHaveProperty("recordVersion");
    expect(parsedProfile).not.toHaveProperty("credentialIdentity");
    expect(parsedProfile).not.toHaveProperty("credentialHome");
  });
});
