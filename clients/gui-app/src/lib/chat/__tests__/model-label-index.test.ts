import { describe, expect, it, vi } from "vitest";
import type { GuiAgentModelOption } from "@traycer/protocol/host";
import type { AgentSender } from "@traycer/protocol/persistence/epic/schemas";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import {
  getModelLabelIndex,
  type ModelLabelIndex,
} from "@/lib/chat/model-label-index";
import {
  resolveAgentReasoningLabel,
  resolveAgentSenderDisplay,
  type SenderDisplayContext,
} from "@/lib/chat/sender-display";

const TILE_COUNT = 5;

function catalogEntry(
  id: GuiHarnessCatalogEntry["id"],
  models: GuiHarnessCatalogEntry["models"],
): GuiHarnessCatalogEntry {
  return {
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
    models,
    modelsLoading: false,
    modelsError: null,
  };
}

function modelOption(
  harnessId: GuiAgentModelOption["harnessId"],
  slug: string,
  label: string,
  supportedReasoningEfforts: GuiAgentModelOption["supportedReasoningEfforts"],
): GuiAgentModelOption {
  const defaultReasoningEffort =
    supportedReasoningEfforts.length === 0
      ? null
      : supportedReasoningEfforts[0].id;
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

function agentSender(
  harnessId: AgentSender["harnessId"],
  agentId: string,
  displayName: string | null,
): AgentSender {
  return {
    type: "agent",
    harnessId,
    agentId,
    displayName,
    reply: { expectsReply: false },
    inReplyTo: null,
  };
}

function displayContextFrom(index: ModelLabelIndex): SenderDisplayContext {
  return {
    profile: null,
    collaborators: [],
    modelLabels: index.modelLabels,
    modelReasoningLabels: index.modelReasoningLabels,
  };
}

function tileCatalog(
  codexModels: GuiHarnessCatalogEntry["models"],
  claudeModels: GuiHarnessCatalogEntry["models"],
  grokModels: GuiHarnessCatalogEntry["models"],
  cursorModels: GuiHarnessCatalogEntry["models"],
): ReadonlyArray<GuiHarnessCatalogEntry> {
  return [
    catalogEntry("codex", codexModels),
    catalogEntry("claude", claudeModels),
    catalogEntry("grok", grokModels),
    catalogEntry("cursor", cursorModels),
  ];
}

function indexesForTiles(
  buildCatalog: () => ReadonlyArray<GuiHarnessCatalogEntry>,
): ModelLabelIndex[] {
  return Array.from({ length: TILE_COUNT }, () =>
    getModelLabelIndex(buildCatalog()),
  );
}

function expectSharedIndex(
  indexes: ReadonlyArray<ModelLabelIndex>,
): ModelLabelIndex {
  const first = indexes[0];
  expect(indexes).toHaveLength(TILE_COUNT);
  for (const index of indexes) {
    expect(index).toBe(first);
    expect(index.modelLabels).toBe(first.modelLabels);
    expect(index.modelReasoningLabels).toBe(first.modelReasoningLabels);
  }
  return first;
}

function countMapSetsDuring(run: () => void): number {
  const spy = vi.spyOn(Map.prototype, "set");
  try {
    run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe("getModelLabelIndex", () => {
  it("shares one index across N catalogs that wrap the same per-harness models arrays", () => {
    const codexModels = [
      modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
        { id: "xhigh", label: "Extra High", description: null },
      ]),
    ];
    const claudeModels = [
      modelOption("claude", "sonnet-4.5", "Claude Sonnet 4.5", [
        { id: "high", label: "High", description: null },
      ]),
    ];
    const cursorModels = [modelOption("cursor", "composer", "Composer", [])];

    const indexes = indexesForTiles(() =>
      tileCatalog(codexModels, claudeModels, [], cursorModels),
    );

    expectSharedIndex(indexes);
  });

  it("rebuilds once when a harness models array is replaced, then shares that replacement", () => {
    const claudeModels = [
      modelOption("claude", "sonnet-4.5", "Claude Sonnet 4.5", [
        { id: "high", label: "High", description: null },
      ]),
    ];
    const originalCodexModels = [
      modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
        { id: "xhigh", label: "Extra High", description: null },
      ]),
    ];
    const nextCodexModels = [
      modelOption("codex", "gpt-5.4", "GPT-5.4", [
        { id: "xhigh", label: "Extra High", description: null },
      ]),
    ];
    const cursorModels = [modelOption("cursor", "composer", "Composer", [])];

    const original = expectSharedIndex(
      indexesForTiles(() =>
        tileCatalog(originalCodexModels, claudeModels, [], cursorModels),
      ),
    );

    const replacements: ModelLabelIndex[] = [];
    const firstReplacementSets = countMapSetsDuring(() => {
      replacements.push(
        getModelLabelIndex(
          tileCatalog(nextCodexModels, claudeModels, [], cursorModels),
        ),
      );
    });
    expect(firstReplacementSets).toBeGreaterThan(0);
    const replacement = replacements[0];
    expect(replacement).not.toBe(original);
    expect(replacement.modelLabels).not.toBe(original.modelLabels);
    expect(replacement.modelReasoningLabels).not.toBe(
      original.modelReasoningLabels,
    );

    let later: ModelLabelIndex[] = [];
    const laterReplacementSets = countMapSetsDuring(() => {
      later = indexesForTiles(() =>
        tileCatalog(nextCodexModels, claudeModels, [], cursorModels),
      );
    });
    expect(laterReplacementSets).toBe(0);
    for (const index of later) {
      expect(index).toBe(replacement);
    }

    expect(
      getModelLabelIndex(
        tileCatalog(originalCodexModels, claudeModels, [], cursorModels),
      ),
    ).toBe(original);
  });

  it("keeps equal-content models arrays from different hosts on distinct indexes", () => {
    const model = modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
      { id: "xhigh", label: "Extra High", description: null },
    ]);
    const hostAModels = [model];
    const hostBModels = [
      modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
        { id: "xhigh", label: "Extra High", description: null },
      ]),
    ];

    const hostA = getModelLabelIndex([catalogEntry("codex", hostAModels)]);
    const hostB = getModelLabelIndex([catalogEntry("codex", hostBModels)]);

    expect(hostA).not.toBe(hostB);
    expect(hostA.modelLabels).not.toBe(hostB.modelLabels);
    expect(hostA.modelReasoningLabels).not.toBe(hostB.modelReasoningLabels);
    expect(getModelLabelIndex([catalogEntry("codex", hostAModels)])).toBe(
      hostA,
    );
    expect(getModelLabelIndex([catalogEntry("codex", hostBModels)])).toBe(
      hostB,
    );
  });

  it("returns shared empty maps for empty and hidden catalogs without replacing a full index", () => {
    const codexModels = [
      modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
        { id: "xhigh", label: "Extra High", description: null },
      ]),
    ];
    const full = getModelLabelIndex([catalogEntry("codex", codexModels)]);

    const emptyCatalogs: ModelLabelIndex[] = [];
    const emptySets = countMapSetsDuring(() => {
      emptyCatalogs.push(getModelLabelIndex([]));
      emptyCatalogs.push(getModelLabelIndex([]));
      emptyCatalogs.push(
        getModelLabelIndex([
          catalogEntry("grok", []),
          catalogEntry("cursor", []),
        ]),
      );
    });

    expect(emptySets).toBe(0);
    const empty = emptyCatalogs[0];
    expect(empty.modelLabels.size).toBe(0);
    expect(empty.modelReasoningLabels.size).toBe(0);
    for (const index of emptyCatalogs) {
      expect(index).toBe(empty);
      expect(index.modelLabels).toBe(empty.modelLabels);
      expect(index.modelReasoningLabels).toBe(empty.modelReasoningLabels);
    }
    expect(empty).not.toBe(full);
    expect(getModelLabelIndex([catalogEntry("codex", codexModels)])).toBe(full);
  });

  it("resolves labels and reasoning through sender-display for empty harnesses and models without efforts", () => {
    const codexModels = [
      modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
        { id: "xhigh", label: "Extra High", description: null },
        { id: "high", label: "High", description: null },
      ]),
    ];
    const claudeModels = [
      modelOption("claude", "sonnet-4.5", "Claude Sonnet 4.5", [
        { id: "high", label: "High", description: null },
      ]),
    ];
    const cursorModels = [modelOption("cursor", "composer", "Composer", [])];
    const index = getModelLabelIndex(
      tileCatalog(codexModels, claudeModels, [], cursorModels),
    );
    const context = displayContextFrom(index);

    expect(
      resolveAgentSenderDisplay(
        agentSender("codex", "gpt-5-codex", "GPT-5 Codex"),
        context,
      ),
    ).toEqual({ providerLabel: "Codex", modelLabel: "GPT-5 Codex" });
    expect(
      resolveAgentReasoningLabel(
        agentSender("codex", "gpt-5-codex", "GPT-5 Codex"),
        "xhigh",
        context,
      ),
    ).toBe("Extra High");

    expect(
      resolveAgentSenderDisplay(
        agentSender("claude", "sonnet-4.5", "Claude Sonnet 4.5"),
        context,
      ),
    ).toEqual({
      providerLabel: "Claude Code",
      modelLabel: "Claude Sonnet 4.5",
    });
    expect(
      resolveAgentReasoningLabel(
        agentSender("claude", "sonnet-4.5", "Claude Sonnet 4.5"),
        "high",
        context,
      ),
    ).toBe("High");

    expect(
      resolveAgentSenderDisplay(
        agentSender("grok", "grok-4", "Grok 4"),
        context,
      ),
    ).toEqual({ providerLabel: "Grok", modelLabel: "Grok 4" });
    expect(
      resolveAgentReasoningLabel(
        agentSender("grok", "grok-4", "Grok 4"),
        "high",
        context,
      ),
    ).toBe("high");

    expect(
      resolveAgentSenderDisplay(
        agentSender("cursor", "composer", "Composer"),
        context,
      ),
    ).toEqual({ providerLabel: "Cursor", modelLabel: "Composer" });
    expect(
      resolveAgentReasoningLabel(
        agentSender("cursor", "composer", "Composer"),
        "high",
        context,
      ),
    ).toBe("high");
  });

  it("does not share or cache an index when a models array is reused under a different harness id", () => {
    const models = [
      modelOption("codex", "gpt-5-codex", "GPT-5 Codex", [
        { id: "xhigh", label: "Extra High", description: null },
      ]),
    ];
    const cached = getModelLabelIndex([catalogEntry("codex", models)]);

    const mismatches: ModelLabelIndex[] = [];
    const firstMismatchSets = countMapSetsDuring(() => {
      mismatches.push(getModelLabelIndex([catalogEntry("claude", models)]));
    });
    const secondMismatchSets = countMapSetsDuring(() => {
      mismatches.push(getModelLabelIndex([catalogEntry("claude", models)]));
    });

    expect(firstMismatchSets).toBeGreaterThan(0);
    expect(secondMismatchSets).toBeGreaterThan(0);
    expect(mismatches[0]).not.toBe(cached);
    expect(mismatches[1]).not.toBe(cached);
    expect(mismatches[0]).not.toBe(mismatches[1]);
    expect(mismatches[0].modelLabels).not.toBe(mismatches[1].modelLabels);
    expect(getModelLabelIndex([catalogEntry("codex", models)])).toBe(cached);

    const mismatchedContext = displayContextFrom(mismatches[0]);
    expect(
      resolveAgentSenderDisplay(
        agentSender("claude", "gpt-5-codex", "GPT-5 Codex"),
        mismatchedContext,
      ),
    ).toEqual({
      providerLabel: "Claude Code",
      modelLabel: "GPT-5 Codex",
    });
    expect(
      resolveAgentSenderDisplay(
        agentSender("codex", "gpt-5-codex", null),
        mismatchedContext,
      ),
    ).toEqual({ providerLabel: "Codex", modelLabel: "gpt-5-codex" });
    expect(
      resolveAgentReasoningLabel(
        agentSender("claude", "gpt-5-codex", "GPT-5 Codex"),
        "xhigh",
        mismatchedContext,
      ),
    ).toBe("Extra High");
  });
});
