import { describe, expect, it } from "vitest";
import {
  findTierConflicts,
  modelMatchesPattern,
  providersFallbackPolicyGetUpgradeV10ToV11,
  providersFallbackPolicyGetV10,
  providersFallbackPolicyGetV11,
  providersFallbackPolicyPreviewTierGroupsRequestSchema,
  providersFallbackPolicyPreviewTierGroupsRequestSchemaV10,
  providersFallbackPolicyPreviewTierGroupsResponseSchema,
  providersFallbackPolicyPreviewTierGroupsResponseSchemaV10,
  providersFallbackPolicyPreviewTierGroupsUpgradeV10ToV11,
  providersFallbackPolicyPreviewTierGroupsV10,
  providersFallbackPolicyPreviewTierGroupsV11,
  providersFallbackPolicySetUpgradeV10ToV11,
  providersFallbackPolicySetV10,
  providersFallbackPolicySetV11,
  routeTierGroupForFailedTuple,
  tierPreviewBlockedTupleSchema,
  createDefaultFallbackPolicy,
  type TierCandidatePreviewV10,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  GROK_CATALOG,
  SEED_DEFAULT,
  SEED_GROUPS,
} from "./fallback-model-patterns-fixtures";

// Old behaviour that fails these: get/set/previewTierGroups topped out at
// 1.0 (`latestMinor: 0`), with no 1.1 contract and no upgrade path.
describe("registry lines and contract identity", () => {
  it("get, set and previewTierGroups are on latestMinor 1", () => {
    expect(hostRpcRegistry["providers.fallbackPolicy.get"][1].latestMinor).toBe(
      1,
    );
    expect(hostRpcRegistry["providers.fallbackPolicy.set"][1].latestMinor).toBe(
      1,
    );
    expect(
      hostRpcRegistry["providers.fallbackPolicy.previewTierGroups"][1]
        .latestMinor,
    ).toBe(1);
  });

  it("each registry version holds the matching contract and upgrade path", () => {
    const get = hostRpcRegistry["providers.fallbackPolicy.get"][1].versions;
    expect(get[0].contract).toBe(providersFallbackPolicyGetV10);
    expect(get[0].upgradeFromPreviousVersion).toBeNull();
    expect(get[1].contract).toBe(providersFallbackPolicyGetV11);
    expect(get[1].upgradeFromPreviousVersion).toBe(
      providersFallbackPolicyGetUpgradeV10ToV11,
    );
    const set = hostRpcRegistry["providers.fallbackPolicy.set"][1].versions;
    expect(set[0].contract).toBe(providersFallbackPolicySetV10);
    expect(set[1].contract).toBe(providersFallbackPolicySetV11);
    expect(set[1].upgradeFromPreviousVersion).toBe(
      providersFallbackPolicySetUpgradeV10ToV11,
    );
    const preview =
      hostRpcRegistry["providers.fallbackPolicy.previewTierGroups"][1].versions;
    expect(preview[0].contract).toBe(
      providersFallbackPolicyPreviewTierGroupsV10,
    );
    expect(preview[1].contract).toBe(
      providersFallbackPolicyPreviewTierGroupsV11,
    );
    expect(preview[1].upgradeFromPreviousVersion).toBe(
      providersFallbackPolicyPreviewTierGroupsUpgradeV10ToV11,
    );
  });

  it("contracts carry their own method and version", () => {
    expect(providersFallbackPolicyGetV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(providersFallbackPolicyGetV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(providersFallbackPolicySetV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(providersFallbackPolicySetV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(providersFallbackPolicyPreviewTierGroupsV10.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(providersFallbackPolicyPreviewTierGroupsV11.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
    expect(providersFallbackPolicyGetV11.method).toBe(
      "providers.fallbackPolicy.get",
    );
    expect(providersFallbackPolicySetV11.method).toBe(
      "providers.fallbackPolicy.set",
    );
    expect(providersFallbackPolicyPreviewTierGroupsV11.method).toBe(
      "providers.fallbackPolicy.previewTierGroups",
    );
  });
});

describe("get and set upgrade paths are identities", () => {
  const policy = createDefaultFallbackPolicy();

  it("get: request and response pass through equal", () => {
    expect(
      providersFallbackPolicyGetUpgradeV10ToV11.upgradeRequest({}),
    ).toEqual({});
    const response = {
      policy,
      storedPolicyUnreadable: false,
      inFlightCount: 2,
    };
    expect(
      providersFallbackPolicyGetUpgradeV10ToV11.upgradeResponse(response),
    ).toEqual(response);
  });

  it("set: request and response pass through equal", () => {
    expect(
      providersFallbackPolicySetUpgradeV10ToV11.upgradeRequest({ policy }),
    ).toEqual({
      policy,
    });
    expect(
      providersFallbackPolicySetUpgradeV10ToV11.upgradeResponse({ policy }),
    ).toEqual({
      policy,
    });
  });
});

const ROW: TierGroup["candidates"][number] = {
  harnessId: "claude",
  modelFamily: "*opus*",
  reasoningEffort: null,
};

const V10_CANDIDATE: TierCandidatePreviewV10 = {
  groupId: "g",
  candidateIndex: 0,
  harnessId: "claude",
  modelFamily: "*opus*",
  reasoningEffort: null,
  resolvedModel: "opus[1m]",
  profileId: "p1",
  skipReason: null,
  skipLabel: null,
  warnings: ["w"],
};

describe("previewTierGroups upgrade 1.0 -> 1.1", () => {
  const path = providersFallbackPolicyPreviewTierGroupsUpgradeV10ToV11;

  it("upgradeRequest keeps only groups", () => {
    const groups = [{ id: "g", candidates: [ROW] }];
    expect(path.upgradeRequest({ groups })).toEqual({ groups });
  });

  it("a resolved candidate gets one match copied from it", () => {
    const upgraded = path.upgradeResponse({ candidates: [V10_CANDIDATE] });
    expect(upgraded.candidates).toEqual([
      {
        ...V10_CANDIDATE,
        matches: [
          {
            model: "opus[1m]",
            profileId: "p1",
            skipReason: null,
            skipLabel: null,
          },
        ],
      },
    ]);
  });

  it("a resolved-but-skipped candidate's entry carries the skip, and the candidate keeps it", () => {
    const skipped = {
      ...V10_CANDIDATE,
      profileId: null,
      skipReason: "profile-signed-out",
      skipLabel: "Signed out",
    };
    const [row] = path.upgradeResponse({ candidates: [skipped] }).candidates;
    expect(row.matches).toEqual([
      {
        model: "opus[1m]",
        profileId: null,
        skipReason: "profile-signed-out",
        skipLabel: "Signed out",
      },
    ]);
    expect(row.skipReason).toBe("profile-signed-out");
  });

  it("an unresolved candidate gets no matches and keeps its skip", () => {
    const unresolved = {
      ...V10_CANDIDATE,
      resolvedModel: null,
      profileId: null,
      skipReason: "family-unmatched",
      skipLabel: "No model matches this pattern",
    };
    const [row] = path.upgradeResponse({ candidates: [unresolved] }).candidates;
    expect(row.matches).toEqual([]);
    expect(row.skipReason).toBe("family-unmatched");
    expect(row.resolvedModel).toBeNull();
  });

  it("the upgraded response satisfies the 1.1 response schema", () => {
    const upgraded = path.upgradeResponse({ candidates: [V10_CANDIDATE] });
    expect(
      providersFallbackPolicyPreviewTierGroupsResponseSchema.safeParse(upgraded)
        .success,
    ).toBe(true);
  });
});

describe("previewTierGroups request schemas", () => {
  const groupsWith = (modelFamily: string) => ({
    groups: [{ id: "g", candidates: [{ ...ROW, modelFamily }] }],
  });

  it("1.1 accepts a blank row and trims whitespace to empty", () => {
    const blank =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse(
        groupsWith(""),
      );
    expect(blank.success).toBe(true);
    const spaces =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse(
        groupsWith("   "),
      );
    expect(spaces.success).toBe(true);
    if (!spaces.success) return;
    expect(spaces.data.groups[0].candidates[0].modelFamily).toBe("");
  });

  it("1.1 still trims a real pattern (positive control)", () => {
    const parsed =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse(
        groupsWith("  *opus*  "),
      );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.groups[0].candidates[0].modelFamily).toBe("*opus*");
  });

  it("1.0 refuses a blank row at the modelFamily path", () => {
    const result =
      providersFallbackPolicyPreviewTierGroupsRequestSchemaV10.safeParse(
        groupsWith("   "),
      );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["groups", 0, "candidates", 0, "modelFamily"],
    ]);
    expect(
      providersFallbackPolicyPreviewTierGroupsRequestSchemaV10.safeParse(
        groupsWith("*opus*"),
      ).success,
    ).toBe(true);
  });

  const BLOCKED = {
    harnessId: "claude",
    model: "opus[1m]",
    profileId: null,
    permissionMode: "supervised",
    agentMode: "regular",
    serviceTier: null,
    kind: "rate_limit",
  };

  it("`blocked` may be absent", () => {
    const parsed =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse(
        groupsWith("*opus*"),
      );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.blocked).toBeUndefined();
  });

  it("`blocked` may be a full tuple of either kind", () => {
    expect(tierPreviewBlockedTupleSchema.safeParse(BLOCKED).success).toBe(true);
    const request =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse({
        ...groupsWith("*opus*"),
        blocked: { ...BLOCKED, kind: "other" },
      });
    expect(request.success).toBe(true);
    if (!request.success) return;
    expect(request.data.blocked?.kind).toBe("other");
  });

  it("`defaultTierGroupId` may be absent, null or a tier id, and a 1.0 request upgrades without one", () => {
    const absent =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse(
        groupsWith("*opus*"),
      );
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    expect(absent.data.defaultTierGroupId).toBeUndefined();
    const named =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse({
        ...groupsWith("*opus*"),
        defaultTierGroupId: "flagship",
        blocked: BLOCKED,
      });
    expect(named.success).toBe(true);
    if (!named.success) return;
    expect(named.data.defaultTierGroupId).toBe("flagship");
    expect(
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse({
        ...groupsWith("*opus*"),
        defaultTierGroupId: null,
      }).success,
    ).toBe(true);
    expect(
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse({
        ...groupsWith("*opus*"),
        defaultTierGroupId: 7,
      }).success,
    ).toBe(false);
    expect(
      providersFallbackPolicyPreviewTierGroupsUpgradeV10ToV11.upgradeRequest(
        groupsWith("*opus*"),
      ),
    ).not.toHaveProperty("defaultTierGroupId");
  });

  it("`blocked` with a bad kind is refused at its path", () => {
    const result =
      providersFallbackPolicyPreviewTierGroupsRequestSchema.safeParse({
        ...groupsWith("*opus*"),
        blocked: { ...BLOCKED, kind: "banana" },
      });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["blocked", "kind"],
    ]);
  });
});

