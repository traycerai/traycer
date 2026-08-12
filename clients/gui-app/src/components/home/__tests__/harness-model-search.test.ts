import { describe, expect, it } from "vitest";
import {
  buildAllHarnessModelRows,
  buildHarnessModelRows,
  buildSourceEntries,
  buildSubproviderEntries,
  createModelRowSearchIndex,
  filterModelRows,
  flattenModelRowSections,
  modelRowSectionLabel,
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
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const CLAUDE_HARNESS: HarnessOption = {
  id: "claude",
  label: "Claude",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const OPENCODE_HARNESS: HarnessOption = {
  id: "opencode",
  label: "OpenCode",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const OPENROUTER_HARNESS: HarnessOption = {
  id: "openrouter",
  label: "OpenRouter",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui"],
  requiresApiKey: true,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const KILOCODE_HARNESS: HarnessOption = {
  id: "kilocode",
  label: "Kilo Code",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const HERMES_HARNESS: HarnessOption = {
  id: "hermes",
  label: "Hermes Agent",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui"],
  requiresApiKey: true,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
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
    deprecationNotice: null,
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
      profileId: null,
    };
    const concreteSelection: HarnessModelSelection = {
      harnessId: "codex",
      modelSlug: "gpt-5.3-codex",
      profileId: null,
    };

    // Empty slug resolves to the first (preferred) model's row.
    expect(selectedModelRowId(emptySelection, rows)).toBe("codex:gpt-5.5");
    expect(selectedModelRowId(concreteSelection, rows)).toBe(
      "codex:gpt-5.3-codex",
    );
  });

  it("highlights a row when the persisted slug only matches resolvedModel", () => {
    const rows = buildHarnessModelRows(CLAUDE_HARNESS, [
      model({
        harnessId: "claude",
        slug: "claude-fable-5[1m]",
        label: "Fable 5 (1M)",
        metadata: { resolvedModel: "claude-fable-5" },
      }),
    ]);

    expect(
      selectedModelRowId(
        {
          harnessId: "claude",
          modelSlug: "claude-fable-5",
          profileId: null,
        },
        rows,
      ),
    ).toBe("claude:claude-fable-5[1m]");
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
        profileId: null,
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

  it("groups OpenRouter models by vendor and trims the redundant vendor prefix from rows", () => {
    const models = [
      model({
        harnessId: "openrouter",
        slug: "openrouter:anthropic/claude-opus",
        label: "Anthropic: Claude Opus",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
      model({
        harnessId: "openrouter",
        slug: "openrouter:~openai/gpt-latest",
        label: "OpenAI GPT Latest",
        metadata: {
          openCodeProviderId: "openai",
          openCodeProviderLabel: "OpenAI",
        },
      }),
      model({
        harnessId: "openrouter",
        slug: "openrouter:openrouter/owl-alpha",
        label: "Owl Alpha",
        metadata: {
          openCodeProviderId: "openrouter",
          openCodeProviderLabel: "OpenRouter",
        },
      }),
      model({
        harnessId: "openrouter",
        slug: "openrouter:z-ai/glm-4.6",
        label: "Z.ai: GLM 4.6",
        metadata: {
          openCodeProviderId: "z-ai",
          openCodeProviderLabel: "Z.ai",
        },
      }),
    ];
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, models);

    // Harness-agnostic grouping off the host-declared metadata, by vendor label.
    // browseLabel drops the vendor prefix the name carries: ": " for normal names
    // ("Z.ai: GLM 4.6" -> "GLM 4.6"), " " for the "latest" aliases ("OpenAI GPT
    // Latest" -> "GPT Latest"); a label with no vendor prefix ("Owl Alpha") is
    // left untouched.
    expect(
      rows.map((row) => [row.providerGroupLabel, row.browseLabel]),
    ).toEqual([
      ["Anthropic", "Claude Opus"],
      ["OpenAI", "GPT Latest"],
      ["OpenRouter", "Owl Alpha"],
      ["Z.ai", "GLM 4.6"],
    ]);
    // The full vendor-qualified label is preserved for search.
    expect(rows[3]?.label).toBe("Z.ai: GLM 4.6");
    // The collapsed trigger shows the trimmed name.
    expect(
      findModelLabel(models, {
        harnessId: "openrouter",
        modelSlug: "openrouter:z-ai/glm-4.6",
        profileId: null,
      }),
    ).toBe("GLM 4.6");
    expect(
      findModelLabel(models, {
        harnessId: "openrouter",
        modelSlug: "openrouter:openrouter/owl-alpha",
        profileId: null,
      }),
    ).toBe("Owl Alpha");
  });

  it("groups Kilo Code models by provider and trims the '/' provider prefix from rows", () => {
    const models = [
      model({
        harnessId: "kilocode",
        slug: "kilo/amazon/nova-pro-v1",
        label: "Kilo Gateway/Amazon: Nova Pro 1.0",
        metadata: {
          openCodeProviderId: "kilo",
          openCodeProviderLabel: "Kilo Gateway",
        },
      }),
      model({
        harnessId: "kilocode",
        slug: "openrouter/anthropic/claude-3-haiku",
        label: "OpenRouter/Claude 3 Haiku",
        metadata: {
          openCodeProviderId: "openrouter",
          openCodeProviderLabel: "OpenRouter",
        },
      }),
      model({
        harnessId: "kilocode",
        slug: "google-vertex/gemini-2.5-pro",
        label: "Vertex/Gemini 2.5 Pro",
        metadata: {
          openCodeProviderId: "google-vertex",
          openCodeProviderLabel: "Vertex",
        },
      }),
    ];
    const rows = buildHarnessModelRows(KILOCODE_HARNESS, models);

    // Grouped off the host-declared provider; browseLabel drops the
    // "<Provider>/" prefix Kilo's names carry (the "/" separator).
    expect(
      rows.map((row) => [row.providerGroupLabel, row.browseLabel]),
    ).toEqual([
      ["Kilo Gateway", "Amazon: Nova Pro 1.0"],
      ["OpenRouter", "Claude 3 Haiku"],
      ["Vertex", "Gemini 2.5 Pro"],
    ]);
    // The full "<Provider>/<Model>" name is preserved for search.
    expect(rows[0]?.label).toBe("Kilo Gateway/Amazon: Nova Pro 1.0");
    // The collapsed trigger shows the trimmed name.
    expect(
      findModelLabel(models, {
        harnessId: "kilocode",
        modelSlug: "google-vertex/gemini-2.5-pro",
        profileId: null,
      }),
    ).toBe("Gemini 2.5 Pro");
  });

  it("keeps host order when only some models carry group metadata (partial rollout)", () => {
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, [
      model({
        harnessId: "openrouter",
        slug: "openrouter:z-ai/glm-4.6",
        label: "Z.ai: GLM 4.6",
        metadata: {
          openCodeProviderId: "z-ai",
          openCodeProviderLabel: "Z.ai",
        },
      }),
      model({
        harnessId: "openrouter",
        slug: "openrouter:unannotated",
        label: "Unannotated",
        metadata: {},
      }),
    ]);

    // Mixed annotated/unannotated: not reordered (sorting by group would float
    // the empty-group model to the top), so the host-preferred order is kept.
    expect(rows.map((row) => row.value)).toEqual([
      "openrouter:z-ai/glm-4.6",
      "openrouter:unannotated",
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

  it("carries a model's deprecation notice onto its row, and null when absent", () => {
    const rows = buildHarnessModelRows(CLAUDE_HARNESS, [
      model({
        harnessId: "claude",
        slug: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        deprecationNotice: "Switch to Claude Sonnet 5.",
      }),
      model({
        harnessId: "claude",
        slug: "claude-sonnet-5",
        label: "Claude Sonnet 5",
      }),
    ]);

    expect(rows[0]?.deprecationNotice).toBe("Switch to Claude Sonnet 5.");
    expect(rows[1]?.deprecationNotice).toBeNull();
  });

  describe("buildSubproviderEntries", () => {
    it("groups by first-seen providerGroupId with counts and labels", () => {
      const rows = buildHarnessModelRows(OPENCODE_HARNESS, [
        model({
          harnessId: "opencode",
          slug: "clinepass:kimi",
          label: "ClinePass: Kimi K3",
          contextWindow: 128_000,
          metadata: {
            openCodeProviderId: "clinepass",
            openCodeProviderLabel: "ClinePass",
          },
        }),
        model({
          harnessId: "opencode",
          slug: "command-code:gpt",
          label: "Command Code: GPT",
          metadata: {
            openCodeProviderId: "command-code",
            openCodeProviderLabel: "Command Code",
          },
        }),
        model({
          harnessId: "opencode",
          slug: "clinepass:sonnet",
          label: "ClinePass: Sonnet",
          contextWindow: 200_000,
          metadata: {
            openCodeProviderId: "clinepass",
            openCodeProviderLabel: "ClinePass",
          },
        }),
      ]);

      // First-seen order (after builder's group sort: ClinePass then Command Code).
      expect(buildSubproviderEntries(rows, null)).toEqual([
        {
          providerGroupId: "clinepass",
          providerGroupLabel: "ClinePass",
          modelCount: 2,
          capacityLabel: "128k ctx",
          iconId: "clinepass",
        },
        {
          providerGroupId: "command-code",
          providerGroupLabel: "Command Code",
          modelCount: 1,
          capacityLabel: null,
          iconId: "command-code",
        },
      ]);
    });

    it("returns empty when rows have no provider groups", () => {
      const rows = buildHarnessModelRows(CODEX_HARNESS, [
        model({ slug: "gpt-5.5", label: "GPT-5.5" }),
        model({ slug: "gpt-4.1", label: "GPT-4.1" }),
      ]);
      expect(buildSubproviderEntries(rows, null)).toEqual([]);
    });

    it("returns a single entry when all rows share one group", () => {
      const rows = buildHarnessModelRows(OPENCODE_HARNESS, [
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
          slug: "anthropic:opus",
          label: "Anthropic: Opus",
          metadata: {
            openCodeProviderId: "anthropic",
            openCodeProviderLabel: "Anthropic",
          },
        }),
      ]);
      expect(buildSubproviderEntries(rows, null)).toEqual([
        {
          providerGroupId: "anthropic",
          providerGroupLabel: "Anthropic",
          modelCount: 2,
          capacityLabel: null,
          iconId: "anthropic",
        },
      ]);
    });
  });
});

describe("slug-derived vendor groups (OpenRouter-style)", () => {
  it("groups by the slug vendor and strips harness/vendor prefixes from the label", () => {
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, [
      model({
        harnessId: "openrouter",
        slug: "anthropic/claude-fable-5",
        label: "OpenRouter · anthropic/claude Fable 5",
      }),
    ]);
    expect(rows[0].providerGroupId).toBe("anthropic");
    expect(rows[0].providerGroupLabel).toBe("Anthropic");
    expect(rows[0].browseLabel).toBe("Claude Fable 5");
    // Raw label stays available for search recall.
    expect(rows[0].searchLabel).toBe("OpenRouter · anthropic/claude Fable 5");
  });

  it("keeps an already-clean label untouched", () => {
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, [
      model({
        harnessId: "openrouter",
        slug: "anthropic/claude-opus-5",
        label: "Claude Opus 5",
      }),
    ]);
    expect(rows[0].providerGroupId).toBe("anthropic");
    expect(rows[0].browseLabel).toBe("Claude Opus 5");
  });

  it("does not group slugs without a vendor segment", () => {
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, [
      model({ harnessId: "openrouter", slug: "gpt-5.2", label: "GPT-5.2" }),
    ]);
    expect(rows[0].providerGroupId).toBe(null);
    expect(rows[0].browseLabel).toBe("GPT-5.2");
  });

  it("does not group absolute-path custom-endpoint slugs", () => {
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, [
      model({
        harnessId: "openrouter",
        slug: "/workspace/models/dsv4-flash-q4.gguf",
        label: "Custom endpoint · /workspace/models/dsv4 Flash q4.gguf",
      }),
    ]);
    expect(rows[0].providerGroupId).toBe(null);
  });

  it("host metadata group wins over the slug derivation", () => {
    const rows = buildHarnessModelRows(OPENCODE_HARNESS, [
      model({
        harnessId: "opencode",
        slug: "anthropic/claude-opus-5",
        label: "Perplexity: Sonar",
        metadata: {
          openCodeProviderId: "perplexity",
          openCodeProviderLabel: "Perplexity",
        },
      }),
    ]);
    expect(rows[0].providerGroupId).toBe("perplexity");
    expect(rows[0].providerGroupLabel).toBe("Perplexity");
  });

  it("feeds cascade subprovider entries with one group per vendor", () => {
    const rows = buildHarnessModelRows(OPENROUTER_HARNESS, [
      model({
        harnessId: "openrouter",
        slug: "anthropic/claude-fable-5",
        label: "OpenRouter · anthropic/claude Fable 5",
      }),
      model({
        harnessId: "openrouter",
        slug: "anthropic/claude-opus-5",
        label: "OpenRouter · anthropic/claude Opus 5",
      }),
      model({
        harnessId: "openrouter",
        slug: "openai/gpt-5.6-sol",
        label: "OpenRouter · openai/gpt 5.6 Sol",
      }),
    ]);
    const entries = buildSubproviderEntries(rows, null);
    expect(
      entries.map((entry) => [entry.providerGroupId, entry.modelCount]),
    ).toEqual([
      ["anthropic", 2],
      ["openai", 1],
    ]);
  });
});

describe("composite source:vendor groups (Hermes/OMP)", () => {
  function hermesCompositeModels(): ReadonlyArray<ModelOption> {
    return [
      model({
        harnessId: "hermes",
        slug: "anthropic/claude-opus",
        label: "Claude Opus",
        metadata: {
          openCodeProviderId: "openrouter:anthropic",
          openCodeProviderLabel: "Openrouter:anthropic",
        },
      }),
      model({
        harnessId: "hermes",
        slug: "anthropic/claude-sonnet",
        label: "Claude Sonnet",
        metadata: {
          openCodeProviderId: "openrouter:anthropic",
          openCodeProviderLabel: "Openrouter:anthropic",
        },
      }),
      model({
        harnessId: "hermes",
        slug: "openai/gpt-5",
        label: "GPT-5",
        metadata: {
          openCodeProviderId: "openrouter:openai",
          openCodeProviderLabel: "Openrouter:openai",
        },
      }),
      model({
        harnessId: "hermes",
        slug: "groq/llama",
        label: "Llama",
        metadata: {
          openCodeProviderId: "groq:meta",
          openCodeProviderLabel: "Groq:meta",
        },
      }),
    ];
  }

  it("splits concatenated host ids into source + vendor labels", () => {
    const rows = buildHarnessModelRows(HERMES_HARNESS, hermesCompositeModels());
    expect(
      rows.map((row) => [
        row.sourceGroupId,
        row.sourceGroupLabel,
        row.providerGroupId,
        row.providerGroupLabel,
      ]),
    ).toEqual([
      ["groq", "Groq", "groq:meta", "Meta"],
      ["openrouter", "OpenRouter", "openrouter:anthropic", "Anthropic"],
      ["openrouter", "OpenRouter", "openrouter:anthropic", "Anthropic"],
      ["openrouter", "OpenRouter", "openrouter:openai", "OpenAI"],
    ]);
    expect(modelRowSectionLabel(rows[1] ?? rows[0])).toBe(
      "OpenRouter · Anthropic",
    );
  });

  it("rolls sources and filters vendors by the selected gateway", () => {
    const rows = buildHarnessModelRows(HERMES_HARNESS, hermesCompositeModels());
    expect(
      buildSourceEntries(rows).map((entry) => [
        entry.sourceGroupId,
        entry.sourceGroupLabel,
        entry.vendorCount,
        entry.modelCount,
      ]),
    ).toEqual([
      ["groq", "Groq", 1, 1],
      ["openrouter", "OpenRouter", 2, 3],
    ]);
    expect(
      buildSubproviderEntries(rows, "openrouter").map((entry) => [
        entry.providerGroupLabel,
        entry.modelCount,
        entry.iconId,
      ]),
    ).toEqual([
      ["Anthropic", 2, "anthropic"],
      ["OpenAI", 1, "openai"],
    ]);
  });

  it("does not invent a source level for flat OpenCode groups", () => {
    const rows = buildHarnessModelRows(OPENCODE_HARNESS, [
      model({
        harnessId: "opencode",
        slug: "clinepass:kimi",
        label: "ClinePass: Kimi K3",
        metadata: {
          openCodeProviderId: "clinepass",
          openCodeProviderLabel: "ClinePass",
        },
      }),
    ]);
    expect(rows[0]?.sourceGroupId).toBeNull();
    expect(buildSourceEntries(rows)).toEqual([]);
  });
});
