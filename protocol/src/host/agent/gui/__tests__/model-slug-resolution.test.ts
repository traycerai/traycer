import { describe, expect, it } from "vitest";

import {
  aliasTieDisagreement,
  modelMatchIsCovered,
  modelResolvedModel,
  modelsForHarness,
  readableModelMatch,
  resolveModelBySlug,
} from "../model-slug-resolution";
import type { GuiAgentModelOption } from "../unary-schemas";

/**
 * Minimal row builder. Only the fields resolution actually reads matter
 * (slug, metadata.resolvedModel, harnessId); the rest are schema-shaped
 * placeholders so fixtures stay valid GuiAgentModelOption values.
 */
function model(
  partial: Pick<GuiAgentModelOption, "slug" | "harnessId"> & {
    resolvedModel?: string | null | undefined;
    metadata?: Record<string, unknown>;
    label?: string;
  },
): GuiAgentModelOption {
  const metadata: Record<string, unknown> = { ...(partial.metadata ?? {}) };
  if (partial.resolvedModel !== undefined) {
    if (partial.resolvedModel === null) {
      // Explicit absence: leave key out (or caller can put a non-string).
    } else {
      metadata.resolvedModel = partial.resolvedModel;
    }
  }
  return {
    harnessId: partial.harnessId,
    slug: partial.slug,
    label: partial.label ?? partial.slug,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata,
  };
}

/**
 * Real measured Claude catalog (5 rows). `default` and `opus[1m]` DUPLICATE
 * their resolvedModel — that duplication is why the ambiguous flag exists.
 */
const CLAUDE_CATALOG: readonly GuiAgentModelOption[] = [
  model({
    harnessId: "claude",
    slug: "default",
    resolvedModel: "claude-opus-5[1m]",
  }),
  model({
    harnessId: "claude",
    slug: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
  }),
  model({
    harnessId: "claude",
    slug: "claude-fable-5[1m]",
    resolvedModel: "claude-fable-5",
  }),
  model({
    harnessId: "claude",
    slug: "sonnet",
    resolvedModel: "claude-sonnet-5",
  }),
  model({
    harnessId: "claude",
    slug: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
  }),
];

/**
 * The same account's catalog before and after Claude CLI 2.1.282 dropped the
 * `[1m]` entitlement decoration, measured through the SDK's `supportedModels()`
 * on 2.1.280 and 2.1.284. Every slug below still runs on both CLIs; only the
 * row names differ.
 */
const CLAUDE_CLI_2_1_280_CATALOG: readonly GuiAgentModelOption[] = [
  model({
    harnessId: "claude",
    slug: "default",
    resolvedModel: "claude-opus-5-5[1m]",
  }),
  model({
    harnessId: "claude",
    slug: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
  }),
  model({
    harnessId: "claude",
    slug: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
  }),
  model({
    harnessId: "claude",
    slug: "sonnet",
    resolvedModel: "claude-sonnet-5",
  }),
];

const CLAUDE_CLI_2_1_284_CATALOG: readonly GuiAgentModelOption[] = [
  model({
    harnessId: "claude",
    slug: "default",
    resolvedModel: "claude-opus-5-5",
  }),
  model({
    harnessId: "claude",
    slug: "opus",
    resolvedModel: "claude-opus-5-5",
  }),
  model({
    harnessId: "claude",
    slug: "claude-fable-5-1",
    resolvedModel: "claude-fable-5-1",
  }),
  model({
    harnessId: "claude",
    slug: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
  }),
];

