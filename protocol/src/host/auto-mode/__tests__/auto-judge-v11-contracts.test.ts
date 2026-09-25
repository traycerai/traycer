import { describe, expect, it } from "vitest";
import { validateVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  AUTO_JUDGE_RECENT_INPUT_SUMMARY_MAX_CHARS,
  AUTO_JUDGE_RECENT_LIMIT_MAX,
  AUTO_JUDGE_RECENT_LIMIT_MIN,
  autoJudgeBlockedSchema,
  autoJudgeEffectiveSchema,
  autoJudgeGetResponseSchema,
  autoJudgeGetResponseSchemaV10,
  autoJudgeGetResponseSchemaV11,
  autoJudgeGetUpgradeV10ToV11,
  autoJudgeGetUpgradeV11ToV12,
  autoJudgeGetV10,
  autoJudgeGetV11,
  autoJudgeGetV12,
  autoJudgeListRecentRequestSchema,
  autoJudgeListRecentV10,
  autoJudgeRecentEntrySchema,
  autoJudgeSetResponseSchema,
  autoJudgeSetResponseSchemaV10,
  autoJudgeSetResponseSchemaV11,
  autoJudgeSetUpgradeV10ToV11,
  autoJudgeSetUpgradeV11ToV12,
  autoJudgeSetV10,
  autoJudgeSetV11,
  autoJudgeSetV12,
  clampAutoJudgeRecentLimit,
  projectAutoJudgeGetResponseToV10,
  projectAutoJudgeSetResponseToV10,
  type AutoJudgeGetResponse,
  type AutoJudgeGetResponseV10,
  type AutoJudgeSetResponse,
  type AutoJudgeSetResponseV10,
} from "@traycer/protocol/host/auto-mode/contracts";

/**
 * `autoJudge.get` / `autoJudge.set`'s `1.1` line: the `fallback` `effective`
 * arm, the narrowed `blocked` reason, and the `1.0` <-> `1.1` bridges that
 * keep a `1.0` peer from reading Automatic's fallback as "bill the Traycer
 * pocket". See `contracts.ts`'s module docblock for the ticket motivation.
 */

function completeRecentEntry(): Record<string, unknown> {
  return {
    id: "entry-1",
    at: "2026-09-01T00:00:00.000Z",
    chatId: "chat-1",
    chatTitle: "Chat",
    toolName: "bash",
    inputSummary: "ls -la",
    outcome: "allow",
    stage: "fast",
    rule: "Some Rule",
    reason: "because",
    tier: "soft",
    judge: { harnessId: "traycer", model: "claude" },
    judgeKind: "traycer",
    judgeSource: "default",
    unattended: false,
    failureKind: null,
  };
}

