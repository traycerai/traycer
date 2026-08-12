import { describe, expect, it } from "vitest";
import {
  buildHarnessModelRows,
  buildSourceEntries,
  buildSubproviderEntries,
} from "@/components/home/data/harness-model-search";
import type {
  HarnessOption,
  ModelOption,
} from "@/components/home/data/landing-options";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import {
  cascadeBack,
  cascadePathLabels,
  cascadeSelectModel,
  cascadeSelectSource,
  cascadeSelectSubprovider,
  resolveCascadeForProvider,
  shouldShowSourceLevel,
  shouldShowSubproviderLevel,
  type CascadeState,
} from "@/components/home/pickers/harness-model-picker-cascade";

const OPENCODE_HARNESS: HarnessOption = {
  id: "opencode",
  label: "Oh My Pi",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

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
    harnessId: "opencode",
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

function multiGroupRows() {
  return buildHarnessModelRows(OPENCODE_HARNESS, [
    model({
      slug: "clinepass:kimi",
      label: "ClinePass: Kimi K3",
      metadata: {
        openCodeProviderId: "clinepass",
        openCodeProviderLabel: "ClinePass",
      },
      supportedReasoningEfforts: [
        { id: "low", label: "Low", description: "Faster" },
        { id: "high", label: "High", description: "Deeper" },
      ],
      defaultReasoningEffort: "low",
    }),
    model({
      slug: "command-code:gpt",
      label: "Command Code: GPT",
      metadata: {
        openCodeProviderId: "command-code",
        openCodeProviderLabel: "Command Code",
      },
    }),
    model({
      slug: "clinepass:sonnet",
      label: "ClinePass: Sonnet",
      metadata: {
        openCodeProviderId: "clinepass",
        openCodeProviderLabel: "ClinePass",
      },
    }),
  ]);
}

describe("shouldShowSubproviderLevel", () => {
  it("is true only for 2+ groups when not profile-scoped", () => {
    const multi = buildSubproviderEntries(multiGroupRows(), null);
    expect(shouldShowSubproviderLevel(multi, false)).toBe(true);
    expect(shouldShowSubproviderLevel(multi, true)).toBe(false);
    expect(shouldShowSubproviderLevel(multi.slice(0, 1), false)).toBe(false);
    expect(shouldShowSubproviderLevel([], false)).toBe(false);
  });
});

describe("resolveCascadeForProvider", () => {
  it("lands on subproviders when 2+ groups and no selection in a group", () => {
    const rows = multiGroupRows();
    expect(
      resolveCascadeForProvider({
        providerRows: rows,
        selectedRowId: "",
        profileScoped: false,
      }),
    ).toEqual({
      level: "subproviders",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });
  });

  it("lands on models inside the selected row's group", () => {
    const rows = multiGroupRows();
    const selected = rows.find((row) => row.value === "clinepass:sonnet");
    expect(selected).toBeDefined();
    expect(
      resolveCascadeForProvider({
        providerRows: rows,
        selectedRowId: selected?.id ?? "",
        profileScoped: false,
      }),
    ).toEqual({
      level: "models",
      activeSourceId: null,
      activeGroupId: "clinepass",
      pendingEffortModelId: null,
    });
  });

  it("skips subproviders when profile-scoped even with 2+ groups", () => {
    const rows = multiGroupRows();
    expect(
      resolveCascadeForProvider({
        providerRows: rows,
        selectedRowId: "",
        profileScoped: true,
      }),
    ).toEqual({
      level: "models",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });
  });

  it("skips subproviders for ungrouped or single-group catalogs", () => {
    const ungrouped = buildHarnessModelRows(CODEX_HARNESS, [
      model({ harnessId: "codex", slug: "gpt-5.5", label: "GPT-5.5" }),
    ]);
    expect(
      resolveCascadeForProvider({
        providerRows: ungrouped,
        selectedRowId: ungrouped[0]?.id ?? "",
        profileScoped: false,
      }),
    ).toEqual({
      level: "models",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });

    const singleGroup = buildHarnessModelRows(OPENCODE_HARNESS, [
      model({
        slug: "anthropic:claude",
        label: "Anthropic: Claude",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
      model({
        slug: "anthropic:opus",
        label: "Anthropic: Opus",
        metadata: {
          openCodeProviderId: "anthropic",
          openCodeProviderLabel: "Anthropic",
        },
      }),
    ]);
    expect(
      resolveCascadeForProvider({
        providerRows: singleGroup,
        selectedRowId: "",
        profileScoped: false,
      }),
    ).toEqual({
      level: "models",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });
  });
});

describe("cascadeSelectSubprovider / cascadeSelectModel / cascadeBack", () => {
  it("drills subprovider → models", () => {
    expect(cascadeSelectSubprovider("clinepass", null)).toEqual({
      level: "models",
      activeSourceId: null,
      activeGroupId: "clinepass",
      pendingEffortModelId: null,
    });
  });

  it("completes models without efforts; drills efforts when present", () => {
    const rows = multiGroupRows();
    const plain = rows.find((row) => row.value === "command-code:gpt");
    const withEffort = rows.find((row) => row.value === "clinepass:kimi");
    expect(plain).toBeDefined();
    expect(withEffort).toBeDefined();
    if (plain === undefined || withEffort === undefined) return;

    expect(cascadeSelectModel(plain)).toEqual({ kind: "complete" });
    expect(cascadeSelectModel(withEffort)).toEqual({
      kind: "drillEffort",
      state: {
        level: "efforts",
        activeSourceId: null,
        activeGroupId: "clinepass",
        pendingEffortModelId: withEffort.id,
      },
    });
  });

  it("backs efforts → models → subproviders → null at root", () => {
    const effort: CascadeState = {
      level: "efforts",
      activeSourceId: null,
      activeGroupId: "clinepass",
      pendingEffortModelId: "opencode:clinepass:kimi",
    };
    const models = cascadeBack(effort, {
      canShowSources: false,
      canShowSubproviders: true,
    });
    expect(models).toEqual({
      level: "models",
      activeSourceId: null,
      activeGroupId: "clinepass",
      pendingEffortModelId: null,
    });
    if (models === null) return;
    const sub = cascadeBack(models, {
      canShowSources: false,
      canShowSubproviders: true,
    });
    expect(sub).toEqual({
      level: "subproviders",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });
    if (sub === null) return;
    expect(
      cascadeBack(sub, {
        canShowSources: false,
        canShowSubproviders: true,
      }),
    ).toBeNull();
  });

  it("backs models to null when subproviders are not shown", () => {
    const models: CascadeState = {
      level: "models",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    };
    expect(
      cascadeBack(models, {
        canShowSources: false,
        canShowSubproviders: false,
      }),
    ).toBeNull();
  });
});

describe("cascadePathLabels", () => {
  it("builds path crumbs for models and efforts", () => {
    expect(
      cascadePathLabels({
        state: {
          level: "models",
          activeSourceId: null,
          activeGroupId: "clinepass",
          pendingEffortModelId: null,
        },
        providerLabel: "Oh My Pi",
        sourceLabel: null,
        subproviderLabel: "ClinePass",
        pendingModelLabel: null,
      }),
    ).toEqual(["Oh My Pi", "ClinePass"]);

    expect(
      cascadePathLabels({
        state: {
          level: "efforts",
          activeSourceId: null,
          activeGroupId: "clinepass",
          pendingEffortModelId: "x",
        },
        providerLabel: "Oh My Pi",
        sourceLabel: null,
        subproviderLabel: "ClinePass",
        pendingModelLabel: "Kimi K3",
      }),
    ).toEqual(["Oh My Pi", "ClinePass", "Kimi K3"]);

    expect(
      cascadePathLabels({
        state: {
          level: "subproviders",
          activeSourceId: null,
          activeGroupId: null,
          pendingEffortModelId: null,
        },
        providerLabel: "Oh My Pi",
        sourceLabel: null,
        subproviderLabel: null,
        pendingModelLabel: null,
      }),
    ).toEqual([]);
  });
});

describe("composite source cascade (Hermes/OMP)", () => {
  function compositeRows() {
    return buildHarnessModelRows(HERMES_HARNESS, [
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
        slug: "openai/gpt-5",
        label: "GPT-5",
        metadata: {
          openCodeProviderId: "openrouter:openai",
          openCodeProviderLabel: "Openrouter:openai",
        },
      }),
    ]);
  }

  it("shows the source level for a single gateway with 2+ vendors", () => {
    const rows = compositeRows();
    const sources = buildSourceEntries(rows);
    expect(shouldShowSourceLevel(sources, false)).toBe(true);
    expect(shouldShowSourceLevel(sources, true)).toBe(false);
    expect(
      resolveCascadeForProvider({
        providerRows: rows,
        selectedRowId: "",
        profileScoped: false,
      }),
    ).toEqual({
      level: "sources",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });
  });

  it("reopens on models inside the selected source and vendor", () => {
    const rows = compositeRows();
    const selected = rows.find((row) => row.value === "openai/gpt-5");
    expect(selected).toBeDefined();
    expect(
      resolveCascadeForProvider({
        providerRows: rows,
        selectedRowId: selected?.id ?? "",
        profileScoped: false,
      }),
    ).toEqual({
      level: "models",
      activeSourceId: "openrouter",
      activeGroupId: "openrouter:openai",
      pendingEffortModelId: null,
    });
  });

  it("drills source → vendors, then back sources ← vendors ← models", () => {
    const rows = compositeRows();
    const vendors = buildSubproviderEntries(rows, "openrouter");
    expect(cascadeSelectSource("openrouter", vendors)).toEqual({
      level: "subproviders",
      activeSourceId: "openrouter",
      activeGroupId: null,
      pendingEffortModelId: null,
    });
    const models = cascadeSelectSubprovider(
      "openrouter:anthropic",
      "openrouter",
    );
    expect(models).toEqual({
      level: "models",
      activeSourceId: "openrouter",
      activeGroupId: "openrouter:anthropic",
      pendingEffortModelId: null,
    });
    const flags = { canShowSources: true, canShowSubproviders: true };
    const backVendors = cascadeBack(models, flags);
    expect(backVendors).toEqual({
      level: "subproviders",
      activeSourceId: "openrouter",
      activeGroupId: null,
      pendingEffortModelId: null,
    });
    if (backVendors === null) return;
    expect(cascadeBack(backVendors, flags)).toEqual({
      level: "sources",
      activeSourceId: null,
      activeGroupId: null,
      pendingEffortModelId: null,
    });
  });

  it("includes the source in path crumbs", () => {
    expect(
      cascadePathLabels({
        state: {
          level: "models",
          activeSourceId: "openrouter",
          activeGroupId: "openrouter:anthropic",
          pendingEffortModelId: null,
        },
        providerLabel: "Hermes Agent",
        sourceLabel: "OpenRouter",
        subproviderLabel: "Anthropic",
        pendingModelLabel: null,
      }),
    ).toEqual(["Hermes Agent", "OpenRouter", "Anthropic"]);
  });
});
