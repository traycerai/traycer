import { describe, expect, it } from "vitest";
import {
  buildAllHarnessModelRows,
  buildHarnessModelRows,
  createModelRowSearchIndex,
  filterModelRows,
  flattenModelRowSections,
  sectionModelRowsByProviderRank,
  selectedModelRowId,
} from "@/components/home/data/harness-model-search";
import {
  findModelLabel,
  type HarnessModelSelection,
  type HarnessOption,
  type ModelOption,
} from "@/components/home/data/landing-options";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";

const CODEX_HARNESS: HarnessOption = {
  id: "codex",
  label: "Codex",
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
};

const CLAUDE_HARNESS: HarnessOption = {
  id: "claude",
  label: "Claude",
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
};

const OPENCODE_HARNESS: HarnessOption = {
  id: "opencode",
  label: "OpenCode",
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
};

function model(overrides: Partial<ModelOption>): ModelOption {
  const base: ModelOption = {
    harnessId: "codex",
    slug: "gpt-test",
    label: "GPT Test",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
  return {
    ...base,
    ...overrides,
    metadata: overrides.metadata ?? base.metadata,
  };
}

describe("harness model search", () => {
  it("yields one concrete row per model with the preferred model first", () => {
    const rows = buildHarnessModelRows(CODEX_HARNESS, [
      model({ slug: "gpt-5.5", label: "GPT-5.5" }),
      model({ slug: "gpt-5.3-codex", label: "GPT-5.3 Codex" }),
    ]);

    expect(rows.map((row) => row.label)).toEqual(["GPT-5.5", "GPT-5.3 Codex"]);
    expect(rows[0]).toMatchObject({
      id: "codex:gpt-5.5",
      value: "gpt-5.5",
    });
  });

  it("resolves selections to concrete rows, falling back to the preferred model", () => {
    const models = [
      model({ slug: "gpt-5.5", label: "GPT-5.5" }),
      model({ slug: "gpt-5.3-codex", label: "GPT-5.3 Codex" }),
    ];
    const rows = buildHarnessModelRows(CODEX_HARNESS, models);
    const emptySelection: HarnessModelSelection = {
      harnessId: "codex",
      modelSlug: "",
    };
    const concreteSelection: HarnessModelSelection = {
      harnessId: "codex",
      modelSlug: "gpt-5.3-codex",
    };

    // Empty slug resolves to the first (preferred) model's row.
    expect(selectedModelRowId(emptySelection, rows)).toBe("codex:gpt-5.5");
    expect(selectedModelRowId(concreteSelection, rows)).toBe(
      "codex:gpt-5.3-codex",
    );
  });

  it("preserves provider and model order for empty queries", () => {
    const rows = buildAllHarnessModelRows([
      {
        harness: CODEX_HARNESS,
        models: [
          model({ slug: "gpt-5.5", label: "GPT-5.5" }),
          model({ slug: "gpt-5.4", label: "GPT-5.4" }),
        ],
      },
      {
        harness: CLAUDE_HARNESS,
        models: [
          model({
            harnessId: "claude",
            slug: "claude-sonnet-4-6",
            label: "Claude Sonnet 4.6",
          }),
        ],
      },
    ]);
    const searchIndex = createModelRowSearchIndex(rows);

    expect(
      filterModelRows(rows, searchIndex, "").map((row) => [
        row.harnessId,
        row.label,
      ]),
    ).toEqual([
      ["codex", "GPT-5.5"],
      ["codex", "GPT-5.4"],
      ["claude", "Claude Sonnet 4.6"],
    ]);
  });

  it("searches the supplied rows with fuzzy ranking", () => {
    const rows = buildAllHarnessModelRows([
      {
        harness: CODEX_HARNESS,
        models: [
          model({ slug: "gpt-5.5", label: "GPT-5.5" }),
          model({ slug: "gpt-4.1", label: "GPT-4.1" }),
        ],
      },
      {
        harness: CLAUDE_HARNESS,
        models: [
          model({
            harnessId: "claude",
            slug: "claude-opus-4-7",
            label: "Claude Opus 4.7",
          }),
          model({
            harnessId: "claude",
            slug: "claude-sonnet-4-6",
            label: "Claude Sonnet 4.6",
          }),
        ],
      },
    ]);
    const searchIndex = createModelRowSearchIndex(rows);

    expect(
      filterModelRows(rows, searchIndex, "sonet").map((row) => row.label),
    ).toEqual(["Claude Sonnet 4.6"]);
  });

  it("searches within an active provider when indexed from provider rows", () => {
    const rows = buildAllHarnessModelRows([
      {
        harness: CODEX_HARNESS,
        models: [
          model({ slug: "gpt-4.1", label: "GPT-4.1" }),
          model({ slug: "gpt-5.5", label: "GPT-5.5" }),
        ],
      },
      {
        harness: CLAUDE_HARNESS,
        models: [
          model({
            harnessId: "claude",
            slug: "claude-opus-4-7",
            label: "Claude Opus 4.7",
          }),
        ],
      },
    ]);
    const providerRows = rows.filter((row) => row.harnessId === "codex");
    const searchIndex = createModelRowSearchIndex(providerRows);

    expect(
      filterModelRows(providerRows, searchIndex, "opus").map(
        (row) => row.label,
      ),
    ).toEqual([]);
  });

  it("matches OpenCode rows by internal provider id and model slug", () => {
    const rows = buildHarnessModelRows(OPENCODE_HARNESS, [
      model({
        harnessId: "opencode",
        slug: "github-copilot:gpt-5.5",
        label: "GitHub Copilot: GPT-5.5",
        metadata: {
          openCodeProviderId: "github-copilot",
          openCodeProviderLabel: "GitHub Copilot",
        },
      }),
      model({
        harnessId: "opencode",
        slug: "anthropic:claude-sonnet-4-5",
        label: "Anthropic: Claude Sonnet 4.5",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
    ]);
    const searchIndex = createModelRowSearchIndex(rows);

    expect(
      filterModelRows(rows, searchIndex, "anthropic").map((row) => row.label),
    ).toEqual(["Anthropic: Claude Sonnet 4.5"]);
    expect(
      filterModelRows(rows, searchIndex, "sonet").map((row) => row.label),
    ).toEqual(["Anthropic: Claude Sonnet 4.5"]);
  });

  it("groups OpenCode models by provider with stripped browse labels", () => {
    const models = [
      model({
        harnessId: "opencode",
        slug: "opencode:zen-default",
        label: "OpenCode Zen: Default",
        metadata: {
          openCodeProviderId: "opencode",
          openCodeProviderLabel: "OpenCode Zen",
        },
      }),
      model({
        harnessId: "opencode",
        slug: "perplexity:sonar-pro",
        label: "Perplexity: Sonar Pro",
        metadata: {
          openCodeProviderId: "perplexity",
          openCodeProviderLabel: "Perplexity",
        },
      }),
      model({
        harnessId: "opencode",
        slug: "anthropic:claude",
        label: "Anthropic: Claude",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
      model({
        harnessId: "opencode",
        slug: "perplexity:sonar",
        label: "Perplexity: Sonar",
        metadata: {
          openCodeProviderId: "perplexity",
          openCodeProviderLabel: "Perplexity",
        },
      }),
    ];
    const rows = buildHarnessModelRows(OPENCODE_HARNESS, models);

    // Concrete rows sort by provider label (Anthropic < OpenCode Zen <
    // Perplexity), then model name (Sonar < Sonar Pro). browseLabel drops the
    // provider prefix that the group header now carries.
    expect(
      rows.map((row) => [row.providerGroupLabel, row.browseLabel]),
    ).toEqual([
      ["Anthropic", "Claude"],
      ["OpenCode Zen", "Default"],
      ["Perplexity", "Sonar"],
      ["Perplexity", "Sonar Pro"],
    ]);
    // The full provider-qualified label is preserved for search.
    expect(rows[0]?.label).toBe("Anthropic: Claude");
    // The collapsed picker trigger uses only the model name because the
    // provider is represented by the icon / picker grouping.
    expect(
      findModelLabel(models, {
        harnessId: "opencode",
        modelSlug: "anthropic:claude",
      }),
    ).toBe("Claude");
  });

  it("makes provider-section ranking explicit for grouped search results", () => {
    const rows = buildHarnessModelRows(OPENCODE_HARNESS, [
      model({
        harnessId: "opencode",
        slug: "anthropic:claude-sonnet",
        label: "Anthropic: Claude Sonnet",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
      model({
        harnessId: "opencode",
        slug: "perplexity:sonar",
        label: "Perplexity: Sonar",
        metadata: {
          openCodeProviderId: "perplexity",
          openCodeProviderLabel: "Perplexity",
        },
      }),
      model({
        harnessId: "opencode",
        slug: "anthropic:claude-opus",
        label: "Anthropic: Claude Opus",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
    ]);
    const rankedRows = [rows[2], rows[0], rows[1]];
    const sections = sectionModelRowsByProviderRank(rankedRows);

    expect(
      sections.map((section) => [
        section.providerGroupLabel,
        section.rows.map((row) => row.browseLabel),
      ]),
    ).toEqual([
      ["Perplexity", ["Sonar"]],
      ["Anthropic", ["Claude Opus", "Claude Sonnet"]],
    ]);
    expect(flattenModelRowSections(sections).map((row) => row.label)).toEqual([
      "Perplexity: Sonar",
      "Anthropic: Claude Opus",
      "Anthropic: Claude Sonnet",
    ]);
  });

  it("adds capacity metadata on model rows", () => {
    const rows = buildHarnessModelRows(CLAUDE_HARNESS, [
      model({
        harnessId: "claude",
        slug: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      }),
    ]);

    expect(rows[0]?.capacityLabel).toBe("200k ctx · 64k out");
    expect(rows[0]?.harnessLabel).toBe("Claude");
  });
});