describe("previewTierGroups response schemas", () => {
  const withMatches = {
    ...V10_CANDIDATE,
    matches: [
      { model: "opus[1m]", profileId: null, skipReason: null, skipLabel: null },
    ],
  };

  it("1.1 requires `matches` (positive control: present parses)", () => {
    expect(
      providersFallbackPolicyPreviewTierGroupsResponseSchema.safeParse({
        candidates: [withMatches],
      }).success,
    ).toBe(true);
    const missing =
      providersFallbackPolicyPreviewTierGroupsResponseSchema.safeParse({
        candidates: [V10_CANDIDATE],
      });
    expect(missing.success).toBe(false);
    if (missing.success) return;
    expect(missing.error.issues.map((issue) => issue.path)).toEqual([
      ["candidates", 0, "matches"],
    ]);
  });

  it("1.0 has no `matches` and parses without it", () => {
    const parsed =
      providersFallbackPolicyPreviewTierGroupsResponseSchemaV10.safeParse({
        candidates: [V10_CANDIDATE],
      });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect("matches" in parsed.data.candidates[0]).toBe(false);
  });
});

// One `it` per "Done when" line of ticket 01.
describe("ticket 01: done when", () => {
  it("`*opus*` matches {default, Default (Opus 5.5)} and `opus` does not", () => {
    const model = { slug: "default", label: "Default (Opus 5.5)" };
    expect(modelMatchesPattern("*opus*", model)).toBe(true);
    expect(modelMatchesPattern("opus", model)).toBe(false);
  });

  it("`*` alone matches every catalog entry", () => {
    const all = [...CLAUDE_CATALOG, ...CODEX_CATALOG, ...GROK_CATALOG];
    expect(all).toHaveLength(16);
    expect(all.filter((entry) => modelMatchesPattern("*", entry))).toHaveLength(
      16,
    );
  });

  it("a pattern containing `(a+)+$` returns promptly", () => {
    const subject = `${"a".repeat(100_000)}!`;
    const started = performance.now();
    expect(
      modelMatchesPattern("*(a+)+$", { slug: subject, label: subject }),
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("the seed routes gpt-6-sol -> flagship", () => {
    expect(
      routeTierGroupForFailedTuple({
        groups: SEED_GROUPS,
        defaultTierGroupId: SEED_DEFAULT,
        harnessId: "codex",
        model: "gpt-6-sol",
        catalog: CODEX_CATALOG,
      })?.id,
    ).toBe("flagship");
  });

  it("the seed routes gpt-5.5 -> the default tier", () => {
    expect(
      routeTierGroupForFailedTuple({
        groups: SEED_GROUPS,
        defaultTierGroupId: "standard",
        harnessId: "codex",
        model: "gpt-5.5",
        catalog: CODEX_CATALOG,
      })?.id,
    ).toBe("standard");
    expect(
      routeTierGroupForFailedTuple({
        groups: SEED_GROUPS,
        defaultTierGroupId: SEED_DEFAULT,
        harnessId: "codex",
        model: "gpt-5.5",
        catalog: CODEX_CATALOG,
      })?.id,
    ).toBe("flagship");
  });

  it("`default` routes to flagship with the Claude catalog and to the default tier without it", () => {
    const route = (
      catalog: typeof CLAUDE_CATALOG | null,
      defaultTierGroupId: string,
    ): string | undefined =>
      routeTierGroupForFailedTuple({
        groups: SEED_GROUPS,
        defaultTierGroupId,
        harnessId: "claude",
        model: "default",
        catalog,
      })?.id;
    expect(route(CLAUDE_CATALOG, "standard")).toBe("flagship");
    expect(route(null, "standard")).toBe("standard");
  });

  it("`*gpt*` + exact gpt-5.6-terra reports one conflict on Terra routed to the first-listed tier", () => {
    const groups: readonly TierGroup[] = [
      {
        id: "A",
        candidates: [
          { harnessId: "codex", modelFamily: "*gpt*", reasoningEffort: null },
        ],
      },
      {
        id: "B",
        candidates: [
          {
            harnessId: "codex",
            modelFamily: "gpt-5.6-terra",
            reasoningEffort: null,
          },
        ],
      },
    ];
    const conflicts = findTierConflicts(
      groups,
      new Map([["codex", CODEX_CATALOG]]),
    );
    expect(conflicts.map((c) => c.model.slug)).toEqual(["gpt-5.6-terra"]);
    expect(
      routeTierGroupForFailedTuple({
        groups,
        defaultTierGroupId: null,
        harnessId: "codex",
        model: "gpt-5.6-terra",
        catalog: CODEX_CATALOG,
      })?.id,
    ).toBe("A");
  });
});
