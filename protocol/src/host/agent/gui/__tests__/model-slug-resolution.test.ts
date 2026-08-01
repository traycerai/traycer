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

  it("returns none for a persisted decorated slug whose decoration later changed", () => {
    // KNOWN, deliberately-unfixed gap — not a bug to "fix".
    // Persisted "opus[1m]" when the catalog used to offer that decorated slug;
    // catalog now offers undecorated "opus" with resolvedModel "claude-opus-5".
    // Exact fails (slug gone). Alias fails (resolvedModel is the canonical
    // wire id, not the old decorated slug). Resolution returns none.
    const evolvedCatalog = [
      model({
        harnessId: "claude",
        slug: "opus",
        resolvedModel: "claude-opus-5",
      }),
    ];
    expect(resolveModelBySlug(evolvedCatalog, "opus[1m]")).toEqual({
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