describe("resolveModelBySlug", () => {
  it("returns kind exact for an exact slug match", () => {
    const match = resolveModelBySlug(CLAUDE_CATALOG, "sonnet");
    expect(match).toEqual({
      kind: "exact",
      model: CLAUDE_CATALOG[3],
    });
  });

  it("resolves a canonical id to its decorated row via pass 2 (alias, unambiguous)", () => {
    const match = resolveModelBySlug(CLAUDE_CATALOG, "claude-fable-5");
    expect(match).toEqual({
      kind: "alias",
      model: CLAUDE_CATALOG[2],
      ambiguous: false,
      tied: [CLAUDE_CATALOG[2]],
    });
  });

  it("exact match beats alias even when a later slug equals an earlier resolvedModel", () => {
    // Load-bearing ordering, not a preference: pass 1 (exact slug) must win
    // over pass 2 (resolvedModel alias). Fixture: earlier row's resolvedModel
    // equals a later row's slug — exact on the later slug must return that
    // later row, not the earlier alias.
    const earlier = model({
      harnessId: "claude",
      slug: "pointer",
      resolvedModel: "shared-id",
    });
    const later = model({
      harnessId: "claude",
      slug: "shared-id",
      resolvedModel: "shared-id-wire",
    });
    const catalog = [earlier, later];

    const match = resolveModelBySlug(catalog, "shared-id");
    expect(match).toEqual({ kind: "exact", model: later });
    expect(match.kind === "exact" && match.model.slug).toBe("shared-id");
  });

  it("returns ambiguous alias when multiple rows share the same resolvedModel", () => {
    const match = resolveModelBySlug(CLAUDE_CATALOG, "claude-opus-5[1m]");
    expect(match.kind).toBe("alias");
    if (match.kind !== "alias") return;
    expect(match.ambiguous).toBe(true);
    expect(match.model).toBe(CLAUDE_CATALOG[0]); // first-in-catalog-order
    expect(match.tied).toEqual([CLAUDE_CATALOG[0], CLAUDE_CATALOG[1]]);
    expect(match.tied.map((row) => row.slug)).toEqual(["default", "opus[1m]"]);
  });

  it("DEFENSIVE: rows with no resolvedModel fall back to exact-only matching", () => {
    // Pins a defensive branch. All five rows in the measured Claude catalog
    // carried `resolvedModel` on both probed CLI versions, so no live catalog
    // exercises the absent-metadata path. Without the key, a canonical-id
    // lookup that would otherwise alias-match must return none.
    const bare = model({
      harnessId: "claude",
      slug: "bare-slug",
      // no resolvedModel key
    });
    const catalog = [bare];

    expect(resolveModelBySlug(catalog, "bare-slug")).toEqual({
      kind: "exact",
      model: bare,
    });
    // Canonical-looking input cannot alias-match without resolvedModel.
    expect(resolveModelBySlug(catalog, "some-canonical-id")).toEqual({
      kind: "none",
    });
  });

  it("resolves a persisted decorated slug against a catalog that dropped the marker", () => {
    // Persisted `opus[1m]` / `claude-fable-5-1[1m]` under CLI 2.1.280; the
    // catalog now lists `opus` / `claude-fable-5-1`. Neither pass 1 (slug gone)
    // nor pass 2 (resolvedModel is the canonical wire id) sees it, so pass 3
    // must, or the composer presents Default for a model that is still listed.
    const opus = resolveModelBySlug(CLAUDE_CLI_2_1_284_CATALOG, "opus[1m]");
    expect(opus).toEqual({
      kind: "alias",
      model: CLAUDE_CLI_2_1_284_CATALOG[1],
      ambiguous: false,
      tied: [CLAUDE_CLI_2_1_284_CATALOG[1]],
    });

    // The row matches on both its slug and its resolvedModel; it is one row,
    // so it must not read as a tie.
    const fable = resolveModelBySlug(
      CLAUDE_CLI_2_1_284_CATALOG,
      "claude-fable-5-1[1m]",
    );
    expect(fable).toEqual({
      kind: "alias",
      model: CLAUDE_CLI_2_1_284_CATALOG[2],
      ambiguous: false,
      tied: [CLAUDE_CLI_2_1_284_CATALOG[2]],
    });
  });

  it("resolves a persisted undecorated slug against a catalog that gained the marker", () => {
    // The forward direction of the same drift: `opus` persisted under a
    // catalog that listed it plain, resolved against one that lists `opus[1m]`.
    const match = resolveModelBySlug(CLAUDE_CLI_2_1_280_CATALOG, "opus");
    expect(match).toEqual({
      kind: "alias",
      model: CLAUDE_CLI_2_1_280_CATALOG[1],
      ambiguous: false,
      tied: [CLAUDE_CLI_2_1_280_CATALOG[1]],
    });
  });

  it("ties every row that shares the marker-less id", () => {
    // `default` and `opus` both publish `claude-opus-5-5`, so a persisted
    // `claude-opus-5-5[1m]` is ambiguous; first-in-catalog-order is only ever
    // a READ, exactly as for a pass-2 tie.
    const match = resolveModelBySlug(
      CLAUDE_CLI_2_1_284_CATALOG,
      "claude-opus-5-5[1m]",
    );
    expect(match.kind).toBe("alias");
    if (match.kind !== "alias") return;
    expect(match.ambiguous).toBe(true);
    expect(match.model).toBe(CLAUDE_CLI_2_1_284_CATALOG[0]);
    expect(match.tied.map((row) => row.slug)).toEqual(["default", "opus"]);
  });

  it("never lets the tier-tolerant pass override an exact or canonical-id match", () => {
    // Pass 1 beats pass 3: a catalog listing BOTH tiers resolves `opus[1m]` to
    // the `opus[1m]` row, not to the plain one that pass 3 would also accept.
    const plain = model({
      harnessId: "claude",
      slug: "opus",
      resolvedModel: "claude-opus-5-5",
    });
    const decorated = model({
      harnessId: "claude",
      slug: "opus[1m]",
      resolvedModel: "claude-opus-5-5[1m]",
    });
    expect(resolveModelBySlug([plain, decorated], "opus[1m]")).toEqual({
      kind: "exact",
      model: decorated,
    });

    // Pass 2 beats pass 3: `beta[1m]` is `pointer`'s canonical id, so the row
    // whose slug is merely `beta` (a pass-3 candidate) must not join or replace it.
    const pointer = model({
      harnessId: "claude",
      slug: "pointer",
      resolvedModel: "beta[1m]",
    });
    const bare = model({
      harnessId: "claude",
      slug: "beta",
      resolvedModel: "beta-wire",
    });
    expect(resolveModelBySlug([bare, pointer], "beta[1m]")).toEqual({
      kind: "alias",
      model: pointer,
      ambiguous: false,
      tied: [pointer],
    });
  });

  it("only folds the tier grammar, not any trailing bracket", () => {
    // `model[preview]` is a real id, and `[1mb]` has two unit letters; neither
    // is a tier marker, so neither may inherit `model`'s row.
    const catalog = [
      model({
        harnessId: "claude",
        slug: "model",
        resolvedModel: "model-wire",
      }),
    ];
    expect(resolveModelBySlug(catalog, "model[preview]")).toEqual({
      kind: "none",
    });
    expect(resolveModelBySlug(catalog, "model[1mb]")).toEqual({ kind: "none" });
    expect(resolveModelBySlug(catalog, "model[200k]").kind).toBe("alias");
  });

  it("never equates two different tier markers", () => {
    // A marker on only one side is the drift pass 3 exists for; markers on
    // both sides that disagree name two different tiers, so `opus[1m]` must
    // not borrow an `opus[200k]` row's details while the CLI still receives
    // `opus[1m]`. Checked on both fields a row can match on.
    const bySlug = [
      model({
        harnessId: "claude",
        slug: "opus[200k]",
        resolvedModel: "claude-opus-5-5-wire",
      }),
    ];
    expect(resolveModelBySlug(bySlug, "opus[1m]")).toEqual({ kind: "none" });

    const byResolvedModel = [
      model({
        harnessId: "claude",
        slug: "default",
        resolvedModel: "claude-opus-5-5[200k]",
      }),
    ];
    expect(resolveModelBySlug(byResolvedModel, "claude-opus-5-5[1m]")).toEqual({
      kind: "none",
    });

    // The grammar is case-insensitive, so a case-only difference is one tier.
    expect(resolveModelBySlug(bySlug, "opus[200K]").kind).toBe("alias");
  });

  it("returns none for an input that is nothing but a tier marker", () => {
    expect(resolveModelBySlug(CLAUDE_CLI_2_1_284_CATALOG, "[1m]")).toEqual({
      kind: "none",
    });
  });

  it("returns none for an empty slug", () => {
    expect(resolveModelBySlug(CLAUDE_CATALOG, "")).toEqual({ kind: "none" });
  });
});

