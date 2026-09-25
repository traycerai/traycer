import { describe, expect, it } from "vitest";
import type {
  TierCandidate,
  TierCandidatePreview,
  TierConflict,
  TierGroup,
  TierModelIdentity,
} from "@traycer/protocol/host/fallback-policy";
import type {
  AgentReasoningEffortOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/index";
import {
  buildPatternPicker,
  modelOwnedReason,
  otherTierClaims,
  patternBlockedReason,
  patternMatchCount,
  rowConflictsFor,
  rowStatusLine,
  tierDisplayName,
  type TierClaim,
} from "@/components/settings/panels/fallback/fallback-model-patterns";
import type { FallbackSettingsProfileLabel } from "@/components/settings/panels/fallback/fallback-profile-labels";

/**
 * Shared fixture catalog, matching the ticket's spec: Codex astra/sol/luna
 * (plus a luna-mini and a terra) - one member per seeded tier pattern
 * (frontier `*astra*`, flagship `*sol*`, standard `*terra*`).
 */
function effort(id: string, label: string): AgentReasoningEffortOption {
  return { id, label, description: null };
}

const HIGH = effort("high", "High");
const MEDIUM = effort("medium", "Medium");
const ANY_EFFORTS = [HIGH, MEDIUM];

function model(
  harnessId: GuiAgentModelOption["harnessId"],
  slug: string,
  label: string,
  supportedReasoningEfforts: readonly AgentReasoningEffortOption[],
): GuiAgentModelOption {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [...supportedReasoningEfforts],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

const GPT_ASTRA = model("codex", "gpt-6-astra", "GPT-6-Astra", ANY_EFFORTS);
const GPT_SOL = model("codex", "gpt-6-sol", "GPT-6-Sol", ANY_EFFORTS);
const GPT_LUNA = model("codex", "gpt-6-luna", "GPT-6-Luna", ANY_EFFORTS);
const GPT_LUNA_MINI = model(
  "codex",
  "gpt-6-luna-mini",
  "GPT-6-Luna Mini",
  ANY_EFFORTS,
);
const GPT_TERRA = model("codex", "gpt-5.6-terra", "GPT-5.6-Terra", ANY_EFFORTS);
const CODEX_CATALOG: readonly GuiAgentModelOption[] = [
  GPT_ASTRA,
  GPT_SOL,
  GPT_LUNA,
  GPT_LUNA_MINI,
  GPT_TERRA,
];

function candidate(
  harnessId: TierCandidate["harnessId"],
  modelFamily: string,
): TierCandidate {
  return { harnessId, modelFamily, reasoningEffort: null };
}

function group(id: string, candidates: readonly TierCandidate[]): TierGroup {
  return { id, candidates: [...candidates] };
}

const NO_CLAIMS: ReadonlyMap<string, readonly TierClaim[]> = new Map();

describe("buildPatternPicker - ordering, hidden and rank rules", () => {
  it("text exactly matching a model's slug leads the list, before the pattern entry", () => {
    const entries = buildPatternPicker({
      query: "gpt-6-astra",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    // Falsification: drop the `exact` lookup in `buildPatternPicker` (the
    // `exact === null ? [...] : [modelEntry(exact), patternEntry, ...rest]`
    // branch) - the exact model would then sit wherever the catalog places
    // it, after the pattern entry, instead of leading.
    expect(entries[0]).toMatchObject({ kind: "model", exact: true });
    expect((entries[0].kind === "model" && entries[0].model.slug) || null).toBe(
      "gpt-6-astra",
    );
    expect(entries[1].kind).toBe("pattern");
  });

  it("text exactly matching a model's LABEL (not its slug) also leads", () => {
    const entries = buildPatternPicker({
      query: "GPT-6-Astra",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    expect(entries[0]).toMatchObject({ kind: "model", exact: true });
  });

  it("a typed `*` pattern is offered as written, with no 'contains' wording attached", () => {
    const entries = buildPatternPicker({
      query: "*astra*",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    const pattern = entries.find((entry) => entry.kind === "pattern");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    // Falsification: `pickerPatternFor` treating a typed `*` the same as a
    // plain word - `word` would then be non-null and the option would render
    // "Any model containing..." instead of the pattern verbatim.
    expect(pattern.word).toBeNull();
    expect(pattern.pattern).toBe("*astra*");
    expect(pattern.hidden).toBe(false);
  });

  it("a plain word of 3+ characters becomes a contains-pattern, offered as `*word*`", () => {
    const entries = buildPatternPicker({
      query: "luna",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    const pattern = entries.find((entry) => entry.kind === "pattern");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    // Falsification: `CONTAINS_MIN_LENGTH` changed to something other than 3,
    // or the `pickerPatternFor` word branch removed - "luna" (4 chars) would
    // then no longer produce a `*luna*` pattern entry.
    expect(pattern.word).toBe("luna");
    expect(pattern.pattern).toBe("*luna*");
    expect(pattern.hidden).toBe(false);
    expect(pattern.matches?.map((entry) => entry.slug)).toEqual([
      "gpt-6-luna",
      "gpt-6-luna-mini",
    ]);
  });

  it("a plain word shorter than 3 characters offers NO pattern (hidden) and narrows the model list instead", () => {
    const entries = buildPatternPicker({
      query: "so",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    const pattern = entries.find((entry) => entry.kind === "pattern");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    // Falsification: lowering CONTAINS_MIN_LENGTH to 2 - a two-letter word
    // would then also build a pattern, and this hidden flag would flip.
    expect(pattern.hidden).toBe(true);
    const sol = entries.find(
      (entry) => entry.kind === "model" && entry.model.slug === "gpt-6-sol",
    );
    expect(sol).toBeDefined();
    if (sol === undefined || sol.kind !== "model") return;
    expect(sol.hidden).toBe(false);
    const astra = entries.find(
      (entry) => entry.kind === "model" && entry.model.slug === "gpt-6-astra",
    );
    if (astra === undefined || astra.kind !== "model") return;
    // Falsification: the `hidden` computation on a model entry not checking
    // `pattern === null` first - astra (no "so" substring) would then stay
    // hidden=false under a pattern-offered path, when in fact no pattern is
    // offered here so narrowing applies and astra must be hidden.
    expect(astra.hidden).toBe(true);
  });

  it("with a pattern offered, every model stays visible (unmatched ones included) so the try order is visible", () => {
    const entries = buildPatternPicker({
      query: "*sol*",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    // Falsification: the `hidden` computation applying the narrowing rule
    // even when a pattern IS offered - astra (which does not match "*sol*")
    // would then be hidden instead of shown as unmatched.
    const astra = entries.find(
      (entry) => entry.kind === "model" && entry.model.slug === "gpt-6-astra",
    );
    expect(astra).toBeDefined();
    if (astra === undefined || astra.kind !== "model") return;
    expect(astra.hidden).toBe(false);
    expect(astra.matched).toBe(false);
    expect(astra.rank).toBeNull();
  });

  it("matches are numbered in catalog/try order, starting at 1", () => {
    const entries = buildPatternPicker({
      query: "*gpt-6*",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    const ranked = (slug: string): number | null => {
      const found = entries.find(
        (entry) => entry.kind === "model" && entry.model.slug === slug,
      );
      return found !== undefined && found.kind === "model" ? found.rank : null;
    };
    // Falsification: `tryable.indexOf(model)` computed against the full
    // catalog rather than the OWNER-FILTERED `tryable` list, or off by one -
    // astra/sol/luna/luna-mini all match "*gpt-6*" (terra does not, being
    // "gpt-5.6-terra") and must be numbered 1..4 in catalog order.
    expect(ranked("gpt-6-astra")).toBe(1);
    expect(ranked("gpt-6-sol")).toBe(2);
    expect(ranked("gpt-6-luna")).toBe(3);
    expect(ranked("gpt-6-luna-mini")).toBe(4);
    expect(ranked("gpt-5.6-terra")).toBeNull();
  });

  it("a model another tier owns is skipped in the try-order numbering, not counted as a step", () => {
    const claims: ReadonlyMap<string, readonly TierClaim[]> = new Map([
      ["gpt-6-sol", [{ tierIndex: 0, tierId: "flagship", candidateIndex: 0 }]],
    ]);
    const entries = buildPatternPicker({
      query: "*gpt-6*",
      models: CODEX_CATALOG,
      claims,
    });
    const ranked = (slug: string): number | null => {
      const found = entries.find(
        (entry) => entry.kind === "model" && entry.model.slug === slug,
      );
      return found !== undefined && found.kind === "model" ? found.rank : null;
    };
    // Falsification: numbering `tryable` off the raw `matches` list instead
    // of the owner-filtered one (the `tryable = matches.filter((model) =>
    // ownersOf(model).length === 0)` line) - sol would then take rank 2 and
    // luna would stay at 3 instead of moving up to 2.
    expect(ranked("gpt-6-astra")).toBe(1);
    expect(ranked("gpt-6-sol")).toBeNull();
    expect(ranked("gpt-6-luna")).toBe(2);
    expect(ranked("gpt-6-luna-mini")).toBe(3);
  });

  it("with no catalog answer (models: null), the pattern option's matches is null, not an empty array", () => {
    const entries = buildPatternPicker({
      query: "*astra*",
      models: null,
      claims: NO_CLAIMS,
    });
    const pattern = entries.find((entry) => entry.kind === "pattern");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    // Falsification: `models === null ? null : matches` collapsed to just
    // `matches` - a cold catalog would then read as "matches 0 models"
    // instead of "can't say".
    expect(pattern.matches).toBeNull();
  });

  it("a blank query offers the pattern hidden (nothing typed) and every catalog model visible", () => {
    const entries = buildPatternPicker({
      query: "",
      models: CODEX_CATALOG,
      claims: NO_CLAIMS,
    });
    const pattern = entries.find((entry) => entry.kind === "pattern");
    expect(pattern).toBeDefined();
    if (pattern === undefined) return;
    expect(pattern.hidden).toBe(true);
    for (const entry of entries) {
      if (entry.kind === "model") expect(entry.hidden).toBe(false);
    }
  });
});

describe("patternBlockedReason - wording", () => {
  function blocker(
    model: TierModelIdentity,
    owners: readonly TierClaim[],
  ): {
    readonly model: TierModelIdentity;
    readonly owners: readonly TierClaim[];
  } {
    return { model, owners };
  }

  it("one blocked model in one other tier", () => {
    const reason = patternBlockedReason([
      blocker(GPT_ASTRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
      ]),
    ]);
    expect(reason).toBe(
      "Can't use: GPT-6-Astra is in frontier. A model can be in only one tier.",
    );
  });

  it("two blocked models, joined with 'and'", () => {
    const reason = patternBlockedReason([
      blocker(GPT_ASTRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
      ]),
      blocker(GPT_SOL, [
        { tierIndex: 1, tierId: "flagship", candidateIndex: 0 },
      ]),
    ]);
    // Falsification: matches the exact wording pin the ticket calls out.
    expect(reason).toBe(
      "Can't use: GPT-6-Astra is in frontier and GPT-6-Sol is in flagship. A model can be in only one tier.",
    );
  });

  it("one model owned by TWO other tiers joins the owners with 'and'", () => {
    const reason = patternBlockedReason([
      blocker(GPT_ASTRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
        { tierIndex: 1, tierId: "flagship", candidateIndex: 0 },
      ]),
    ]);
    expect(reason).toBe(
      "Can't use: GPT-6-Astra is in frontier and flagship. A model can be in only one tier.",
    );
  });

  it("4+ blocked models: names the first 3 (BLOCKERS_NAMED), summarises the rest as 'N more models are in other tiers'", () => {
    const reason = patternBlockedReason([
      blocker(GPT_ASTRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
      ]),
      blocker(GPT_SOL, [
        { tierIndex: 1, tierId: "flagship", candidateIndex: 0 },
      ]),
      blocker(GPT_LUNA, [
        { tierIndex: 1, tierId: "flagship", candidateIndex: 1 },
      ]),
      blocker(GPT_TERRA, [
        { tierIndex: 2, tierId: "standard", candidateIndex: 0 },
      ]),
    ]);
    // Falsification: `BLOCKERS_NAMED` changed, or the plural/singular branch
    // in `patternBlockedReason` ("model is" vs "models are") flipped.
    expect(reason).toBe(
      "Can't use: GPT-6-Astra is in frontier, GPT-6-Sol is in flagship, GPT-6-Luna is in flagship and 1 more model is in other tiers. A model can be in only one tier.",
    );
  });

  it("5 blocked models: the trailing summary uses plural 'models are'", () => {
    const reason = patternBlockedReason([
      blocker(GPT_ASTRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
      ]),
      blocker(GPT_SOL, [
        { tierIndex: 1, tierId: "flagship", candidateIndex: 0 },
      ]),
      blocker(GPT_LUNA, [
        { tierIndex: 1, tierId: "flagship", candidateIndex: 1 },
      ]),
      blocker(GPT_LUNA_MINI, [
        { tierIndex: 2, tierId: "standard", candidateIndex: 0 },
      ]),
      blocker(GPT_TERRA, [
        { tierIndex: 2, tierId: "standard", candidateIndex: 1 },
      ]),
    ]);
    expect(reason).toBe(
      "Can't use: GPT-6-Astra is in frontier, GPT-6-Sol is in flagship, GPT-6-Luna is in flagship and 2 more models are in other tiers. A model can be in only one tier.",
    );
  });
});

describe("modelOwnedReason - wording", () => {
  it("one owner", () => {
    expect(
      modelOwnedReason(GPT_ASTRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
      ]),
    ).toBe("GPT-6-Astra is in frontier. A model can be in only one tier.");
  });

  it("blank tier id renders as its position ('tier N'), via tierDisplayName", () => {
    // Falsification: `modelOwnedReason` / `ownersPhrase` bypassing
    // `tierDisplayName` and interpolating `owner.tierId` raw - a blank id
    // would then render as an empty clause ("is in . A model...").
    expect(
      modelOwnedReason(GPT_ASTRA, [
        { tierIndex: 2, tierId: "", candidateIndex: 0 },
      ]),
    ).toBe("GPT-6-Astra is in tier 3. A model can be in only one tier.");
  });
});

describe("otherTierClaims", () => {
  it("finds a claim from another tier's row, keyed by lower-cased slug", () => {
    const groups: readonly TierGroup[] = [
      group("frontier", [candidate("codex", "*astra*")]),
      group("flagship", [candidate("codex", "")]),
    ];
    const claims = otherTierClaims({
      groups,
      groupIndex: 1,
      candidateIndex: 0,
      harnessId: "codex",
      catalog: CODEX_CATALOG,
    });
    const owners = claims.get("gpt-6-astra");
    expect(owners).toEqual([
      { tierIndex: 0, tierId: "frontier", candidateIndex: 0 },
    ]);
  });

  it("never counts another row of the SAME tier as a claim", () => {
    const groups: readonly TierGroup[] = [
      group("flagship", [candidate("codex", "*sol*"), candidate("codex", "")]),
    ];
    const claims = otherTierClaims({
      groups,
      groupIndex: 0,
      candidateIndex: 1,
      harnessId: "codex",
      catalog: CODEX_CATALOG,
    });
    // Falsification: `otherTierClaims`'s probe-based conflict search failing
    // to exclude `claim.tierIndex !== groupIndex` - sol would then show as
    // owned by its own tier's sibling row.
    expect(claims.get("gpt-6-sol")).toBeUndefined();
  });

  it("out-of-range groupIndex returns an empty map rather than throwing", () => {
    const groups: readonly TierGroup[] = [group("flagship", [])];
    const claims = otherTierClaims({
      groups,
      groupIndex: 5,
      candidateIndex: 0,
      harnessId: "codex",
      catalog: CODEX_CATALOG,
    });
    expect(claims.size).toBe(0);
  });
});

describe("rowConflictsFor - grouping by the set of other tiers", () => {
  function conflict(
    model: TierModelIdentity,
    tiers: TierConflict["tiers"],
  ): TierConflict {
    return { harnessId: "codex", model, tiers };
  }

  it("two models sharing the SAME set of other tiers group into one RowConflict", () => {
    const conflicts: readonly TierConflict[] = [
      conflict(GPT_SOL, [
        { tierIndex: 1, tierId: "flagship", candidateIndexes: [0] },
        { tierIndex: 2, tierId: "standard", candidateIndexes: [0] },
      ]),
      conflict(GPT_LUNA, [
        { tierIndex: 1, tierId: "flagship", candidateIndexes: [0] },
        { tierIndex: 2, tierId: "standard", candidateIndexes: [0] },
      ]),
    ];
    const grouped = rowConflictsFor(conflicts, 2, 0);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].models.map((entry) => entry.slug)).toEqual([
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(grouped[0].others).toEqual([
      { tierIndex: 1, tierId: "flagship", candidateIndex: 0 },
    ]);
  });

  it("two models with DIFFERENT other-tier sets produce two separate RowConflicts", () => {
    const conflicts: readonly TierConflict[] = [
      conflict(GPT_SOL, [
        { tierIndex: 1, tierId: "flagship", candidateIndexes: [0] },
        { tierIndex: 2, tierId: "standard", candidateIndexes: [0] },
      ]),
      conflict(GPT_TERRA, [
        { tierIndex: 0, tierId: "frontier", candidateIndexes: [0] },
        { tierIndex: 2, tierId: "standard", candidateIndexes: [0] },
      ]),
    ];
    const grouped = rowConflictsFor(conflicts, 2, 0);
    // Falsification: `rowConflictsFor`'s grouping key built from something
    // other than the sorted set of other tierIndexes (e.g. just the count) -
    // these two distinct other-tier sets would then collapse into one group.
    expect(grouped).toHaveLength(2);
  });

  it("a conflict not involving this row/candidate is excluded", () => {
    const conflicts: readonly TierConflict[] = [
      conflict(GPT_SOL, [
        { tierIndex: 0, tierId: "frontier", candidateIndexes: [0] },
        { tierIndex: 1, tierId: "flagship", candidateIndexes: [0] },
      ]),
    ];
    expect(rowConflictsFor(conflicts, 2, 0)).toEqual([]);
  });

  it("handler is the first-listed claimant (routing's own tiers[0])", () => {
    const conflicts: readonly TierConflict[] = [
      conflict(GPT_SOL, [
        { tierIndex: 0, tierId: "frontier", candidateIndexes: [0] },
        { tierIndex: 2, tierId: "standard", candidateIndexes: [0] },
      ]),
    ];
    const grouped = rowConflictsFor(conflicts, 2, 0);
    expect(grouped[0].handler).toEqual({ tierIndex: 0, tierId: "frontier" });
  });
});

describe("patternMatchCount / tierDisplayName", () => {
  it("counts catalog matches for a pattern", () => {
    expect(patternMatchCount("*gpt-6*", CODEX_CATALOG)).toBe(4);
  });

  it("returns null with no catalog to check", () => {
    expect(patternMatchCount("*gpt-6*", null)).toBeNull();
  });

  it("tierDisplayName: a named tier keeps its name; a blank one is 'tier N' (1-based)", () => {
    expect(tierDisplayName("flagship", 1)).toBe("flagship");
    // Falsification: `tierIndex + 1` dropped in favour of the raw index -
    // this would read "tier 2" instead of "tier 3" for index 2.
    expect(tierDisplayName("", 2)).toBe("tier 3");
    expect(tierDisplayName("   ", 0)).toBe("tier 1");
  });
});

describe("rowStatusLine", () => {
  const LABEL_FOR: FallbackSettingsProfileLabel = (profileId) =>
    `Account ${profileId}`;

  function preview(overrides: {
    readonly modelFamily: string;
    readonly resolvedModel: string | null;
    readonly profileId: string | null;
    readonly skipReason: string | null;
    readonly skipLabel: string | null;
    readonly warnings: readonly string[];
    readonly matches: readonly {
      readonly model: string;
      readonly profileId: string | null;
      readonly skipReason: string | null;
      readonly skipLabel: string | null;
    }[];
  }): TierCandidatePreview {
    return {
      groupId: "flagship",
      harnessId: "codex",
      candidateIndex: 0,
      reasoningEffort: null,
      modelFamily: overrides.modelFamily,
      resolvedModel: overrides.resolvedModel,
      profileId: overrides.profileId,
      skipReason: overrides.skipReason,
      skipLabel: overrides.skipLabel,
      warnings: [...overrides.warnings],
      matches: overrides.matches.map((match) => ({ ...match })),
    };
  }

  it("returns null for a blank row - already invalid, nothing to add", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", ""),
      preview: preview({
        modelFamily: "",
        resolvedModel: null,
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: [],
        matches: [],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line).toBeNull();
  });

  it("returns null with a null preview, even for a filled row", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*sol*"),
      preview: null,
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line).toBeNull();
  });

  it("returns null for an exact self-match with no warnings and no skip", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "gpt-6-sol"),
      preview: preview({
        modelFamily: "gpt-6-sol",
        resolvedModel: "gpt-6-sol",
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: [],
        matches: [
          {
            model: "gpt-6-sol",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
        ],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line).toBeNull();
  });

  it("an exact self-match WITH warnings degrades to a warnings-only line, not null", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "gpt-6-sol"),
      preview: preview({
        modelFamily: "gpt-6-sol",
        resolvedModel: "gpt-6-sol",
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: ["rate limited earlier"],
        matches: [
          {
            model: "gpt-6-sol",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
        ],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    // Falsification: the `namesItself` branch always returning `null`
    // regardless of `warnings.length` - warnings would then be silently
    // swallowed for a row that names its own model exactly.
    expect(line).toEqual({
      kind: "warnings",
      warnings: ["rate limited earlier"],
    });
  });

  it("family-unmatched with no matches: 'unmatched' kind, carries warnings", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*nope*"),
      preview: preview({
        modelFamily: "*nope*",
        resolvedModel: null,
        profileId: null,
        skipReason: "family-unmatched",
        skipLabel: "No match",
        warnings: ["low balance"],
        matches: [],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line).toEqual({ kind: "unmatched", warnings: ["low balance"] });
  });

  it("a non-family-unmatched skip reason with no matches: 'cannot-check', not red", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*sol*"),
      preview: preview({
        modelFamily: "*sol*",
        resolvedModel: null,
        profileId: null,
        skipReason: "provider-unavailable",
        skipLabel: "Provider unavailable",
        warnings: [],
        matches: [],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line).toEqual({
      kind: "cannot-check",
      reason: "Provider unavailable",
      warnings: [],
    });
  });

  it("a skip reason the client cannot parse falls back to 'not available' with no skipLabel", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*sol*"),
      preview: preview({
        modelFamily: "*sol*",
        resolvedModel: null,
        profileId: null,
        skipReason: "some-future-reason",
        skipLabel: null,
        warnings: [],
        matches: [],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line).toEqual({
      kind: "cannot-check",
      reason: "not available",
      warnings: [],
    });
  });

  it("tries: multiple matches produce steps, 'more' count, a lead when every skip shares a reason, and the account label of the first triable match", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*gpt-6*"),
      preview: preview({
        modelFamily: "*gpt-6*",
        resolvedModel: "gpt-6-sol",
        profileId: "acct-1",
        skipReason: null,
        skipLabel: null,
        warnings: ["earlier warning"],
        matches: [
          {
            model: "gpt-6-astra",
            profileId: null,
            skipReason: "rate-limited",
            skipLabel: "Rate limited",
          },
          {
            model: "gpt-6-sol",
            profileId: "acct-1",
            skipReason: null,
            skipLabel: null,
          },
          {
            model: "gpt-6-luna",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
          {
            model: "gpt-6-luna-mini",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
        ],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line?.kind).toBe("tries");
    if (line === null || line.kind !== "tries") return;
    // Falsification: `TRY_STEPS_NAMED` changed from 2, or `steps.slice` /
    // `more` math altered - this line names exactly 2 steps and reports 2
    // more (4 matches total).
    expect(line.steps).toHaveLength(2);
    expect(line.steps[0]).toEqual({
      model: "gpt-6-astra",
      label: "GPT-6-Astra",
      skipLabel: "Rate limited",
    });
    expect(line.more).toBe(2);
    // Falsification: `tried.profileId` resolved through the WRONG match (not
    // the first one with no skip) - astra is skipped, so the account must
    // come from sol, the first triable match.
    expect(line.account).toBe("Account acct-1");
    expect(line.warnings).toEqual(["earlier warning"]);
  });

  it("tries: a lead reason shared by every match hoists to `lead` and steps carry no per-step skipLabel", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*gpt-6*"),
      preview: preview({
        modelFamily: "*gpt-6*",
        resolvedModel: null,
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: [],
        matches: [
          {
            model: "gpt-6-astra",
            profileId: null,
            skipReason: "rate-limited",
            skipLabel: "Account rate limited",
          },
          {
            model: "gpt-6-sol",
            profileId: null,
            skipReason: "rate-limited",
            skipLabel: "Account rate limited",
          },
        ],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line?.kind).toBe("tries");
    if (line === null || line.kind !== "tries") return;
    // Falsification: `tryLine`'s `shared`/`lead` computation dropped, or the
    // "every skip equals the first" check loosened - this would leave `lead`
    // null and instead repeat "Account rate limited" on both steps.
    expect(line.lead).toBe("Account rate limited");
    expect(line.steps.every((step) => step.skipLabel === null)).toBe(true);
    expect(line.account).toBeNull();
  });

  it("a match's label falls back to the model id when the catalog doesn't know it", () => {
    const line = rowStatusLine({
      candidate: candidate("codex", "*gpt*"),
      preview: preview({
        modelFamily: "*gpt*",
        resolvedModel: "gpt-unknown-future",
        profileId: null,
        skipReason: null,
        skipLabel: null,
        warnings: [],
        matches: [
          {
            model: "gpt-unknown-future",
            profileId: null,
            skipReason: null,
            skipLabel: null,
          },
        ],
      }),
      models: CODEX_CATALOG,
      labelFor: LABEL_FOR,
    });
    expect(line?.kind).toBe("tries");
    if (line === null || line.kind !== "tries") return;
    expect(line.steps[0]).toEqual({
      model: "gpt-unknown-future",
      label: "gpt-unknown-future",
      skipLabel: null,
    });
  });
});
