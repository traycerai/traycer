import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
  routeTierGroupForFailedTuple,
  tierGroupsNameDestinationFor,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";

/**
 * `defaultTierGroupId` - the "equivalent model" step's fallback group for a
 * tuple that is in NO group, plus the two routing functions built on top of
 * it: {@link routeTierGroupForFailedTuple} (the engine's own scoping) and
 * {@link tierGroupsNameDestinationFor} (the frozen, no-I/O error-card
 * verdict). One suite because the whole point of the field is that both
 * consumers agree about it - a test file per function could pass while the
 * two silently disagreed on which group a default routes to.
 */

const FRONTIER: TierGroup = {
  id: "frontier",
  candidates: [
    { harnessId: "claude", modelFamily: "opus", reasoningEffort: null },
  ],
};

const STANDARD: TierGroup = {
  id: "standard",
  candidates: [
    { harnessId: "codex", modelFamily: "gpt", reasoningEffort: null },
  ],
};

// A full, schema-valid object with the field OMITTED entirely - the upgrade
// path a policy stored before this field existed takes on read.
const POLICY_WITHOUT_FIELD = {
  enabled: false,
  ladder: ["profile", "tier", "wait", "notify"],
  graceWindowSeconds: 15,
  maxWaitMinutes: 360,
  returnToPreferred: "prompt",
  tierGroups: [FRONTIER, STANDARD],
};

function policyWithField(
  defaultTierGroupId: string | null,
): Record<string, unknown> {
  return { ...POLICY_WITHOUT_FIELD, defaultTierGroupId };
}

describe("fallbackPolicySchema: defaultTierGroupId", () => {
  it("parses a stored policy that predates the field, defaulting it to null", () => {
    const result = fallbackPolicySchema.safeParse(POLICY_WITHOUT_FIELD);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.defaultTierGroupId).toBeNull();
  });

  it("parses a non-null id that names an existing group", () => {
    const result = fallbackPolicySchema.safeParse(policyWithField("frontier"));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.defaultTierGroupId).toBe("frontier");
  });

  it("refuses an id that names no group, at the defaultTierGroupId path", () => {
    const result = fallbackPolicySchema.safeParse(policyWithField("ghost"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["defaultTierGroupId"],
    ]);
  });
});

describe("createDefaultFallbackPolicy", () => {
  // A configuration the user makes, never a seed - see the field's own doc
  // comment. Falsification: a seeding change that pointed new users at one of
  // the seeded groups by default would go unnoticed without this pin.
  it("defaults defaultTierGroupId to null", () => {
    expect(createDefaultFallbackPolicy().defaultTierGroupId).toBeNull();
  });
});

describe("routeTierGroupForFailedTuple", () => {
  const groups: readonly TierGroup[] = [FRONTIER, STANDARD];

  it("routes a listed model to its own group even when a different default is set", () => {
    expect(
      routeTierGroupForFailedTuple({
        groups,
        defaultTierGroupId: "standard",
        harnessId: "claude",
        model: "claude-opus-5",
      }),
    ).toEqual(FRONTIER);
  });

  it("routes an unlisted model to the default group", () => {
    expect(
      routeTierGroupForFailedTuple({
        groups,
        defaultTierGroupId: "standard",
        harnessId: "claude",
        model: "claude-haiku-5",
      }),
    ).toEqual(STANDARD);
  });

  it("returns null for an unlisted model with no default set", () => {
    expect(
      routeTierGroupForFailedTuple({
        groups,
        defaultTierGroupId: null,
        harnessId: "claude",
        model: "claude-haiku-5",
      }),
    ).toBeNull();
  });

  it("returns null when the default names a group that does not exist", () => {
    // The schema refuses this on save, but a stored policy is a stored
    // policy - the router must not fall back to a lookalike.
    expect(
      routeTierGroupForFailedTuple({
        groups,
        defaultTierGroupId: "ghost",
        harnessId: "claude",
        model: "claude-haiku-5",
      }),
    ).toBeNull();
  });
});

describe("tierGroupsNameDestinationFor with a default group", () => {
  it("returns true when the default group names a model other than the failed one", () => {
    expect(
      tierGroupsNameDestinationFor({
        groups: [FRONTIER, STANDARD],
        defaultTierGroupId: "standard",
        harnessId: "claude",
        model: "claude-haiku-5",
      }),
    ).toBe(true);
  });

  it("returns false when the default group names only the failed model's own family", () => {
    const soloDefault: TierGroup = {
      id: "solo",
      candidates: [
        { harnessId: "claude", modelFamily: "haiku", reasoningEffort: null },
      ],
    };
    expect(
      tierGroupsNameDestinationFor({
        groups: [FRONTIER, soloDefault],
        defaultTierGroupId: "solo",
        harnessId: "claude",
        model: "claude-haiku-5",
      }),
    ).toBe(false);
  });

  it("returns false with no default, matching the pre-existing behaviour", () => {
    expect(
      tierGroupsNameDestinationFor({
        groups: [FRONTIER, STANDARD],
        defaultTierGroupId: null,
        harnessId: "claude",
        model: "claude-haiku-5",
      }),
    ).toBe(false);
  });
});
