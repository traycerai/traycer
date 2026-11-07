import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";

const providersList = hostRpcRegistry["providers.list"][10];
const live109 = providersList.versions[9].contract.responseSchema;
const providersListResponseSchema = live109;

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

  it("strips identity facts through the frozen 10.8 response schema", () => {
    const frozen108 = providersList.versions[8].contract.responseSchema;
    const parsed = frozen108.parse({ providers: [provider] });
    const parsedProfile = parsed.providers[0]?.profiles[0];

    expect(parsedProfile).toBeDefined();
    expect(parsedProfile).not.toHaveProperty("recordVersion");
    expect(parsedProfile).not.toHaveProperty("credentialIdentity");
    expect(parsedProfile).not.toHaveProperty("credentialHome");
  });

  it("carries optional usage reporting in 10.9 and strips it for 10.8", () => {
    expect(providersList.latestMinor).toBe(9);
    const usageReporting = { ...provider, usageReporting: true };
    const live = live109.parse({
      providers: [usageReporting],
    });
    expect(live.providers[0]).toHaveProperty("usageReporting", true);

    const frozen108 = providersList.versions[8].contract.responseSchema;
    const downgraded = frozen108.parse({ providers: [usageReporting] });
    expect(downgraded.providers[0]).not.toHaveProperty("usageReporting");

    const olderHost = live109.parse({ providers: [provider] });
    expect(olderHost.providers[0]).not.toHaveProperty("usageReporting");
  });
});
