import { describe, expect, it } from "vitest";
import { officeModelTier } from "@/lib/comm-graph/office/office-model-tier";
import type { OfficeModelTier } from "@/lib/comm-graph/office/office-types";

interface TierCase {
  readonly model: string | null;
  readonly tier: OfficeModelTier;
  readonly why: string;
}

const CASES: ReadonlyArray<TierCase> = [
  { model: "opus", tier: "large", why: "family" },
  { model: "claude-opus-5", tier: "large", why: "family inside a full slug" },
  { model: "gpt-5.4", tier: "large", why: "family" },
  { model: "gpt-4.5-preview", tier: "large", why: "family" },
  { model: "o1", tier: "large", why: "family" },
  { model: "o3", tier: "large", why: "family" },
  { model: "grok-4-latest", tier: "large", why: "family" },
  { model: "gemini-2.5-pro", tier: "large", why: "family" },
  { model: "some-model-max", tier: "large", why: "qualifier" },
  { model: "some-model-ultra", tier: "large", why: "qualifier" },
  { model: "claude-sonnet-4.5", tier: "large", why: "sonnet at the cutoff" },
  {
    model: "claude-sonnet-4-5",
    tier: "large",
    why: "a dash is the same version as a dot",
  },
  {
    model: "claude-sonnet-4-5-20250929",
    tier: "large",
    why: "dashed version ahead of a release stamp",
  },
  {
    model: "claude-sonnet-4-20250514",
    tier: "medium",
    why: "the stamp is not a minor version",
  },
  {
    model: "claude-3-5-sonnet-20241022",
    tier: "medium",
    why: "the version precedes the family name, and a stamp follows it",
  },
  { model: "claude-sonnet-5", tier: "large", why: "sonnet past the cutoff" },
  {
    model: "claude-sonnet-3.5",
    tier: "medium",
    why: "sonnet below the cutoff",
  },
  { model: "sonnet", tier: "medium", why: "sonnet with no version" },
  { model: "claude-haiku-4-5", tier: "small", why: "family" },
  { model: "gemini-2.5-flash", tier: "small", why: "qualifier" },
  { model: "some-model-nano", tier: "small", why: "qualifier" },
  { model: "some-model-lite", tier: "small", why: "qualifier" },
  { model: "a-small-model", tier: "small", why: "qualifier" },
  { model: "GPT-5-MINI", tier: "small", why: "case-insensitive, size wins" },
  { model: "gpt-5-mini", tier: "small", why: "size beats family" },
  { model: "o3-mini", tier: "small", why: "size beats family" },
  { model: "gemini-2.5-flash-lite", tier: "small", why: "two size markers" },
  { model: "some-unknown-model", tier: "medium", why: "no marker at all" },
  { model: "", tier: "medium", why: "empty slug" },
  { model: null, tier: "medium", why: "no model on the record" },
];

/**
 * A name heuristic gets to be wrong about an unfamiliar model; what it must
 * not do is disagree with itself. The table is the contract, and the
 * both-lists rows are the ones that would otherwise drift: a name carrying its
 * family AND its size resolves by SIZE, because a mini is a mini whatever it
 * is a mini of.
 */
describe("officeModelTier", () => {
  for (const entry of CASES) {
    it(`reads ${JSON.stringify(entry.model)} as ${entry.tier} (${entry.why})`, () => {
      expect(officeModelTier(entry.model)).toBe(entry.tier);
    });
  }

  /**
   * Names deliberately absent from the table above. Asking the table's own
   * inputs what the tiers are proves nothing - the answers were asserted one
   * by one already - so the closed set is checked against names the heuristic
   * has no rule for, which is where an unexpected answer could come from.
   */
  it("never answers anything outside the three tiers", () => {
    const strangers: ReadonlyArray<string> = [
      "MINI",
      "mini",
      "sonnet-sonnet-sonnet",
      "gpt",
      "-",
      "//",
      "opus-mini-max-nano-ultra",
      "model.with.dots",
      "model_with_underscores",
      "9999",
      "sonnet-99.99",
      "  spaced out  ",
      "🙂",
    ];
    for (const stranger of strangers) {
      expect(["small", "medium", "large"], stranger).toContain(
        officeModelTier(stranger),
      );
    }
  });
});
