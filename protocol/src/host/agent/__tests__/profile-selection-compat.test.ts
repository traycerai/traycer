import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  splitConnectionManifest,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import {
  agentConfigureRequestSchema,
  agentConfigureResponseSchema,
  agentCreateDowngradeV20ToV10,
  agentCreateUpgradeV10ToV20,
  agentGetProviderProfileRateLimitsRequestSchema,
  agentGetProviderProfileRateLimitsResponseSchema,
  agentListProviderProfilesRequestSchema,
  agentListProviderProfilesResponseSchema,
  agentProviderProfileSummarySchema,
  concreteProfileSelectionSchema,
  createAgentRequestSchemaV20,
  hostRpcRegistry,
  profileSelectionSchema,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

describe("ProfileSelection / ConcreteProfileSelection schemas", () => {
  it("accepts every ProfileSelection arm", () => {
    expect(
      profileSelectionSchema.safeParse({ kind: "last_used" }).success,
    ).toBe(true);
    expect(profileSelectionSchema.safeParse({ kind: "ambient" }).success).toBe(
      true,
    );
    expect(
      profileSelectionSchema.safeParse({
        kind: "profile",
        profileId: "profile-1",
      }).success,
    ).toBe(true);
    expect(
      profileSelectionSchema.safeParse({ kind: "inherit_sender" }).success,
    ).toBe(true);
  });

  it("rejects a profile selection missing profileId", () => {
    expect(profileSelectionSchema.safeParse({ kind: "profile" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown selection kind", () => {
    expect(
      profileSelectionSchema.safeParse({ kind: "everything" }).success,
    ).toBe(false);
  });

  it("ConcreteProfileSelection accepts only ambient/profile, never last_used or inherit_sender", () => {
    expect(
      concreteProfileSelectionSchema.safeParse({ kind: "ambient" }).success,
    ).toBe(true);
    expect(
      concreteProfileSelectionSchema.safeParse({
        kind: "profile",
        profileId: "profile-1",
      }).success,
    ).toBe(true);
    expect(
      concreteProfileSelectionSchema.safeParse({ kind: "last_used" }).success,
    ).toBe(false);
    expect(
      concreteProfileSelectionSchema.safeParse({ kind: "inherit_sender" })
        .success,
    ).toBe(false);
  });
});

const baseV1Request = {
  senderAgentId: "agent-1",
  epicId: "epic-1",
  name: null,
  surface: "gui" as const,
  harnessId: "codex" as const,
  model: "gpt-5.4",
  agentMode: null,
  reasoningEffort: null,
  fastMode: null,
  workspace: null,
};

describe("agent.create v1 <-> v2 profile-selection translation", () => {
  it("upgrades a v1.0 null profileId to inherit_sender", () => {
    const upgraded = agentCreateUpgradeV10ToV20.upgradeRequest({
      ...baseV1Request,
      profileId: null,
    });
    expect(upgraded.profileSelection).toEqual({ kind: "inherit_sender" });
  });

  it("upgrades a v1.0 profile id string to an explicit managed selection", () => {
    const upgraded = agentCreateUpgradeV10ToV20.upgradeRequest({
      ...baseV1Request,
      profileId: "profile-1",
    });
    expect(upgraded.profileSelection).toEqual({
      kind: "profile",
      profileId: "profile-1",
    });
  });

  it("downgrades a v2.0 ambient selection to profileId: null", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV1Request,
      profileSelection: { kind: "ambient" },
    });
    expect(downgraded).toMatchObject({
      ok: true,
      value: { profileId: null },
    });
  });

  it("downgrades a v2.0 managed selection to the profile id string", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV1Request,
      profileSelection: { kind: "profile", profileId: "profile-1" },
    });
    expect(downgraded).toMatchObject({
      ok: true,
      value: { profileId: "profile-1" },
    });
  });

  it("downgrades a v2.0 compatibility-only inherit_sender selection to profileId: null", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV1Request,
      profileSelection: { kind: "inherit_sender" },
    });
    expect(downgraded).toMatchObject({
      ok: true,
      value: { profileId: null },
    });
  });

  it("never silently downgrades last_used - it fails with actionable upgrade guidance", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV1Request,
      profileSelection: { kind: "last_used" },
    });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(downgraded.error.message.length).toBeGreaterThan(0);
  });

  it("round-trips through the host registry (major 1 -> major 2 -> major 1)", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["agent.create"],
      { major: 1, minor: 0 },
      { major: 2, minor: 0 },
      { ...baseV1Request, profileId: "profile-1" },
    );
    expect(upgraded.profileSelection).toEqual({
      kind: "profile",
      profileId: "profile-1",
    });

    const downgraded = downgradeRequestAcrossMajors(
      hostRpcRegistry["agent.create"],
      2,
      1,
      { ...baseV1Request, profileSelection: { kind: "ambient" } },
    );
    expect(downgraded).toMatchObject({ ok: true, value: { profileId: null } });

    const rejected = downgradeRequestAcrossMajors(
      hostRpcRegistry["agent.create"],
      2,
      1,
      { ...baseV1Request, profileSelection: { kind: "last_used" } },
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
  });

  it("accepts the v2.0 request shape directly", () => {
    expect(
      createAgentRequestSchemaV20.safeParse({
        ...baseV1Request,
        profileSelection: { kind: "last_used" },
      }).success,
    ).toBe(true);
    // The frozen v1.0 shape carries `profileId`, not `profileSelection` - a
    // v2.0-shaped payload must not silently satisfy the v1.0 schema too.
    expect(
      createAgentRequestSchemaV20.safeParse({
        ...baseV1Request,
        profileId: null,
      }).success,
    ).toBe(false);
  });
});

