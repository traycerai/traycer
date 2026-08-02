import { describe, expect, it } from "vitest";
import {
  downgradeRequestAcrossMajors,
  splitConnectionManifest,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import {
  agentConfigureRequestSchema,
  agentConfigureRequestSchemaV20,
  agentConfigureResponseSchema,
  agentConfigureDowngradeV20ToV10,
  agentConfigureDowngradeV30ToV10,
  agentConfigureDowngradeV30ToV20,
  agentConfigureUpgradeV10ToV20,
  agentCreateDowngradeV20ToV10,
  agentCreateUpgradeV10ToV20,
  agentCreateUpgradeV20ToV30,
  agentGetProviderProfileRateLimitsDowngradeV20ToV10,
  agentGetProviderProfileRateLimitsDowngradeV30ToV10,
  agentGetProviderProfileRateLimitsDowngradeV30ToV20,
  agentGetProviderProfileRateLimitsRequestSchema,
  agentGetProviderProfileRateLimitsResponseSchema,
  agentGetProviderProfileRateLimitsUpgradeV10ToV20,
  agentListProviderProfilesDowngradeV20ToV10,
  agentListProviderProfilesDowngradeV30ToV10,
  agentListProviderProfilesDowngradeV30ToV20,
  agentListProviderProfilesRequestSchema,
  agentListProviderProfilesResponseSchema,
  agentListProviderProfilesUpgradeV10ToV20,
  agentProviderProfileSummarySchema,
  AMBIENT_PROFILE_ID_SENTINEL,
  concreteProfileSelectionSchema,
  createAgentRequestSchemaV20,
  createAgentRequestSchemaV30,
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

  it("rejects the reserved ambient sentinel as a managed profileId, but keeps normal ids and the explicit ambient arm valid", () => {
    // The contradictory shape a direct RPC caller could otherwise construct:
    // a "profile" arm naming the "ambient" sentinel instead of using the
    // dedicated { kind: "ambient" } arm (batch-2 review finding).
    expect(
      profileSelectionSchema.safeParse({
        kind: "profile",
        profileId: AMBIENT_PROFILE_ID_SENTINEL,
      }).success,
    ).toBe(false);
    // Explicit ambient is unaffected - it never carries a profileId.
    expect(profileSelectionSchema.safeParse({ kind: "ambient" }).success).toBe(
      true,
    );
    // A normal managed id, including one that merely contains "ambient" as a
    // substring, still parses - only an exact sentinel match is rejected.
    expect(
      profileSelectionSchema.safeParse({
        kind: "profile",
        profileId: "ambient-work-account",
      }).success,
    ).toBe(true);
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

  it("ConcreteProfileSelection also rejects the reserved ambient sentinel as a managed profileId", () => {
    expect(
      concreteProfileSelectionSchema.safeParse({
        kind: "profile",
        profileId: AMBIENT_PROFILE_ID_SENTINEL,
      }).success,
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

const baseV2Request = {
  ...baseV1Request,
  profileSelection: { kind: "profile" as const, profileId: "profile-1" },
};

const baseV3Request = {
  ...baseV2Request,
  permissionMode: "full_access" as const,
};

describe("agent.create v1 <-> v2 profile-selection translation", () => {
  it("upgrades a v1.0 null profileId to inherit_sender", () => {
    const upgraded = agentCreateUpgradeV10ToV20.upgradeRequest({
      ...baseV1Request,
      profileId: null,
    });
    expect(upgraded.profileSelection).toEqual({ kind: "inherit_sender" });
    expect(upgraded).not.toHaveProperty("permissionMode");
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

  it("never silently downgrades ambient - it fails with actionable upgrade guidance, never profileId: null", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV2Request,
      profileSelection: { kind: "ambient" },
    });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(downgraded.error.message.length).toBeGreaterThan(0);
    // The message must never suggest ambient is usable against an old host.
    expect(downgraded.error.message).not.toMatch(/or ambient/i);
  });

  it("preserves the released v2 -> v1 managed-profile downgrade", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV2Request,
      profileSelection: { kind: "profile", profileId: "profile-1" },
    });
    expect(downgraded).toEqual({
      ok: true,
      value: { ...baseV1Request, profileId: "profile-1" },
    });
  });

  it("preserves the released v2 -> v1 sender-inheritance downgrade", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV2Request,
      profileSelection: { kind: "inherit_sender" },
    });
    expect(downgraded).toEqual({
      ok: true,
      value: { ...baseV1Request, profileId: null },
    });
  });

  it("never silently downgrades last_used - it fails with actionable upgrade guidance", () => {
    const downgraded = agentCreateDowngradeV20ToV10.downgradeRequest({
      ...baseV2Request,
      profileSelection: { kind: "last_used" },
    });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    expect(downgraded.error.message.length).toBeGreaterThan(0);
    // The message must never suggest ambient is usable against an old host.
    expect(downgraded.error.message).not.toMatch(/or ambient/i);
  });

  it("upgrades released requests through v3 with compatibility-only permission inheritance", () => {
    const upgraded = upgradeRequestToVersion(
      hostRpcRegistry["agent.create"],
      { major: 1, minor: 0 },
      { major: 3, minor: 0 },
      { ...baseV1Request, profileId: "profile-1" },
    );
    expect(upgraded.profileSelection).toEqual({
      kind: "profile",
      profileId: "profile-1",
    });
    expect(upgraded.permissionMode).toBeNull();

    expect(
      agentCreateUpgradeV20ToV30.upgradeRequest(baseV2Request).permissionMode,
    ).toBeNull();
  });

  it("rejects v3 permission-mode downgrades to both released majors", () => {
    const toV2 = downgradeRequestAcrossMajors(
      hostRpcRegistry["agent.create"],
      3,
      2,
      baseV3Request,
    );
    expect(toV2).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
    const toV1 = downgradeRequestAcrossMajors(
      hostRpcRegistry["agent.create"],
      3,
      1,
      baseV3Request,
    );
    expect(toV1).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });
    if (!toV2.ok) expect(toV2.error.message).toContain("Upgrade the host");
    if (!toV1.ok) expect(toV1.error.message).toContain("Upgrade the host");
  });

  it("keeps v2 frozen and requires permissionMode on v3", () => {
    const parsedV2 = createAgentRequestSchemaV20.parse(baseV2Request);
    expect(parsedV2).not.toHaveProperty("permissionMode");
    expect(createAgentRequestSchemaV30.safeParse(baseV2Request).success).toBe(
      false,
    );
    expect(
      createAgentRequestSchemaV30.parse(baseV3Request).permissionMode,
    ).toBe("full_access");
    // The frozen v1.0 shape carries `profileId`, not `profileSelection` - a
    // v2.0-shaped payload must not silently satisfy the v1.0 schema too.
    expect(
      createAgentRequestSchemaV20.safeParse({
        ...baseV1Request,
        profileId: null,
      }).success,
    ).toBe(false);
  });

  it("rejects the ambient sentinel as agent.create@2.0's managed profileId, even reconstructed through the v1->v2 upgrade bridge", () => {
    // The registry-level schema is the actual enforcement boundary: the
    // upgrade bridge itself is a plain mapping function (batch-1's frozen
    // v1.0 wire has no way to express the distinction), so a legacy v1
    // caller that happened to persist the literal string "ambient" as a
    // profile id upgrades into the contradictory shape - the v2.0 request
    // schema is what must reject it once parsed at the RPC boundary.
    const upgraded = agentCreateUpgradeV10ToV20.upgradeRequest({
      ...baseV1Request,
      profileId: AMBIENT_PROFILE_ID_SENTINEL,
    });
    expect(upgraded.profileSelection).toEqual({
      kind: "profile",
      profileId: AMBIENT_PROFILE_ID_SENTINEL,
    });
    expect(createAgentRequestSchemaV20.safeParse(upgraded).success).toBe(false);

    // Directly constructed v2.0 requests are rejected the same way.
    expect(
      createAgentRequestSchemaV20.safeParse({
        ...baseV1Request,
        profileSelection: {
          kind: "profile",
          profileId: AMBIENT_PROFILE_ID_SENTINEL,
        },
      }).success,
    ).toBe(false);
  });
});