describe("modelMatchIsCovered", () => {
  it("counts an alias match as covered, ambiguous or not, and none as uncovered", () => {
    // Coverage is "is this selection valid?", not "may I rewrite it?". A held
    // alias must still count as covered, or every downstream write keyed on
    // this answer is suppressed for a model that renders and runs fine.
    const exact = resolveModelBySlug(CLAUDE_CATALOG, "sonnet");
    expect(modelMatchIsCovered(exact)).toBe(true);

    const unambiguous = resolveModelBySlug(CLAUDE_CATALOG, "claude-fable-5");
    expect(unambiguous.kind).toBe("alias");
    expect(modelMatchIsCovered(unambiguous)).toBe(true);

    const ambiguous = resolveModelBySlug(CLAUDE_CATALOG, "claude-opus-5[1m]");
    expect(modelMatchIsCovered(ambiguous)).toBe(true);

    expect(modelMatchIsCovered({ kind: "none" })).toBe(false);
    expect(modelMatchIsCovered(resolveModelBySlug(CLAUDE_CATALOG, ""))).toBe(
      false,
    );
  });
});

describe("readableModelMatch", () => {
  it("returns the row even when the alias is ambiguous", () => {
    const ambiguous = resolveModelBySlug(CLAUDE_CATALOG, "claude-opus-5[1m]");
    expect(readableModelMatch(ambiguous)).toBe(CLAUDE_CATALOG[0]);

    const exact = resolveModelBySlug(CLAUDE_CATALOG, "haiku");
    expect(readableModelMatch(exact)).toBe(CLAUDE_CATALOG[4]);

    const unambiguous = resolveModelBySlug(CLAUDE_CATALOG, "claude-fable-5");
    expect(readableModelMatch(unambiguous)).toBe(CLAUDE_CATALOG[2]);

    expect(readableModelMatch({ kind: "none" })).toBeNull();
  });
});