describe("autoJudge.get/set@1.1: the downgrade to 1.0", () => {
  it("projects a fallback answer to provider-disabled, the pessimistic 1.0 reading", () => {
    const input: AutoJudgeGetResponse = {
      selection: null,
      effective: { source: "fallback" },
      blocked: null,
    };
    const expected: AutoJudgeGetResponseV10 = {
      selection: null,
      effective: null,
      blocked: { reason: "provider-disabled" },
    };
    const projected = projectAutoJudgeGetResponseToV10(input);
    expect(projected).toEqual(expected);
    expect(
      hostRpcRegistry[
        "autoJudge.get"
      ][1].versions[0].contract.responseSchema.safeParse(projected).success,
    ).toBe(true);

    // Load-bearing: the RAW fallback answer is not a valid 1.0 response at
    // all - the projection is what makes a 1.0 caller's decode possible.
    expect(autoJudgeGetV10.responseSchema.safeParse(input).success).toBe(false);
  });

  it("overrides an (incorrectly) already-populated blocked on a fallback answer", () => {
    const input: AutoJudgeGetResponse = {
      selection: null,
      effective: { source: "fallback" },
      blocked: { reason: "unsupported-harness" },
    };
    expect(projectAutoJudgeGetResponseToV10(input)).toEqual({
      selection: null,
      effective: null,
      blocked: { reason: "provider-disabled" },
    });
  });

  it("does the same projection for autoJudge.set's echo", () => {
    const input: AutoJudgeSetResponse = {
      selection: null,
      effective: { source: "fallback" },
      blocked: null,
    };
    const expected: AutoJudgeSetResponseV10 = {
      selection: null,
      effective: null,
      blocked: { reason: "provider-disabled" },
    };
    const projected = projectAutoJudgeSetResponseToV10(input);
    expect(projected).toEqual(expected);
    expect(
      hostRpcRegistry[
        "autoJudge.set"
      ][1].versions[0].contract.responseSchema.safeParse(projected).success,
    ).toBe(true);
    expect(autoJudgeSetV10.responseSchema.safeParse(input).success).toBe(false);
  });

  it("overrides an (incorrectly) already-populated blocked on a fallback set echo", () => {
    const input: AutoJudgeSetResponse = {
      selection: null,
      effective: { source: "fallback" },
      blocked: { reason: "unsupported-harness" },
    };
    expect(projectAutoJudgeSetResponseToV10(input)).toEqual({
      selection: null,
      effective: null,
      blocked: { reason: "provider-disabled" },
    });
  });

  it("passes a selection/default effective through unchanged", () => {
    const selectionAnswer: AutoJudgeGetResponse = {
      selection: null,
      effective: {
        harnessId: "claude",
        model: "claude-sonnet",
        source: "selection",
      },
      blocked: null,
    };
    expect(projectAutoJudgeGetResponseToV10(selectionAnswer)).toEqual(
      selectionAnswer,
    );

    const defaultAnswer: AutoJudgeGetResponse = {
      selection: null,
      effective: {
        harnessId: "traycer",
        model: "traycer-model",
        source: "default",
      },
      blocked: null,
    };
    expect(projectAutoJudgeGetResponseToV10(defaultAnswer)).toEqual(
      defaultAnswer,
    );
  });

  it("passes an unsupported-harness blocked through unchanged", () => {
    const answer: AutoJudgeGetResponse = {
      selection: null,
      effective: null,
      blocked: { reason: "unsupported-harness" },
    };
    expect(projectAutoJudgeGetResponseToV10(answer)).toEqual(answer);
  });

  it("leaves effective/blocked absent in the projection when absent on the input", () => {
    const answer: AutoJudgeGetResponse = { selection: null };
    const projected = projectAutoJudgeGetResponseToV10(answer);
    expect(Object.hasOwn(projected, "effective")).toBe(false);
    expect(Object.hasOwn(projected, "blocked")).toBe(false);
  });
});