describe("agent.listProviderProfiles / agent.getProviderProfileRateLimits / agent.configure schemas", () => {
  it("accepts a full profile summary row and strips nothing agent-safe", () => {
    const summary = agentProviderProfileSummarySchema.parse({
      selection: { kind: "profile", profileId: "profile-1" },
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

  it("has no independent kind field that could disagree with the selection - a contradictory kind is never trusted", () => {
    // `selection.kind` is the sole ambient-vs-managed discriminant; there is
    // no separate `kind` property left on the schema for a caller to set
    // inconsistently (batch-1 review correction).
    expect(agentProviderProfileSummarySchema.shape).not.toHaveProperty("kind");

    const summary = agentProviderProfileSummarySchema.parse({
      selection: { kind: "ambient" },
      // A stale/contradictory extra key a pre-amendment caller might still
      // send - non-strict `z.object` drops it, so it can never surface as a
      // disagreeing `kind`.
      kind: "managed",
      label: "Terminal account",
      authStatus: "authenticated",
      rateLimitStatus: "unknown",
      usageUpdatedAt: null,
      isEffectiveLastUsed: false,
    });
    expect(summary).not.toHaveProperty("kind");
    expect(summary.selection).toEqual({ kind: "ambient" });
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
            label: "Terminal account",
            authStatus: "authenticated",
            rateLimitStatus: "unknown",
            usageUpdatedAt: null,
            isEffectiveLastUsed: false,
          },
        ],
      }),
    ).toMatchObject({
      providerId: "codex",
      profiles: [{ selection: { kind: "ambient" } }],
    });
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

  it("rejects the ambient sentinel as a managed profileId on agent.getProviderProfileRateLimits and agent.configure requests", () => {
    expect(
      agentGetProviderProfileRateLimitsRequestSchema.safeParse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        harnessId: "codex",
        profileSelection: {
          kind: "profile",
          profileId: AMBIENT_PROFILE_ID_SENTINEL,
        },
      }).success,
    ).toBe(false);

    expect(
      agentConfigureRequestSchemaV20.safeParse({
        epicId: "epic-1",
        senderAgentId: "agent-1",
        agentId: "agent-2",
        harnessId: "claude",
        model: "opus-4.7",
        profileSelection: {
          kind: "profile",
          profileId: AMBIENT_PROFILE_ID_SENTINEL,
        },
        reasoningEffort: "high",
        fastMode: false,
        permissionMode: "full_access",
      }).success,
    ).toBe(false);
  });

  it("accepts an unavailable rate-limit result", () => {
    expect(
      agentGetProviderProfileRateLimitsResponseSchema.parse({
        rateLimits: {
          provider: "codex",
          available: false,
          reason: "timeout",
        },
        usageUpdatedAt: null,
      }),
    ).toMatchObject({ rateLimits: { provider: "codex" } });
  });

  it("has no independent providerId field that could disagree with rateLimits.provider", () => {
    // The provider identity lives solely on `rateLimits.provider` (every arm,
    // including `available: false`, carries it); there is no outer field for
    // a caller to set inconsistently (batch-1 review correction).
    expect(
      agentGetProviderProfileRateLimitsResponseSchema.shape,
    ).not.toHaveProperty("providerId");

    const response = agentGetProviderProfileRateLimitsResponseSchema.parse({
      // A stale/contradictory outer field a pre-amendment caller might still
      // send - non-strict `z.object` drops it, so it can never surface as a
      // disagreeing provider identity.
      providerId: "claude-code",
      rateLimits: { provider: "codex", available: false, reason: "timeout" },
      usageUpdatedAt: null,
    });
    expect(response).not.toHaveProperty("providerId");
    expect(response.rateLimits.provider).toBe("codex");
  });

  it("accepts the agent.configure request/response shapes", () => {
    const legacyRequest = agentConfigureRequestSchema.parse({
      epicId: "epic-1",
      senderAgentId: "agent-1",
      agentId: "agent-2",
      harnessId: "claude",
      model: "opus-4.7",
      profileSelection: { kind: "profile", profileId: "profile-1" },
      reasoningEffort: "high",
      fastMode: false,
    });
    expect(legacyRequest).not.toHaveProperty("permissionMode");

    const request = agentConfigureRequestSchemaV20.parse({
      ...legacyRequest,
      permissionMode: "full_access",
    });
    expect(request).toMatchObject({
      agentId: "agent-2",
      harnessId: "claude",
      permissionMode: "full_access",
    });
    expect(
      agentConfigureRequestSchemaV20.parse({
        ...request,
        permissionMode: "supervised",
      }).permissionMode,
    ).toBe("supervised");
    expect(
      agentConfigureRequestSchemaV20.safeParse(legacyRequest).success,
    ).toBe(false);

    const upgraded =
      agentConfigureUpgradeV10ToV20.upgradeRequest(legacyRequest);
    expect(upgraded.permissionMode).toBeNull();
    const downgraded =
      agentConfigureDowngradeV20ToV10.downgradeRequest(request);
    expect(downgraded).toMatchObject({
      ok: false,
      error: { code: "DOWNGRADE_UNSUPPORTED" },
    });

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

    expect(
      agentConfigureResponseSchema.safeParse({
        settings: {
          harnessId: "claude",
          model: "",
          profileSelection: { kind: "ambient" },
          reasoningEffort: null,
          fastMode: false,
          permissionMode: "supervised",
          agentMode: "regular",
        },
        warnings: [],
      }).success,
    ).toBe(false);
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
    // v3.0 is the advertised latest: the v1.1.8 tags froze v2.0 with the
    // pre-omp id sets, so omp opened a new major on all three methods.
    expect(split.optionalManifest["agent.listProviderProfiles"]).toEqual({
      major: 3,
      minor: 0,
    });
    expect(
      split.optionalManifest["agent.getProviderProfileRateLimits"],
    ).toEqual({ major: 3, minor: 0 });
    expect(split.optionalManifest["agent.configure"]).toEqual({
      major: 3,
      minor: 0,
    });
  });

  it("keeps released agent.create majors frozen and advertises v3.0", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toContain("agent.create");
    expect(
      hostRpcRegistry["agent.create"][1].versions[0].contract.schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.create"][2].versions[0].contract.schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["agent.create"][3].versions[0].contract.schemaVersion,
    ).toEqual({ major: 3, minor: 0 });
    expect(
      hostRpcRegistry["agent.configure"][1].versions[0].contract.schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.configure"][2].versions[0].contract.schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["agent.configure"][3].versions[0].contract.schemaVersion,
    ).toEqual({ major: 3, minor: 0 });
  });

  it("keeps every released profile-method major frozen and advertises the omp-inclusive v3.0 line", () => {
    expect(
      hostRpcRegistry["agent.listProviderProfiles"][1].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.listProviderProfiles"][2].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    expect(
      hostRpcRegistry["agent.getProviderProfileRateLimits"][1].versions[0]
        .contract.schemaVersion,
    ).toEqual({ major: 1, minor: 0 });
    expect(
      hostRpcRegistry["agent.getProviderProfileRateLimits"][2].versions[0]
        .contract.schemaVersion,
    ).toEqual({ major: 2, minor: 0 });
    // The omp-inclusive lines: v2.0 above is frozen pre-omp, v3.0 carries it.
    expect(
      hostRpcRegistry["agent.listProviderProfiles"][3].versions[0].contract
        .schemaVersion,
    ).toEqual({ major: 3, minor: 0 });
    expect(
      hostRpcRegistry["agent.getProviderProfileRateLimits"][3].versions[0]
        .contract.schemaVersion,
    ).toEqual({ major: 3, minor: 0 });
  });
});