describe("aliasTieDisagreement", () => {
  it("returns false when tied rows agree, true when they disagree, false for non-ambiguous", () => {
    const ambiguous = resolveModelBySlug(CLAUDE_CATALOG, "claude-opus-5[1m]");
    // Both default and opus[1m] share the same resolvedModel — agree on that.
    expect(
      aliasTieDisagreement(ambiguous, (row) => modelResolvedModel(row)),
    ).toBe(false);
    // Slugs differ — disagree.
    expect(aliasTieDisagreement(ambiguous, (row) => row.slug)).toBe(true);

    const exact = resolveModelBySlug(CLAUDE_CATALOG, "sonnet");
    expect(aliasTieDisagreement(exact, (row) => row.slug)).toBe(false);

    const none = resolveModelBySlug(CLAUDE_CATALOG, "");
    expect(aliasTieDisagreement(none, (row) => row.slug)).toBe(false);

    const unambiguous = resolveModelBySlug(CLAUDE_CATALOG, "claude-fable-5");
    expect(aliasTieDisagreement(unambiguous, (row) => row.slug)).toBe(false);
  });
});

describe("modelResolvedModel", () => {
  it("returns null for absent, non-string, and empty-string metadata values", () => {
    expect(
      modelResolvedModel(
        model({ harnessId: "claude", slug: "a" /* no key */ }),
      ),
    ).toBeNull();

    expect(
      modelResolvedModel(
        model({
          harnessId: "claude",
          slug: "b",
          metadata: { resolvedModel: 42 },
        }),
      ),
    ).toBeNull();

    expect(
      modelResolvedModel(
        model({
          harnessId: "claude",
          slug: "c",
          metadata: { resolvedModel: "" },
        }),
      ),
    ).toBeNull();

    expect(
      modelResolvedModel(
        model({
          harnessId: "claude",
          slug: "d",
          resolvedModel: "claude-sonnet-5",
        }),
      ),
    ).toBe("claude-sonnet-5");
  });
});

describe("modelsForHarness", () => {
  it("scopes a mixed-harness catalog", () => {
    const mixed: readonly GuiAgentModelOption[] = [
      model({
        harnessId: "claude",
        slug: "sonnet",
        resolvedModel: "claude-sonnet-5",
      }),
      model({
        harnessId: "codex",
        slug: "gpt-5",
        resolvedModel: "gpt-5",
      }),
      model({
        harnessId: "claude",
        slug: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
      }),
      model({
        harnessId: "grok",
        slug: "grok-4",
        resolvedModel: "grok-4",
      }),
    ];

    const claude = modelsForHarness(mixed, "claude");
    expect(claude.map((row) => row.slug)).toEqual(["sonnet", "haiku"]);
    expect(claude.every((row) => row.harnessId === "claude")).toBe(true);

    expect(modelsForHarness(mixed, "codex").map((row) => row.slug)).toEqual([
      "gpt-5",
    ]);
    expect(modelsForHarness(mixed, "missing")).toEqual([]);
  });
});
