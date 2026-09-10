import { describe, expect, it } from "vitest";
import {
  createDefaultFallbackPolicy,
  fallbackPolicySchema,
  type FallbackPolicy,
  type TierCandidate,
} from "@traycer/protocol/host/fallback-policy";

function candidate(harnessId: TierCandidate["harnessId"]): TierCandidate {
  return { harnessId, modelFamily: "shared", reasoningEffort: null };
}

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return { ...createDefaultFallbackPolicy(), ...overrides };
}

describe("fallback policy destinationExclusions", () => {
  it("accepts a legacy policy with the field absent and supplies a fresh empty array", () => {
    const { destinationExclusions: omitted, ...legacy } =
      createDefaultFallbackPolicy();
    expect(omitted).toEqual([]);

    const first = fallbackPolicySchema.parse(legacy);
    const second = fallbackPolicySchema.parse(legacy);
    expect(first.destinationExclusions).toEqual([]);
    expect(first.destinationExclusions).not.toBe(second.destinationExclusions);
  });

  it("accepts known harness ids and rejects unknown providers", () => {
    const parsed = fallbackPolicySchema.safeParse(
      policy({
        destinationExclusions: ["claude", "codex"],
        tierGroups: [
          {
            id: "sources",
            candidates: [candidate("claude"), candidate("codex")],
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);

    expect(
      fallbackPolicySchema.safeParse({
        ...createDefaultFallbackPolicy(),
        destinationExclusions: ["not-a-harness"],
      }).success,
    ).toBe(false);
  });

  it("keeps exclusions independent from source membership", () => {
    const value = policy({
      destinationExclusions: ["claude"],
      tierGroups: [
        {
          id: "sources",
          candidates: [candidate("claude"), candidate("codex")],
        },
      ],
    });
    const parsed = fallbackPolicySchema.parse(value);
    expect(parsed.destinationExclusions).toEqual(["claude"]);
    expect(
      parsed.tierGroups[0]?.candidates.map((row) => row.harnessId),
    ).toEqual(["claude", "codex"]);
  });

  it("creates independent mutable arrays for every default policy", () => {
    const first = createDefaultFallbackPolicy();
    const second = createDefaultFallbackPolicy();
    expect(first.destinationExclusions).toEqual([]);
    expect(first.destinationExclusions).not.toBe(second.destinationExclusions);
    expect(first.tierGroups).not.toBe(second.tierGroups);
  });
});