describe("agent.listProviderProfiles v1 <-> v2 hermes-provider translation", () => {
  const preHermesResponse = {
    providerId: "codex" as const,
    profiles: [
      {
        selection: { kind: "ambient" as const },
        label: "Terminal account",
        authStatus: "authenticated" as const,
        rateLimitStatus: "unknown" as const,
        usageUpdatedAt: null,
        isEffectiveLastUsed: false,
      },
    ],
  };

  it("upgrades a frozen v1.0 response to v2.0 as a pure pass-through", () => {
    expect(
      agentListProviderProfilesUpgradeV10ToV20.upgradeResponse(
        preHermesResponse,
      ),
    ).toEqual(preHermesResponse);
  });

  it("downgrades a pre-hermes v2.0 response to v1.0 as a pure pass-through", () => {
    const downgraded =
      agentListProviderProfilesDowngradeV20ToV10.downgradeResponse(
        preHermesResponse,
      );
    expect(downgraded).toEqual({ ok: true, value: preHermesResponse });
  });

  it("fails closed (never silently mis-decodes) downgrading a hermes response to v1.0", () => {
    const downgraded =
      agentListProviderProfilesDowngradeV20ToV10.downgradeResponse({
        ...preHermesResponse,
        providerId: "hermes",
      });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    // The message deliberately names no single provider - it must stay honest
    // for every post-v4.0 id, not just the first one that forced the bridge.
    expect(downgraded.error.message).toMatch(/newer Traycer client/i);
  });

  // omp lives only on v3.0: the v1.1.8 tags froze v2.0 with the 17-id enum, so
  // an omp response cannot even be constructed at v2.0 any more - the bridges
  // under test start at v3.0.
  it("downgrades a pre-omp v3.0 response to v2.0 as a pure pass-through", () => {
    const downgraded =
      agentListProviderProfilesDowngradeV30ToV20.downgradeResponse(
        preHermesResponse,
      );
    expect(downgraded).toEqual({ ok: true, value: preHermesResponse });
  });

  it("passes a hermes response through the v3->v2 downgrade (v2.0 shipped with hermes)", () => {
    const response = { ...preHermesResponse, providerId: "hermes" as const };
    const downgraded =
      agentListProviderProfilesDowngradeV30ToV20.downgradeResponse(response);
    expect(downgraded).toEqual({ ok: true, value: response });
  });

  it("fails closed downgrading an omp response to v2.0", () => {
    const downgraded =
      agentListProviderProfilesDowngradeV30ToV20.downgradeResponse({
        ...preHermesResponse,
        providerId: "omp",
      });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });

  it("fails closed downgrading an omp response all the way to v1.0", () => {
    const downgraded =
      agentListProviderProfilesDowngradeV30ToV10.downgradeResponse({
        ...preHermesResponse,
        providerId: "omp",
      });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });
});

