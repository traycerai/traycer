import { describe, expect, it } from "vitest";
import {
  failedModelRoutingIdentity,
  findTierConflicts,
  findTierGroupForFailedTuple,
  modelMatchesPattern,
  routeTierGroupForFailedTuple,
  tierGroupsNameDestinationFor,
  type TierGroup,
  type TierModelIdentity,
} from "@traycer/protocol/host/fallback-policy";
import type { HarnessId } from "@traycer/protocol/host/agent/shared";
import {
  CLAUDE_CATALOG,
  CODEX_CATALOG,
  GROK_CATALOG,
  SEED_DEFAULT,
  SEED_GROUPS,
} from "./fallback-model-patterns-fixtures";

function id(slug: string, label: string): TierModelIdentity {
  return { slug, label };
}

function group(
  groupId: string,
  rows: readonly (readonly [HarnessId, string])[],
): TierGroup {
  return {
    id: groupId,
    candidates: rows.map(([harnessId, modelFamily]) => ({
      harnessId,
      modelFamily,
      reasoningEffort: null,
    })),
  };
}

// Old behaviour that fails these: modelMatchesPattern did not exist, so every
// case throws (or, for the whole-word matcher, `opus` matched `opus[1m]`).
describe("modelMatchesPattern", () => {
  const CASES: readonly (readonly [string, string, string, string, boolean])[] =
    [
      // [name, pattern, slug, label, expected]
      ["dot literal: exact", "gpt-5.5", "gpt-5.5", "x", true],
      ["dot literal: not any char", "gpt-5.5", "gpt-5x5", "x", false],
      ["brackets literal", "opus[1m]", "opus[1m]", "x", true],
      ["brackets are not a class", "opus[1m]", "opus1", "x", false],
      ["brackets are not a class (m)", "opus[1m]", "opusm", "x", false],
      ["parens literal", "a(b)", "a(b)", "x", true],
      ["parens are not a group", "a(b)", "ab", "x", false],
      ["plus literal", "a+", "a+", "x", true],
      ["plus is not a quantifier", "a+", "aaa", "x", false],
      ["question literal", "a?", "a?", "x", true],
      ["question is not optional", "a?", "a", "x", false],
      ["dollar literal", "a$", "a$", "x", true],
      ["dollar is not an anchor", "a$", "a", "x", false],
      ["caret literal", "^a", "^a", "x", true],
      ["caret is not an anchor", "^a", "a", "x", false],
      ["pipe literal", "a|b", "a|b", "x", true],
      ["pipe is not alternation", "a|b", "a", "x", false],
      ["backslash literal", "a\\d", "a\\d", "x", true],
      ["backslash is not an escape", "a\\d", "a1", "x", false],
      ["star alone matches a slug", "*", "anything", "x", true],
      ["star alone matches an empty-ish slug", "*", "a", "", true],
      [
        "opus without star is exact: not opus[1m]",
        "opus",
        "opus[1m]",
        "y",
        false,
      ],
      ["opus exact matches opus", "opus", "opus", "y", true],
      ["*opus* contains", "*opus*", "opus[1m]", "y", true],
      ["*opus is a suffix anchor: ends", "*opus", "claude-opus", "y", true],
      [
        "*opus is a suffix anchor: not followed",
        "*opus",
        "opus[1m]",
        "y",
        false,
      ],
      ["opus* is a prefix anchor: starts", "opus*", "opus[1m]", "y", true],
      [
        "opus* is a prefix anchor: not preceded",
        "opus*",
        "claude-opus",
        "y",
        false,
      ],
      ["case in pattern", "*OPUS*", "opus[1m]", "y", true],
      ["case in subject slug", "*opus*", "OPUS[1M]", "y", true],
      ["case in subject label", "*opus*", "x", "Some OPUS", true],
      ["label-only match", "*opus*", "default", "Default (Opus 5.5)", true],
      ["label whole exact", "sonnet 5", "sonnet", "Sonnet 5", true],
      ["label is whole, not a substring", "sonnet", "x", "Sonnet 5", false],
      ["overlap: aa*aa needs 4 chars, 3 given", "aa*aa", "aaa", "x", false],
      ["overlap: aa*aa with 4 chars", "aa*aa", "aaaa", "x", true],
      ["double star behaves as one", "a**b", "ab", "x", true],
      ["double star spans", "a**b", "axxb", "x", true],
      ["double star still anchored", "a**b", "axxc", "x", false],
      ["blank pattern matches nothing", "", "a", "b", false],
      ["whitespace pattern matches nothing", "   ", "a", "b", false],
      ["whitespace-only against blank subject", " ", "", "", false],
      ["surrounding whitespace ignored", "  gpt-5.5  ", "gpt-5.5", "x", true],
      [
        "surrounding whitespace ignored with star",
        " *opus* ",
        "opus",
        "x",
        true,
      ],
      ["no word boundary: *pi* in copilot", "*pi*", "copilot", "x", true],
      ["interior pieces placed in order", "a*b*c", "abc", "x", true],
      ["interior pieces out of order", "a*b*c", "acb", "x", false],
      ["middle piece must not overrun the suffix", "a*bc*c", "abc", "x", false],
    ];

  it("has a fixed table size", () => {
    expect(CASES).toHaveLength(48);
  });

  it.each(CASES)("%s", (_name, pattern, slug, label, expected) => {
    expect(modelMatchesPattern(pattern, id(slug, label))).toBe(expected);
  });

  it("`*` alone matches every model in all three catalogs", () => {
    const all = [...CLAUDE_CATALOG, ...CODEX_CATALOG, ...GROK_CATALOG];
    expect(all).toHaveLength(16);
    expect(all.map((entry) => modelMatchesPattern("*", entry))).toEqual(
      all.map(() => true),
    );
  });

  describe("catastrophic-backtracking patterns", () => {
    const hostile = id(`${"a".repeat(100_000)}!`, `${"a".repeat(100_000)}!`);

    it("(a+)+$ against a long subject is false and prompt", () => {
      const started = performance.now();
      expect(modelMatchesPattern("(a+)+$", hostile)).toBe(false);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("(a+)+$ is a literal: it matches the slug (A+)+$ and nothing looser", () => {
      expect(modelMatchesPattern("(a+)+$", id("(A+)+$", "x"))).toBe(true);
      expect(modelMatchesPattern("(a+)+$", id("aaaa", "x"))).toBe(false);
    });

    it("*a*a*a*a*a*a*a*a*b against a long subject is false and prompt", () => {
      const started = performance.now();
      expect(modelMatchesPattern("*a*a*a*a*a*a*a*a*b", hostile)).toBe(false);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("the same star pattern matches when a `b` is present", () => {
      expect(
        modelMatchesPattern(
          "*a*a*a*a*a*a*a*a*b",
          id(`${"a".repeat(100)}b`, "x"),
        ),
      ).toBe(true);
    });
  });
});

// Old behaviour that fails these: dropping `.toLowerCase()` on either side of
// the catalog lookup makes a differently-cased slug fail to match, so
// "DEFAULT" against a catalog storing "default" would fall through to the
// id-only label instead of finding the entry.
describe("failedModelRoutingIdentity", () => {
  it("matches the catalog label case-insensitively, keeping the slug as passed", () => {
    const identity = failedModelRoutingIdentity("DEFAULT", [
      id("default", "Default (Opus 5.5)"),
    ]);
    expect(identity).toEqual({ slug: "DEFAULT", label: "Default (Opus 5.5)" });
  });

  it("a null catalog gives the model itself as the label", () => {
    expect(failedModelRoutingIdentity("gpt-6-sol", null)).toEqual({
      slug: "gpt-6-sol",
      label: "gpt-6-sol",
    });
  });

  it("an unlisted model gives the model itself as the label", () => {
    expect(failedModelRoutingIdentity("unknown-model", CODEX_CATALOG)).toEqual({
      slug: "unknown-model",
      label: "unknown-model",
    });
  });
});

type RouterRow = {
  readonly slug: string;
  readonly found: string | null;
  readonly routed: string | null;
};

function expectRouter(
  harnessId: HarnessId,
  catalog: readonly TierModelIdentity[],
  catalogArg: readonly TierModelIdentity[] | null,
  expected: readonly RouterRow[],
): void {
  expect(expected).toHaveLength(catalog.length);
  expect(catalog.map((entry) => entry.slug)).toEqual(
    expected.map((row) => row.slug),
  );
  const actual = catalog.map((entry): RouterRow => {
    const found = findTierGroupForFailedTuple(
      SEED_GROUPS,
      harnessId,
      entry.slug,
      catalogArg,
    );
    const routed = routeTierGroupForFailedTuple({
      groups: SEED_GROUPS,
      defaultTierGroupId: SEED_DEFAULT,
      harnessId,
      model: entry.slug,
      catalog: catalogArg,
    });
    return {
      slug: entry.slug,
      found: found === null ? null : found.id,
      routed: routed === null ? null : routed.id,
    };
  });
  expect(actual).toEqual(expected);
}

// Old behaviour that fails these: family words never matched a `*opus*` row
// (whole-word compare against the slug), 4-arg calls had no catalog, and
// `default` could not reach flagship through its label.
describe("router table over the live catalogs (seed)", () => {
  it("claude with the catalog", () => {
    expectRouter("claude", CLAUDE_CATALOG, CLAUDE_CATALOG, [
      { slug: "default", found: "flagship", routed: "flagship" },
      { slug: "opus[1m]", found: "flagship", routed: "flagship" },
      { slug: "claude-fable-5-1[1m]", found: "frontier", routed: "frontier" },
      { slug: "sonnet", found: "standard", routed: "standard" },
      { slug: "haiku", found: null, routed: "flagship" },
    ]);
  });

  it("claude with a null catalog is ID-only: default falls to the default group", () => {
    expectRouter("claude", CLAUDE_CATALOG, null, [
      { slug: "default", found: null, routed: "flagship" },
      { slug: "opus[1m]", found: "flagship", routed: "flagship" },
      { slug: "claude-fable-5-1[1m]", found: "frontier", routed: "frontier" },
      { slug: "sonnet", found: "standard", routed: "standard" },
      { slug: "haiku", found: null, routed: "flagship" },
    ]);
  });

  const codexExpected: readonly RouterRow[] = [
    { slug: "gpt-6-astra", found: "frontier", routed: "frontier" },
    { slug: "gpt-6-sol", found: "flagship", routed: "flagship" },
    { slug: "gpt-6-luna", found: null, routed: "flagship" },
    { slug: "gpt-5.6-sol", found: "flagship", routed: "flagship" },
    { slug: "gpt-5.6-terra", found: "standard", routed: "standard" },
    { slug: "gpt-5.6-luna", found: null, routed: "flagship" },
    { slug: "gpt-5.5", found: null, routed: "flagship" },
  ];

  it("codex with the catalog", () => {
    expectRouter("codex", CODEX_CATALOG, CODEX_CATALOG, codexExpected);
  });

  it("codex with a null catalog answers the same", () => {
    expectRouter("codex", CODEX_CATALOG, null, codexExpected);
  });

  const grokExpected: readonly RouterRow[] = GROK_CATALOG.map((entry) => ({
    slug: entry.slug,
    found: "flagship",
    routed: "flagship",
  }));

  it("grok: every model is flagship, with and without a catalog", () => {
    expectRouter("grok", GROK_CATALOG, GROK_CATALOG, grokExpected);
    expectRouter("grok", GROK_CATALOG, null, grokExpected);
  });

  it("with no default, an unlisted model routes nowhere (positive control: listed still routes)", () => {
    const route = (model: string): string | null => {
      const routed = routeTierGroupForFailedTuple({
        groups: SEED_GROUPS,
        defaultTierGroupId: null,
        harnessId: "codex",
        model,
        catalog: null,
      });
      return routed === null ? null : routed.id;
    };
    expect(route("gpt-5.5")).toBeNull();
    expect(route("gpt-6-sol")).toBe("flagship");
  });
});

describe("first-listed group wins (D128 most-specific rule retired)", () => {
  const broad = group("broad", [["codex", "*gpt*"]]);
  const narrow = group("narrow", [["codex", "gpt-5.6-terra"]]);

  it("the first of two matching groups handles the model", () => {
    expect(
      findTierGroupForFailedTuple(
        [broad, narrow],
        "codex",
        "gpt-5.6-terra",
        null,
      )?.id,
    ).toBe("broad");
  });

  it("reversing the list flips the answer", () => {
    expect(
      findTierGroupForFailedTuple(
        [narrow, broad],
        "codex",
        "gpt-5.6-terra",
        null,
      )?.id,
    ).toBe("narrow");
  });

  it("a group listed later still owns what only it matches", () => {
    expect(
      findTierGroupForFailedTuple([narrow, broad], "codex", "gpt-5.5", null)
        ?.id,
    ).toBe("broad");
  });

  it("routing follows the same first-listed rule", () => {
    expect(
      routeTierGroupForFailedTuple({
        groups: [broad, narrow],
        defaultTierGroupId: "narrow",
        harnessId: "codex",
        model: "gpt-5.6-terra",
        catalog: null,
      })?.id,
    ).toBe("broad");
  });
});

describe("findTierGroupForFailedTuple: harness and catalog identity", () => {
  const groups = [group("g", [["claude", "*opus*"]])];

  it("a harness mismatch never matches (positive control: the right harness does)", () => {
    expect(
      findTierGroupForFailedTuple(groups, "claude", "opus[1m]", null)?.id,
    ).toBe("g");
    expect(
      findTierGroupForFailedTuple(groups, "codex", "opus[1m]", null),
    ).toBeNull();
  });

  it("a catalog slug differing in case still supplies the label", () => {
    const shouting: readonly TierModelIdentity[] = [
      id("DEFAULT", "Default (Opus 5.5)"),
    ];
    expect(
      findTierGroupForFailedTuple(groups, "claude", "default", shouting)?.id,
    ).toBe("g");
    expect(
      findTierGroupForFailedTuple(groups, "claude", "default", null),
    ).toBeNull();
  });

  it("a catalog with no entry for the ID falls back to ID-only", () => {
    expect(
      findTierGroupForFailedTuple(groups, "claude", "default", [
        id("sonnet", "Sonnet 5"),
      ]),
    ).toBeNull();
  });
});

// Old behaviour that fails these: the function took no catalog and asked a
// whole-word family question, so wildcard rows / labels were never considered.
describe("tierGroupsNameDestinationFor", () => {
  const call = (
    groups: readonly TierGroup[],
    harnessId: HarnessId,
    model: string,
    catalog: readonly TierModelIdentity[] | null,
    defaultTierGroupId: string | null,
  ): boolean =>
    tierGroupsNameDestinationFor({
      groups,
      defaultTierGroupId,
      harnessId,
      model,
      catalog,
    });

  it("a wildcard row with no catalog over-offers", () => {
    expect(
      call(
        [group("g", [["claude", "*opus*"]])],
        "claude",
        "opus[1m]",
        null,
        null,
      ),
    ).toBe(true);
  });

  it("*opus* for a failed `default` reaches opus[1m] with the Claude catalog", () => {
    expect(
      call(
        [group("g", [["claude", "*opus*"]])],
        "claude",
        "default",
        CLAUDE_CATALOG,
        null,
      ),
    ).toBe(true);
  });

  it("a pattern reaching only the failed model, with a catalog, does not count", () => {
    expect(
      call(
        [group("g", [["claude", "*haiku*"]])],
        "claude",
        "haiku",
        CLAUDE_CATALOG,
        null,
      ),
    ).toBe(false);
  });

  it("an exact pick of the failed model with no catalog does not count", () => {
    expect(
      call([group("g", [["claude", "haiku"]])], "claude", "haiku", null, null),
    ).toBe(false);
  });

  it("another harness's row always counts", () => {
    expect(
      call(
        [
          group("g", [
            ["claude", "haiku"],
            ["codex", "gpt-5.5"],
          ]),
        ],
        "claude",
        "haiku",
        CLAUDE_CATALOG,
        null,
      ),
    ).toBe(true);
  });

  it("a row matching nothing still counts", () => {
    expect(
      call(
        [
          group("g", [
            ["claude", "haiku"],
            ["claude", "*nonesuch*"],
          ]),
        ],
        "claude",
        "haiku",
        CLAUDE_CATALOG,
        null,
      ),
    ).toBe(true);
  });

  it("routes through the default group for an unlisted model", () => {
    const groups = [
      group("own", [["claude", "sonnet"]]),
      group("fallback", [["codex", "gpt-5.5"]]),
    ];
    expect(call(groups, "claude", "haiku", null, "fallback")).toBe(true);
    expect(call(groups, "claude", "haiku", null, null)).toBe(false);
  });

  it("empty groups name nothing, default or not", () => {
    expect(call([], "claude", "haiku", null, null)).toBe(false);
    expect(call([], "claude", "haiku", CLAUDE_CATALOG, "ghost")).toBe(false);
  });
});

// Old behaviour that fails these: findTierConflicts did not exist.
describe("findTierConflicts", () => {
  const CATALOGS: ReadonlyMap<HarnessId, readonly TierModelIdentity[]> =
    new Map([
      ["claude", CLAUDE_CATALOG],
      ["codex", CODEX_CATALOG],
      ["grok", GROK_CATALOG],
    ]);

  it("the seed has zero conflicts across the three catalogs", () => {
    expect(findTierConflicts(SEED_GROUPS, CATALOGS)).toEqual([]);
  });

  it("*gpt* in A and exact gpt-5.6-terra in B is one conflict on Terra, routed to A", () => {
    const groups = [
      group("A", [["codex", "*gpt*"]]),
      group("B", [["codex", "gpt-5.6-terra"]]),
    ];
    const conflicts = findTierConflicts(groups, CATALOGS);
    expect(conflicts).toHaveLength(1);
    const [only] = conflicts;
    expect(only.harnessId).toBe("codex");
    expect(only.model.slug).toBe("gpt-5.6-terra");
    expect(only.tiers).toEqual([
      { tierIndex: 0, tierId: "A", candidateIndexes: [0] },
      { tierIndex: 1, tierId: "B", candidateIndexes: [0] },
    ]);
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

  it("a same-tier repeat is not a conflict, but the clean case is positive-controlled", () => {
    const repeat = [
      group("A", [
        ["codex", "*terra*"],
        ["codex", "gpt-5.6-terra"],
      ]),
    ];
    expect(findTierConflicts(repeat, CATALOGS)).toEqual([]);
    const split = [
      group("A", [
        ["codex", "*terra*"],
        ["codex", "gpt-5.6-terra"],
      ]),
      group("B", [["codex", "gpt-5.6-terra"]]),
    ];
    const conflicts = findTierConflicts(split, CATALOGS);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].tiers[0].candidateIndexes).toEqual([0, 1]);
    expect(conflicts[0].tiers[1].candidateIndexes).toEqual([0]);
  });

  it("three tiers on one model give one conflict with three claims", () => {
    const groups = [
      group("A", [["codex", "*gpt*"]]),
      group("B", [["codex", "*terra*"]]),
      group("C", [["codex", "gpt-5.6-terra"]]),
    ];
    const terra = findTierConflicts(groups, CATALOGS).filter(
      (conflict) => conflict.model.slug === "gpt-5.6-terra",
    );
    expect(terra).toHaveLength(1);
    expect(terra[0].tiers.map((claim) => claim.tierId)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("a `*` row claims every model of that provider", () => {
    const groups = [
      group("A", [["grok", "*"]]),
      group("B", [["grok", "grok-4.5"]]),
    ];
    const conflicts = findTierConflicts(groups, CATALOGS);
    expect(conflicts.map((c) => c.model.slug)).toEqual(["grok-4.5"]);
    const all = findTierConflicts(
      [group("A", [["grok", "*"]]), group("B", [["grok", "*"]])],
      CATALOGS,
    );
    expect(all.map((c) => c.model.slug)).toEqual(
      GROK_CATALOG.map((entry) => entry.slug),
    );
  });

  it("a label-only conflict: *opus* against exact `default`", () => {
    const groups = [
      group("A", [["claude", "*sonnet*"]]),
      group("B", [["claude", "*opus*"]]),
      group("C", [["claude", "default"]]),
    ];
    const conflicts = findTierConflicts(groups, CATALOGS);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].model.slug).toBe("default");
    expect(conflicts[0].tiers.map((claim) => claim.tierId)).toEqual(["B", "C"]);
    expect(conflicts[0].tiers.map((claim) => claim.tierIndex)).toEqual([1, 2]);
  });

  it("an absent catalog contributes nothing (positive control: present one does)", () => {
    const groups = [
      group("A", [["codex", "*gpt*"]]),
      group("B", [["codex", "gpt-5.5"]]),
    ];
    expect(findTierConflicts(groups, new Map())).toEqual([]);
    expect(
      findTierConflicts(groups, new Map([["claude", CLAUDE_CATALOG]])),
    ).toEqual([]);
    expect(findTierConflicts(groups, CATALOGS)).toHaveLength(1);
  });

  it("orders by first appearance of the harness, then catalog order", () => {
    const groups = [
      group("A", [
        ["grok", "*"],
        ["codex", "*"],
      ]),
      group("B", [
        ["codex", "*"],
        ["grok", "*"],
      ]),
    ];
    const conflicts = findTierConflicts(groups, CATALOGS);
    expect(conflicts).toHaveLength(GROK_CATALOG.length + CODEX_CATALOG.length);
    expect(conflicts.map((c) => `${c.harnessId}:${c.model.slug}`)).toEqual([
      ...GROK_CATALOG.map((entry) => `grok:${entry.slug}`),
      ...CODEX_CATALOG.map((entry) => `codex:${entry.slug}`),
    ]);
  });

  it("`model` is the catalog entry object itself", () => {
    const groups = [
      group("A", [["codex", "*gpt*"]]),
      group("B", [["codex", "gpt-5.5"]]),
    ];
    const conflicts = findTierConflicts(groups, CATALOGS);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].model).toBe(CODEX_CATALOG[6]);
  });
});
