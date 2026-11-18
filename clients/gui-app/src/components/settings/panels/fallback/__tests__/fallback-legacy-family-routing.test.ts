import { describe, expect, it } from "vitest";
import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";
import type { HarnessId } from "@traycer/protocol/host/agent/shared";
import { legacyFamilyTiersNameDestinationFor } from "@/components/settings/panels/fallback/fallback-legacy-family-routing";

/**
 * A pure unit test of `legacyFamilyTiersNameDestinationFor`, no rendering.
 *
 * Expected values are derived from the RELEASED (`origin/main`) protocol,
 * `git -C .. show origin/main:protocol/src/host/fallback-policy.ts` -
 * `candidateFamilyMatchesSlug`, `findTierGroupForFailedTuple`,
 * `routeTierGroupForFailedTuple` and `tierGroupsNameDestinationFor` - never
 * from the client copy under test.
 */

function candidate(harnessId: HarnessId, modelFamily: string): TierCandidate {
  return { harnessId, modelFamily, reasoningEffort: null };
}

function group(id: string, candidates: readonly TierCandidate[]): TierGroup {
  return { id, candidates: [...candidates] };
}

/**
 * One group, one candidate carrying the family under test plus a second,
 * unrelated candidate on the SAME harness that can never match `slug` itself
 * - `"unmatched-marker-000"` shares no substring with any slug this file
 * uses. This is what turns "does `family` match `slug`" into an observable
 * boolean: a match routes here and the marker row is a real destination
 * (`true`); no match leaves no group at all (`false`), since there is
 * nothing else to route to.
 */
function matchProbe(
  harnessId: HarnessId,
  family: string,
  slug: string,
): boolean {
  return legacyFamilyTiersNameDestinationFor({
    groups: [
      group("target", [
        candidate(harnessId, family),
        candidate(harnessId, "unmatched-marker-000"),
      ]),
    ],
    defaultTierGroupId: null,
    harnessId,
    model: slug,
  });
}