describe("agent.getProviderProfileRateLimits v1 <-> v2 hermes-provider translation", () => {
  const preHermesResponse = {
    rateLimits: {
      provider: "codex" as const,
      available: false as const,
      reason: "timeout" as const,
    },
    usageUpdatedAt: null,
  };

  it("upgrades a frozen v1.0 response to v2.0 as a pure pass-through", () => {
    expect(
      agentGetProviderProfileRateLimitsUpgradeV10ToV20.upgradeResponse(
        preHermesResponse,
      ),
    ).toEqual(preHermesResponse);
  });

  it("downgrades a pre-hermes v2.0 response to v1.0 as a pure pass-through", () => {
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV20ToV10.downgradeResponse(
        preHermesResponse,
      );
    expect(downgraded).toEqual({ ok: true, value: preHermesResponse });
  });

  it("fails closed (never silently mis-decodes) downgrading a hermes rate-limit read to v1.0", () => {
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV20ToV10.downgradeResponse({
        rateLimits: {
          provider: "hermes",
          available: false,
          reason: "timeout",
        },
        usageUpdatedAt: null,
      });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    // The message was generalized when grok joined the bridge: an
    // unrepresentable provider (Hermes here) no longer names itself, since the
    // bridge now pre-maps grok-available to the unavailable shape rather than
    // failing closed on it.
    expect(downgraded.error.message).toMatch(/newer Traycer client/i);
  });

  it("degrades a grok-available rate-limit read to unsupported_provider (never errors)", () => {
    // Grok is in the frozen provider enum (it predates Hermes), so a
    // grok-available snapshot degrades to the unavailable shape a v1.0 host
    // returns for grok today - credit/period fields must be gone after reparse.
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV20ToV10.downgradeResponse({
        rateLimits: {
          provider: "grok",
          available: true,
          subscriptionTier: "SuperGrok",
          periodType: "USAGE_PERIOD_TYPE_WEEKLY",
          periodStart: 1753142400000,
          periodEnd: 1753747200000,
          period: {
            usedPercent: 12,
            resetsAt: 1753747200000,
            durationMinutes: 10080,
          },
          monthlyLimit: null,
          onDemandCap: 0,
          onDemandUsed: 0,
          prepaidBalance: 0,
        },
        usageUpdatedAt: 1753142400000,
      });
    expect(downgraded).toEqual({
      ok: true,
      value: {
        rateLimits: {
          provider: "grok",
          available: false,
          reason: "unsupported_provider",
        },
        usageUpdatedAt: 1753142400000,
      },
    });
  });

  it("degrades a period-less grok-available rate-limit read to unsupported_provider", () => {
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV20ToV10.downgradeResponse({
        rateLimits: {
          provider: "grok",
          available: true,
          subscriptionTier: "SuperGrok",
          periodType: "USAGE_PERIOD_TYPE_WEEKLY",
          periodStart: 1753142400000,
          periodEnd: 1753747200000,
          period: null,
          monthlyLimit: null,
          onDemandCap: null,
          onDemandUsed: null,
          prepaidBalance: null,
        },
        usageUpdatedAt: null,
      });
    expect(downgraded).toEqual({
      ok: true,
      value: {
        rateLimits: {
          provider: "grok",
          available: false,
          reason: "unsupported_provider",
        },
        usageUpdatedAt: null,
      },
    });
  });

  it("keeps a grok-available read intact on the v3->v2 downgrade", () => {
    // Unlike v1.0, the frozen v2.0 union carries the grok available arm (grok
    // rate limits predate the v1.1.8 tags), so this bridge must NOT degrade it.
    const rateLimits = {
      provider: "grok" as const,
      available: true as const,
      subscriptionTier: "SuperGrok",
      periodType: "USAGE_PERIOD_TYPE_WEEKLY" as const,
      periodStart: 1753142400000,
      periodEnd: 1753747200000,
      period: {
        usedPercent: 12,
        resetsAt: 1753747200000,
        durationMinutes: 10080,
      },
      monthlyLimit: null,
      onDemandCap: 0,
      onDemandUsed: 0,
      prepaidBalance: 0,
    };
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV30ToV20.downgradeResponse({
        rateLimits,
        usageUpdatedAt: 1753142400000,
      });
    expect(downgraded).toEqual({
      ok: true,
      value: { rateLimits, usageUpdatedAt: 1753142400000 },
    });
  });

  it("passes a hermes rate-limit read through the v3->v2 downgrade", () => {
    const response = {
      rateLimits: {
        provider: "hermes" as const,
        available: false as const,
        reason: "timeout" as const,
      },
      usageUpdatedAt: null,
    };
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV30ToV20.downgradeResponse(
        response,
      );
    expect(downgraded).toEqual({ ok: true, value: response });
  });

  it("fails closed downgrading an omp rate-limit read to v2.0", () => {
    const downgraded =
      agentGetProviderProfileRateLimitsDowngradeV30ToV20.downgradeResponse({
        rateLimits: { provider: "omp", available: false, reason: "timeout" },
        usageUpdatedAt: null,
      });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });

  it("still degrades grok but fails closed on omp across the v3->v1 bridge", () => {
    const grokDowngraded =
      agentGetProviderProfileRateLimitsDowngradeV30ToV10.downgradeResponse({
        rateLimits: {
          provider: "grok",
          available: true,
          subscriptionTier: "SuperGrok",
          periodType: "USAGE_PERIOD_TYPE_WEEKLY",
          periodStart: 1753142400000,
          periodEnd: 1753747200000,
          period: null,
          monthlyLimit: null,
          onDemandCap: null,
          onDemandUsed: null,
          prepaidBalance: null,
        },
        usageUpdatedAt: null,
      });
    expect(grokDowngraded).toEqual({
      ok: true,
      value: {
        rateLimits: {
          provider: "grok",
          available: false,
          reason: "unsupported_provider",
        },
        usageUpdatedAt: null,
      },
    });

    const ompDowngraded =
      agentGetProviderProfileRateLimitsDowngradeV30ToV10.downgradeResponse({
        rateLimits: { provider: "omp", available: false, reason: "timeout" },
        usageUpdatedAt: null,
      });
    expect(ompDowngraded.ok).toBe(false);
  });
});