describe("autoJudge.get/set@1.0 -> 1.1: the upgrade", () => {
  it("upgrades no-default to unsupported-harness", () => {
    const v10: AutoJudgeGetResponseV10 = {
      selection: null,
      effective: null,
      blocked: { reason: "no-default" },
    };
    const upgraded = autoJudgeGetUpgradeV10ToV11.upgradeResponse(v10);
    expect(upgraded).toEqual({
      selection: null,
      effective: null,
      blocked: { reason: "unsupported-harness" },
    });
    expect(autoJudgeGetV11.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("does the same upgrade for autoJudge.set", () => {
    const v10: AutoJudgeSetResponseV10 = {
      selection: null,
      effective: null,
      blocked: { reason: "no-default" },
    };
    const upgraded = autoJudgeSetUpgradeV10ToV11.upgradeResponse(v10);
    expect(upgraded).toEqual({
      selection: null,
      effective: null,
      blocked: { reason: "unsupported-harness" },
    });
    expect(autoJudgeSetV11.responseSchema.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("passes provider-disabled and unsupported-harness through unchanged", () => {
    for (const reason of [
      "provider-disabled",
      "unsupported-harness",
    ] as const) {
      const v10: AutoJudgeGetResponseV10 = {
        selection: null,
        effective: null,
        blocked: { reason },
      };
      expect(autoJudgeGetUpgradeV10ToV11.upgradeResponse(v10)).toEqual(v10);
    }
  });

  it("keeps source on a passed-through selection/default effective", () => {
    for (const source of ["selection", "default"] as const) {
      const v10: AutoJudgeGetResponseV10 = {
        selection: null,
        effective: { harnessId: "claude", model: "claude-sonnet", source },
        blocked: null,
      };
      const upgraded = autoJudgeGetUpgradeV10ToV11.upgradeResponse(v10);
      expect(upgraded.effective).toEqual(v10.effective);
    }
  });

  it("never upgrades to source: fallback - a 1.0 host has no fallback answer to carry", () => {
    // `AutoJudgeGetResponseV10["effective"]` has no `fallback` member at all
    // (`autoJudgeEffectiveSchemaV10`), so the upgrade function has no input
    // that could produce one; it only ever forwards what it was given.
    const v10: AutoJudgeGetResponseV10 = {
      selection: null,
      effective: {
        harnessId: "claude",
        model: "claude-sonnet",
        source: "default",
      },
      blocked: null,
    };
    const upgraded = autoJudgeGetUpgradeV10ToV11.upgradeResponse(v10);
    expect(upgraded.effective?.source).not.toBe("fallback");
  });

  it("leaves effective/blocked absent when absent on the 1.0 input", () => {
    const v10: AutoJudgeGetResponseV10 = { selection: null };
    const upgraded = autoJudgeGetUpgradeV10ToV11.upgradeResponse(v10);
    expect(Object.hasOwn(upgraded, "effective")).toBe(false);
    expect(Object.hasOwn(upgraded, "blocked")).toBe(false);
  });
});

describe("autoJudge 1.1 schemas", () => {
  it("autoJudgeBlockedSchema rejects the retired no-default reason", () => {
    expect(
      autoJudgeBlockedSchema.safeParse({ reason: "no-default" }).success,
    ).toBe(false);
    expect(
      autoJudgeBlockedSchema.safeParse({ reason: "provider-disabled" }).success,
    ).toBe(true);
  });

  it("autoJudgeEffectiveSchema accepts fallback and rejects an unknown source or a malformed selection arm", () => {
    expect(
      autoJudgeEffectiveSchema.safeParse({ source: "fallback" }).success,
    ).toBe(true);
    expect(
      autoJudgeEffectiveSchema.safeParse({
        harnessId: "claude",
        model: "m",
        source: "guess",
      }).success,
    ).toBe(false);
    expect(
      autoJudgeEffectiveSchema.safeParse({ model: "m", source: "selection" })
        .success,
    ).toBe(false);
  });

  it("binds the canonical head names by identity", () => {
    expect(autoJudgeGetV10.responseSchema).toBe(autoJudgeGetResponseSchemaV10);
    expect(autoJudgeGetV11.responseSchema).toBe(autoJudgeGetResponseSchemaV11);
    expect(autoJudgeGetV12.responseSchema).toBe(autoJudgeGetResponseSchema);
    expect(autoJudgeSetV10.responseSchema).toBe(autoJudgeSetResponseSchemaV10);
    expect(autoJudgeSetV11.responseSchema).toBe(autoJudgeSetResponseSchemaV11);
    expect(autoJudgeSetV12.responseSchema).toBe(autoJudgeSetResponseSchema);
  });
});

describe("autoJudge.get/set registry entries", () => {
  it("head at 1.2, with 1.0 and 1.1 still installed and the 1.1 growth projection-gated", () => {
    for (const method of ["autoJudge.get", "autoJudge.set"] as const) {
      const entry = hostRpcRegistry[method];
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(2);
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    }

    expect(hostRpcRegistry["autoJudge.get"][1].versions[0].contract).toBe(
      autoJudgeGetV10,
    );
    expect(hostRpcRegistry["autoJudge.get"][1].versions[1].contract).toBe(
      autoJudgeGetV11,
    );
    expect(hostRpcRegistry["autoJudge.get"][1].versions[2].contract).toBe(
      autoJudgeGetV12,
    );
    expect(
      hostRpcRegistry["autoJudge.get"][1].versions[1]
        .responseGrowthProjectionGated,
    ).toBe(true);
    // `lastSelection` is a new key, which a 1.1 caller's re-parse strips, so
    // 1.2 carries no growth annotation at all.
    expect(
      Object.hasOwn(
        hostRpcRegistry["autoJudge.get"][1].versions[2],
        "responseGrowthProjectionGated",
      ),
    ).toBe(false);
    expect(
      hostRpcRegistry["autoJudge.get"][1].versions[1]
        .upgradeFromPreviousVersion,
    ).toBe(autoJudgeGetUpgradeV10ToV11);
    expect(
      hostRpcRegistry["autoJudge.get"][1].versions[2]
        .upgradeFromPreviousVersion,
    ).toBe(autoJudgeGetUpgradeV11ToV12);

    expect(hostRpcRegistry["autoJudge.set"][1].versions[0].contract).toBe(
      autoJudgeSetV10,
    );
    expect(hostRpcRegistry["autoJudge.set"][1].versions[1].contract).toBe(
      autoJudgeSetV11,
    );
    expect(hostRpcRegistry["autoJudge.set"][1].versions[2].contract).toBe(
      autoJudgeSetV12,
    );
    expect(
      hostRpcRegistry["autoJudge.set"][1].versions[1]
        .responseGrowthProjectionGated,
    ).toBe(true);
    expect(
      Object.hasOwn(
        hostRpcRegistry["autoJudge.set"][1].versions[2],
        "responseGrowthProjectionGated",
      ),
    ).toBe(false);
    expect(
      hostRpcRegistry["autoJudge.set"][1].versions[1]
        .upgradeFromPreviousVersion,
    ).toBe(autoJudgeSetUpgradeV10ToV11);
    expect(
      hostRpcRegistry["autoJudge.set"][1].versions[2]
        .upgradeFromPreviousVersion,
    ).toBe(autoJudgeSetUpgradeV11ToV12);
  });

  it("validates the registry as constructed", () => {
    expect(() => validateVersionedRpcRegistry(hostRpcRegistry)).not.toThrow();
  });
});

describe("autoJudge.listRecent", () => {
  it("registers off the released floor at 1.0", () => {
    const entry = hostRpcRegistry["autoJudge.listRecent"];
    expect(entry.degrade).toEqual({ kind: "unsupported" });
    expect(entry[1].latestMinor).toBe(0);
    expect(entry[1].versions[0].contract).toBe(autoJudgeListRecentV10);
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("autoJudge.listRecent");
  });

  it("clamps the requested page size into [MIN, MAX]", () => {
    expect(clampAutoJudgeRecentLimit(-5)).toBe(1);
    expect(clampAutoJudgeRecentLimit(0)).toBe(1);
    expect(clampAutoJudgeRecentLimit(1)).toBe(1);
    expect(clampAutoJudgeRecentLimit(50)).toBe(50);
    expect(clampAutoJudgeRecentLimit(200)).toBe(200);
    expect(clampAutoJudgeRecentLimit(201)).toBe(200);
    expect(clampAutoJudgeRecentLimit(10000)).toBe(200);
    expect(clampAutoJudgeRecentLimit(AUTO_JUDGE_RECENT_LIMIT_MIN)).toBe(
      AUTO_JUDGE_RECENT_LIMIT_MIN,
    );
    expect(clampAutoJudgeRecentLimit(AUTO_JUDGE_RECENT_LIMIT_MAX)).toBe(
      AUTO_JUDGE_RECENT_LIMIT_MAX,
    );
  });

  it("accepts any integer on the request, including out-of-range ones - the host clamps rather than refuses", () => {
    expect(
      autoJudgeListRecentRequestSchema.safeParse({ limit: 0 }).success,
    ).toBe(true);
    expect(
      autoJudgeListRecentRequestSchema.safeParse({ limit: 1000 }).success,
    ).toBe(true);
    expect(
      autoJudgeListRecentRequestSchema.safeParse({ limit: 1.5 }).success,
    ).toBe(false);
    expect(
      autoJudgeListRecentRequestSchema.safeParse({ limit: "10" }).success,
    ).toBe(false);
  });

  it("parses a complete valid entry", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse(completeRecentEntry()).success,
    ).toBe(true);
  });

  it("failureKind is a checked string: any non-empty label parses, empty is rejected, null is fine", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        failureKind: "a-failure-kind-this-build-has-never-heard-of",
      }).success,
    ).toBe(true);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        failureKind: "",
      }).success,
    ).toBe(false);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        failureKind: null,
      }).success,
    ).toBe(true);
  });

  it("judge.harnessId is a checked string; judge itself may be null", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        judge: {
          harnessId: "a-harness-this-build-has-never-heard-of",
          model: null,
        },
      }).success,
    ).toBe(true);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        judge: { harnessId: "", model: null },
      }).success,
    ).toBe(false);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        judge: null,
      }).success,
    ).toBe(true);
  });

  it("inputSummary is bounded at AUTO_JUDGE_RECENT_INPUT_SUMMARY_MAX_CHARS", () => {
    const atLimit = "a".repeat(AUTO_JUDGE_RECENT_INPUT_SUMMARY_MAX_CHARS);
    const overLimit = `${atLimit}a`;
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        inputSummary: atLimit,
      }).success,
    ).toBe(true);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        inputSummary: overLimit,
      }).success,
    ).toBe(false);
  });

  it("outcome is a closed enum - an unknown verdict is rejected", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        outcome: "deny",
      }).success,
    ).toBe(false);
  });

  it("tier is a closed enum with null permitted", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        tier: "fuzzy",
      }).success,
    ).toBe(false);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        tier: null,
      }).success,
    ).toBe(true);
  });

  it("judgeSource accepts fallback and null", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        judgeSource: "fallback",
      }).success,
    ).toBe(true);
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        judgeSource: null,
      }).success,
    ).toBe(true);
  });

  it("judgeKind accepts provider", () => {
    expect(
      autoJudgeRecentEntrySchema.safeParse({
        ...completeRecentEntry(),
        judgeKind: "provider",
      }).success,
    ).toBe(true);
  });
});