describe("legacyFamilyTiersNameDestinationFor - the released 1.0 family-word rule", () => {
  it("a whole word in the ID matches: 'gpt' vs 'gpt-6-sol'", () => {
    // Pins `candidateFamilyMatchesSlug` → `haystackHasFamilyWord`: "gpt" is
    // bounded by "-" on both sides in "gpt-6-sol".
    expect(matchProbe("codex", "gpt", "gpt-6-sol")).toBe(true);
  });

  it("a whole word matches even digit-adjacent: 'gpt' vs 'gpt4'", () => {
    // Pins `haystackHasFamilyWord`'s boundary class `[^a-z]`: a digit is a
    // boundary, not a letter, so "gpt" still matches "gpt4".
    expect(matchProbe("codex", "gpt", "gpt4")).toBe(true);
  });

  it("a substring inside a word does NOT match: 'pi' vs 'copilot'", () => {
    // Pins `haystackHasFamilyWord`'s own worked example: a plain `includes()`
    // would wrongly match "pi" inside "co-pi-lot"'s unhyphenated cousin.
    expect(matchProbe("codex", "pi", "copilot")).toBe(false);
  });

  it("a needle equal to the whole ID matches", () => {
    // Pins `candidateFamilyMatchesSlug`'s `needle === slug` arm.
    expect(matchProbe("codex", "gpt-6-sol", "gpt-6-sol")).toBe(true);
  });

  it("case and whitespace are folded before matching: ' Opus ' matches 'claude-opus-5'", () => {
    // Pins `candidateFamilyMatchesSlug`'s `family.trim().toLowerCase()`.
    expect(matchProbe("claude", " Opus ", "claude-opus-5")).toBe(true);
  });

  it("a blank family matches nothing", () => {
    // Pins `candidateFamilyMatchesSlug`'s `needle.length === 0` early return.
    expect(matchProbe("claude", "   ", "claude-opus-5")).toBe(false);
  });

  it("regex metacharacters in the family are literal: '.*' matches nothing in 'gpt-6-sol'", () => {
    // Pins `haystackHasFamilyWord`'s `escapeRegExpLiteral` - an unescaped
    // ".*" would match every model; the escaped literal matches none of them.
    expect(matchProbe("codex", ".*", "gpt-6-sol")).toBe(false);
  });

  it("the LONGEST matching family wins across tiers, and a TIE goes to the earlier tier", () => {
    // Pins `findTierGroupForFailedTuple`'s "strictly greater" tie rule: two
    // candidates named "abcd" (length 4) both match "codex-abcd-model", one
    // in each tier. The earlier tier ("frontier") also carries a genuine
    // destination (claude "opus", a different harness); the later tier
    // ("standard") carries only its own "abcd" row. If the later tier won the
    // tie, the routed tier's only row would be a self-match and this would
    // read `false` instead.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [
        group("frontier", [
          candidate("codex", "abcd"),
          candidate("claude", "opus"),
        ]),
        group("standard", [candidate("codex", "abcd")]),
      ],
      defaultTierGroupId: null,
      harnessId: "codex",
      model: "codex-abcd-model",
    });
    expect(result).toBe(true);
  });

  it("the harness must match: a codex 'gpt' row does not claim a claude tuple", () => {
    // Pins `findTierGroupForFailedTuple`'s `candidate.harnessId !== harnessId`
    // skip. "gpt" (codex, length 3) and "sol" (claude, length 3) are a tie by
    // length alone, but the tuple's harness is claude, so the codex row must
    // never be considered a candidate at all - only claude "sol" (also a
    // whole word in "gpt-6-sol") can route it. A harness-blind tie-break
    // would instead pick the EARLIER "frontier" tier (codex "gpt"), whose row
    // - on the wrong harness - would then read as a genuine destination
    // (`true`) rather than the correct self-match exclusion (`false`).
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [
        group("frontier", [candidate("codex", "gpt")]),
        group("standard", [candidate("claude", "sol")]),
      ],
      defaultTierGroupId: null,
      harnessId: "claude",
      model: "gpt-6-sol",
    });
    expect(result).toBe(false);
  });

  it("no specific match, defaultTierGroupId names a tier with a real destination - true", () => {
    // Pins `routeTierGroupForFailedTuple`'s default-id fallback: neither
    // tier's family ("totally-unrelated-frontier" / "totally-unrelated-fallback")
    // matches "xyz-999-model" at all, so the specific-match step finds
    // nothing and the default tier is consulted.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [
        group("frontier", [candidate("codex", "totally-unrelated-frontier")]),
        group("fallback", [candidate("codex", "totally-unrelated-fallback")]),
      ],
      defaultTierGroupId: "fallback",
      harnessId: "codex",
      model: "xyz-999-model",
    });
    expect(result).toBe(true);
  });

  it("no specific match, defaultTierGroupId names an EMPTY tier - false", () => {
    // Pins the default-id fallback's false arm: `routeTierGroupForFailedTuple`
    // resolves the default tier (nothing matches "xyz-999-model"), and
    // `tierGroupsNameDestinationFor`'s `some` over its zero rows is false. A
    // default tier whose only row is the failed model's own family cannot pin
    // this - that row would match directly, so the default is never consulted.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [
        group("frontier", [candidate("codex", "totally-unrelated-frontier")]),
        group("fallback", []),
      ],
      defaultTierGroupId: "fallback",
      harnessId: "codex",
      model: "xyz-999-model",
    });
    expect(result).toBe(false);
  });

  it("no match anywhere, defaultTierGroupId null - false", () => {
    // Pins `routeTierGroupForFailedTuple`'s `defaultTierGroupId === null`
    // return-null arm.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [group("frontier", [candidate("codex", "totally-unrelated")])],
      defaultTierGroupId: null,
      harnessId: "codex",
      model: "xyz-999-model",
    });
    expect(result).toBe(false);
  });

  it("a default naming no tier - false", () => {
    // Pins `routeTierGroupForFailedTuple`'s `groups.find(...) ?? null` - an
    // id matching no group's `id` routes nowhere rather than to a lookalike.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [group("frontier", [candidate("codex", "totally-unrelated")])],
      defaultTierGroupId: "ghost",
      harnessId: "codex",
      model: "xyz-999-model",
    });
    expect(result).toBe(false);
  });

  it("the routed tier's only row is the failed model's own family on the same harness - false", () => {
    // Pins `tierGroupsNameDestinationFor`'s exclusion rule directly, reached
    // through an ordinary (non-default) specific match.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [group("solo", [candidate("codex", "gpt")])],
      defaultTierGroupId: null,
      harnessId: "codex",
      model: "gpt-6-sol",
    });
    expect(result).toBe(false);
  });

  it("the same family on ANOTHER harness counts as a destination - true", () => {
    // Pins `tierGroupsNameDestinationFor`'s `candidate.harnessId === input.harnessId`
    // half of the exclusion test: a claude row named "gpt" is not excluded by
    // codex's own "gpt" self-match, because it is on a different harness.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [
        group("solo", [candidate("codex", "gpt"), candidate("claude", "gpt")]),
      ],
      defaultTierGroupId: null,
      harnessId: "codex",
      model: "gpt-6-sol",
    });
    expect(result).toBe(true);
  });

  it("label-only: claude/default with an opus row - false (the rule never reads a label)", () => {
    // Pins `findTierGroupForFailedTuple`'s own documented asymmetry: matched
    // against the failed model's SLUG only. "opus" is a whole word in the
    // catalog LABEL a host might show for "default" ("Default (Opus 5.5)"),
    // but this function never sees a label - only the slug "default" - so an
    // "opus" row can never claim it.
    const result = legacyFamilyTiersNameDestinationFor({
      groups: [group("frontier", [candidate("claude", "opus")])],
      defaultTierGroupId: null,
      harnessId: "claude",
      model: "default",
    });
    expect(result).toBe(false);
  });
});