describe("agent.configure v1 <-> v2 hermes-harness response translation", () => {
  const preHermesSettings = {
    harnessId: "claude" as const,
    model: "opus-4.7",
    profileSelection: { kind: "ambient" as const },
    reasoningEffort: null,
    fastMode: false,
    permissionMode: "supervised" as const,
    agentMode: "regular" as const,
  };

  it("passes a pre-hermes configure response through the v2->v1 downgrade unchanged", () => {
    const response = { settings: preHermesSettings, warnings: [] };
    const downgraded =
      agentConfigureDowngradeV20ToV10.downgradeResponse(response);
    expect(downgraded).toEqual({ ok: true, value: response });
  });

  it("fails closed (never silently mis-decodes) downgrading a hermes-configured response to v1.0", () => {
    const response = {
      settings: { ...preHermesSettings, harnessId: "hermes" as const },
      warnings: [],
    };
    const downgraded =
      agentConfigureDowngradeV20ToV10.downgradeResponse(response);
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
    // Generalized alongside the listProviderProfiles bridge: the copy must not
    // name Hermes now that omp shares the same fail-closed path.
    expect(downgraded.error.message).toMatch(/newer Traycer client/i);
  });

  // As with listProviderProfiles, omp only exists on v3.0 now.
  it("passes a hermes-configured response through the v3->v2 downgrade (v2.0 shipped with hermes)", () => {
    const response = {
      settings: { ...preHermesSettings, harnessId: "hermes" as const },
      warnings: [],
    };
    const downgraded =
      agentConfigureDowngradeV30ToV20.downgradeResponse(response);
    expect(downgraded).toEqual({ ok: true, value: response });
  });

  it("fails closed downgrading an omp-configured response to v2.0", () => {
    const response = {
      settings: { ...preHermesSettings, harnessId: "omp" as const },
      warnings: [],
    };
    const downgraded =
      agentConfigureDowngradeV30ToV20.downgradeResponse(response);
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });

  it("fails closed downgrading an omp-configured response all the way to v1.0", () => {
    const response = {
      settings: { ...preHermesSettings, harnessId: "omp" as const },
      warnings: [],
    };
    const downgraded =
      agentConfigureDowngradeV30ToV10.downgradeResponse(response);
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });

  it("refuses the v3->v1 request downgrade, like the v2->v1 bridge", () => {
    // v1.0 has no `permissionMode`, so an explicit choice cannot be carried to
    // a v1.0 host regardless of which newer major the caller negotiated.
    const downgraded = agentConfigureDowngradeV30ToV10.downgradeRequest({
      epicId: "e",
      senderAgentId: "s",
      agentId: "a",
      harnessId: "claude",
      model: "opus-4.7",
      profileSelection: { kind: "ambient" },
      reasoningEffort: null,
      fastMode: false,
      permissionMode: "supervised",
    });
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) return;
    expect(downgraded.error.code).toBe("DOWNGRADE_UNSUPPORTED");
  });
});