describe("agent.listProviderProfiles / agent.getProviderProfileRateLimits / agent.configure schemas", () => {
  it("accepts a full profile summary row and strips nothing agent-safe", () => {
    const summary = agentProviderProfileSummarySchema.parse({
      selection: { kind: "profile", profileId: "profile-1" },
      kind: "managed",
      label: "Work",
      authStatus: "authenticated",
      rateLimitStatus: "ok",
      usageUpdatedAt: 1735689600000,
      isEffectiveLastUsed: true,
    });
    expect(summary).toMatchObject({
      selection: { kind: "profile", profileId: "profile-1" },
      label: "Work",
    });
    // Guardrail: the agent-safe DTO never carries identity fields.
    expect(JSON.stringify(summary)).not.toContain("email");
    expect(JSON.stringify(summary)).not.toContain("accountUuid");
  });

  it("accepts the agent.listProviderProfiles request/response shapes", () => {
    expect(
      agentListProviderProfilesRequestSchema.parse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
      }),
    ).toEqual({
      epicId: "epic-1",
      senderAgentId: "agent-1",
      harnessId: "codex",
    });

    expect(
      agentListProviderProfilesResponseSchema.parse({
        providerId: "codex",
        profiles: [
          {
            selection: { kind: "ambient" },
            kind: "ambient",
            label: "Terminal account",
            authStatus: "authenticated",
            rateLimitStatus: "unknown",
            usageUpdatedAt: null,
            isEffectiveLastUsed: false,
          },
        ],
      }),
    ).toMatchObject({ providerId: "codex", profiles: [{ kind: "ambient" }] });
  });

  it("requires a concrete profile selection for agent.getProviderProfileRateLimits", () => {
    expect(
      agentGetProviderProfileRateLimitsRequestSchema.safeParse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
        profileSelection: { kind: "last_used" },
      }).success,
    ).toBe(false);

    expect(
      agentGetProviderProfileRateLimitsRequestSchema.parse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
        profileSelection: { kind: "ambient" },
      }),
    ).toMatchObject({ profileSelection: { kind: "ambient" } });
  });

  it("accepts an unavailable rate-limit result", () => {
    expect(
      agentGetProviderProfileRateLimitsResponseSchema.parse({
        providerId: "codex",
        rateLimits: {
          provider: "codex",
          available: false,
          reason: "timeout",
        },
        usageUpdatedAt: null,
      }),
    ).toMatchObject({ providerId: "codex" });
  });

  it("accepts the agent.configure request/response shapes", () => {
    expect(
      agentConfigureRequestSchema.parse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        agentId: "agent-2",
        harnessId: "claude",
        model: "opus-4.7",
        profileSelection: { kind: "profile", profileId: "profile-1" },
        reasoningEffort: "high",
        fastMode: false,
      }),
    ).toMatchObject({ agentId: "agent-2", harnessId: "claude" });

    expect(
      agentConfigureResponseSchema.parse({
        settings: {
          harnessId: "claude",
          model: "opus-4.7",
          profileSelection: { kind: "profile", profileId: "profile-1" },
          reasoningEffort: "high",
          fastMode: false,
          permissionMode: "supervised",
          agentMode: "regular",
        },
        warnings: [],
      }),
    ).toMatchObject({ warnings: [] });
  });
});

describe("optional-method capability negotiation", () => {
  it("keeps the three new profile methods off the released floor", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "agent.listProviderProfiles",
    );
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "agent.getProviderProfileRateLimits",
    );
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("agent.configure");
  });

  it("declares unsupported degradation for every new profile method", () => {
    expect(hostRpcRegistry["agent.listProviderProfiles"].degrade).toEqual({
      kind: "unsupported",
    });
    expect(
      hostRpcRegistry["agent.getProviderProfileRateLimits"].degrade,
    ).toEqual({ kind: "unsupported" });
    expect(hostRpcRegistry["agent.configure"].degrade).toEqual({
      kind: "unsupported",
    });
  });

  it("splits the three new methods into the optional manifest channel", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    expect(split.manifest["agent.listProviderProfiles"]).toBeUndefined();
    expect(
      split.manifest["agent.getProviderProfileRateLimits"],
    ).toBeUndefined();
    expect(split.manifest["agent.configure"]).toBeUndefined();
    expect(split.optionalManifest["agent.listProviderProfiles"]).toEqual({
      major: 1,
      minor: 0,
    });
    expect(
      split.optionalManifest["agent.getProviderProfileRateLimits"],
    ).toEqual({ major: 1, minor: 0 });
    expect(split.optionalManifest["agent.configure"]).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("keeps agent.create registered on the released floor at v1.0, with v2.0 as an additive major", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("agent.create");
    expect(
      hostRpcRegistry["agent.create"][1].versions[0].contract.schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.create"][2].versions[0].contract.schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
  });
});