describe("Epic Mode removal — agentMode is RETAINED on the released wires", () => {
  const LIVE_RESPONSE = {
    settings: {
      harnessId: "claude" as const,
      model: "opus-4.7",
      profileSelection: { kind: "profile" as const, profileId: "profile-1" },
      reasoningEffort: "high",
      fastMode: false,
      permissionMode: "supervised" as const,
      agentMode: "regular" as const,
    },
    warnings: [],
  };

  // `agent.configure` v3.0 is RELEASED: its baseline surface requires
  // `settings.agentMode` on the response, so a payload built from this tree
  // that omitted it would be rejected outright by an already-shipped peer.
  // Epic Mode is gone from the PRODUCT, but the key stays on the wire until
  // the released floor passes this version. The host states the one
  // remaining mode rather than dropping the field.
  it("keeps agentMode required on the live configure response", () => {
    expect(
      agentConfigureResponseSchema.safeParse({
        ...LIVE_RESPONSE,
        settings: Object.fromEntries(
          Object.entries(LIVE_RESPONSE.settings).filter(
            ([key]) => key !== "agentMode",
          ),
        ),
      }).success,
    ).toBe(false);

    const parsed = agentConfigureResponseSchema.parse(LIVE_RESPONSE);
    expect(parsed.settings.agentMode).toBe("regular");
  });

  // The field is present on every version in the chain, so no bridge has to
  // synthesize it - each simply passes through what its input carried. A
  // legacy "epic" value must survive rather than be normalized away: these
  // bridges translate an existing wire payload, they do not mint new records.
  it.each([
    ["v3.0 -> v2.0", agentConfigureDowngradeV30ToV20],
    ["v3.0 -> v1.0", agentConfigureDowngradeV30ToV10],
    ["v2.0 -> v1.0", agentConfigureDowngradeV20ToV10],
  ])("passes agentMode through unchanged on the frozen %s response", (_label, bridge) => {
    const result = bridge.downgradeResponse({
      ...LIVE_RESPONSE,
      settings: { ...LIVE_RESPONSE.settings, agentMode: "epic" as const },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.settings.agentMode).toBe("epic");
  });

  // v3.0 is itself released (v1.1.8), so a current client and a v1.1.8 host
  // both negotiate 3.0 with NO bridge between them. The key must survive the
  // upgrade or that host rejects the request outright.
  it("keeps agentMode on the released v3.0 create request", () => {
    const upgraded = agentCreateUpgradeV20ToV30.upgradeRequest(
      createAgentRequestSchemaV20.parse({
        senderAgentId: "agent-1",
        epicId: "epic-1",
        name: null,
        surface: "gui",
        harnessId: "claude",
        model: null,
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        workspace: null,
        profileSelection: { kind: "ambient" },
      }),
    );

    expect(createAgentRequestSchemaV30.safeParse(upgraded).success).toBe(true);
    expect(upgraded.agentMode).toBe("regular");
    expect(upgraded.permissionMode).toBeNull();
  });
});
