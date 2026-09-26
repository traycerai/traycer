import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HarnessOption,
  ModelOption,
  ProviderId,
  ReasoningFallback,
} from "@/components/home/data/landing-options";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  createComposerToolbarStore,
  type ComposerToolbarCatalog,
  type ComposerToolbarPurpose,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";

function model(
  harnessId: ProviderId,
  slug: string,
  label: string,
): ModelOption {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

function harness(id: ProviderId, available: boolean): HarnessOption {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    enabled: true,
    available,
    error: available ? null : "unavailable",
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
  };
}

const CLAUDE_AND_CODEX: ReadonlyArray<HarnessOption> = [
  harness("claude", true),
  harness("codex", true),
];

function catalog(input: {
  readonly modelsHarnessId: ProviderId;
  readonly models: ReadonlyArray<ModelOption>;
  readonly modelsLoaded: boolean;
  readonly harnesses?: ReadonlyArray<HarnessOption>;
}): ComposerToolbarCatalog {
  return {
    hostId: null,
    harnesses: input.harnesses,
    modelsHarnessId: input.modelsHarnessId,
    models: input.models,
    modelsLoaded: input.modelsLoaded,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
  };
}

function createStore(input: {
  readonly purpose: ComposerToolbarPurpose;
  readonly harnessId?: ProviderId;
  readonly modelSlug?: string;
  readonly onSettingsChange?: ((settings: ChatRunSettings) => void) | null;
  readonly reasoningFallback?: ReasoningFallback;
}): ComposerToolbarStore {
  return createComposerToolbarStore({
    purpose: input.purpose,
    reasoningFallback: input.reasoningFallback ?? "model-default",
    seedKey: [
      "setting-purpose",
      input.purpose,
      input.harnessId ?? "claude",
      input.modelSlug ?? "",
    ].join("-"),
    values: {
      permission: "supervised",
      selection: {
        harnessId: input.harnessId ?? "claude",
        modelSlug: input.modelSlug ?? "held-slug",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: input.onSettingsChange ?? null,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
}

describe("composer toolbar store setting purpose", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps an unavailable provider selected on a setting store while a run store reroutes", () => {
    const unavailableClaude = harness("claude", false);
    const availableCodex = harness("codex", true);
    const loaded = catalog({
      harnesses: [unavailableClaude, availableCodex],
      modelsHarnessId: "claude",
      models: [model("claude", "held-slug", "Held")],
      modelsLoaded: true,
    });

    const runStore = createStore({ purpose: "run" });
    const settingStore = createStore({ purpose: "setting" });

    runStore.getState().setCatalog(loaded);
    settingStore.getState().setCatalog(loaded);

    expect(runStore.getState().values.selection.harnessId).toBe("claude");
    expect(runStore.getState().selection.harnessId).toBe("codex");
    expect(settingStore.getState().selection.harnessId).toBe("claude");
    expect(settingStore.getState().values.selection.harnessId).toBe("claude");
  });

  it("holds a delisted non-empty slug on a setting store and emits that slug on a later edit", () => {
    const listed = [
      model("claude", "default", "Default"),
      model("claude", "current", "Current"),
    ];
    const loaded = catalog({
      harnesses: [harness("claude", true)],
      modelsHarnessId: "claude",
      models: listed,
      modelsLoaded: true,
    });
    const settingEmitted: string[] = [];
    const runEmitted: string[] = [];
    const settingStore = createStore({
      purpose: "setting",
      modelSlug: "delisted-slug",
      onSettingsChange: (settings) => settingEmitted.push(settings.model),
    });
    const runStore = createStore({
      purpose: "run",
      modelSlug: "delisted-slug",
      onSettingsChange: (settings) => runEmitted.push(settings.model),
    });

    settingStore.getState().setCatalog(loaded);
    runStore.getState().setCatalog(loaded);

    expect(settingStore.getState().selection.modelSlug).toBe("delisted-slug");
    expect(settingStore.getState().values.selection.modelSlug).toBe(
      "delisted-slug",
    );
    expect(settingStore.getState().selectionHealedForDisplay).toBe(false);
    expect(settingEmitted).toEqual([]);

    expect(runStore.getState().selection.modelSlug).toBe("default");
    expect(runStore.getState().selectionHealedForDisplay).toBe(true);
    expect(runEmitted).toEqual([]);

    settingStore.getState().setPermission("full_access");
    expect(settingEmitted).toEqual(["delisted-slug"]);

    runStore.getState().setPermission("full_access");
    expect(runEmitted).toEqual([]);
    expect(runStore.getState().pendingSettingsEmit).toBe(true);
  });

  it("defers an empty slug until the harness catalog loads, then emits the first row once", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      purpose: "setting",
      harnessId: "claude",
      modelSlug: "claude-opus",
      onSettingsChange: (settings) => emitted.push(settings),
    });
    store.getState().setCatalog(
      catalog({
        harnesses: CLAUDE_AND_CODEX,
        modelsHarnessId: "claude",
        models: [model("claude", "claude-opus", "Opus")],
        modelsLoaded: true,
      }),
    );
    expect(emitted).toEqual([]);

    store.getState().applyComposerSelection({
      selection: { harnessId: "codex", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    });

    expect(store.getState().selection.modelSlug).toBe("");
    expect(store.getState().pendingSettingsEmit).toBe(true);
    expect(emitted).toEqual([]);

    store.getState().setCatalog(
      catalog({
        harnesses: CLAUDE_AND_CODEX,
        modelsHarnessId: "codex",
        models: [],
        modelsLoaded: false,
      }),
    );
    expect(store.getState().selection.modelSlug).toBe("");
    expect(store.getState().pendingSettingsEmit).toBe(true);
    expect(emitted).toEqual([]);

    const loadedCodex = [
      model("codex", "gpt-5.5", "GPT-5.5"),
      model("codex", "gpt-4.1", "GPT-4.1"),
    ];
    store.getState().setCatalog(
      catalog({
        harnesses: CLAUDE_AND_CODEX,
        modelsHarnessId: "codex",
        models: loadedCodex,
        modelsLoaded: true,
      }),
    );

    expect(store.getState().selection.modelSlug).toBe("gpt-5.5");
    expect(store.getState().pendingSettingsEmit).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.model).toBe("gpt-5.5");
    expect(emitted[0]?.harnessId).toBe("codex");

    store.getState().setCatalog(
      catalog({
        harnesses: CLAUDE_AND_CODEX,
        modelsHarnessId: "codex",
        models: [...loadedCodex, model("codex", "gpt-extra", "Extra")],
        modelsLoaded: true,
      }),
    );
    expect(emitted).toHaveLength(1);
  });

  it("emits nothing and stays pending when the switched harness catalog loads empty", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      purpose: "setting",
      harnessId: "claude",
      modelSlug: "claude-opus",
      onSettingsChange: (settings) => emitted.push(settings),
    });

    store.getState().applyComposerSelection({
      selection: { harnessId: "codex", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    });
    expect(store.getState().pendingSettingsEmit).toBe(true);
    expect(emitted).toEqual([]);

    store.getState().setCatalog(
      catalog({
        harnesses: [harness("codex", true)],
        modelsHarnessId: "codex",
        models: [],
        modelsLoaded: true,
      }),
    );

    expect(store.getState().selection.modelSlug).toBe("");
    expect(store.getState().pendingSettingsEmit).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("does not track HarnessChanged on a setting store, and does on a run store", () => {
    const settingStore = createStore({
      purpose: "setting",
      harnessId: "codex",
      modelSlug: "gpt-5.5",
    });
    const runStore = createStore({
      purpose: "run",
      harnessId: "codex",
      modelSlug: "gpt-5.5",
    });
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    trackSpy.mockClear();

    settingStore.getState().applyComposerSelection({
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    });
    expect(trackSpy).not.toHaveBeenCalled();

    runStore.getState().applyComposerSelection({
      selection: {
        harnessId: "claude",
        modelSlug: "claude-sonnet",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    });
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.HarnessChanged, {
      from: "codex",
      to: "claude",
    });
  });
});

describe("composer toolbar store setting purpose: the no-carry effort lever", () => {
  it("a setting store keeps its current effort through applyComposerSelection's \"\" on a re-click of the same pair, while a run store resets to the model's own default", () => {
    const withEfforts = {
      ...model("claude", "current", "Current"),
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { id: "low", label: "Low", description: null },
        { id: "high", label: "High", description: null },
      ],
    };
    const loaded = catalog({
      harnesses: [harness("claude", true)],
      modelsHarnessId: "claude",
      models: [withEfforts],
      modelsLoaded: true,
    });
    const settingStore = createStore({ purpose: "setting" });
    const runStore = createStore({ purpose: "run" });
    settingStore.getState().setCatalog(loaded);
    runStore.getState().setCatalog(loaded);
    // Both stores sit on the model whose row is about to be re-clicked: the
    // setting store keeps its effort only while the committed pair is the
    // one it already holds.
    const current = {
      harnessId: "claude",
      modelSlug: "current",
      profileId: null,
    } as const;
    settingStore.getState().setSelection(current);
    runStore.getState().setSelection(current);
    settingStore.getState().setReasoning("low");
    runStore.getState().setReasoning("low");

    // The funnel's no-carry lever, as a model-row re-click sends it.
    const commit = {
      selection: current,
      reasoning: "",
      serviceTier: "",
    } as const;
    settingStore.getState().applyComposerSelection(commit);
    runStore.getState().applyComposerSelection(commit);

    expect(settingStore.getState().reasoning).toBe("low");
    expect(runStore.getState().reasoning).toBe("high");
  });
});

describe("composer toolbar store setting purpose: the commit funnel owns the setting store's effort", () => {
  // Both models are on the same harness as `createStore`'s default
  // ("claude"), so a commit naming MODEL_X again is a same-pair re-click and
  // one naming MODEL_Y is a same-provider model change - never a harness
  // switch. `reasoningFallback: "lowest"` mirrors the judge's own store
  // (`useJudgeToolbarStore`), the only surface this rule currently binds.
  const MODEL_X = {
    ...model("claude", "model-x", "Model X"),
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { id: "low", label: "Low", description: null },
      { id: "high", label: "High", description: null },
    ],
  };
  const MODEL_Y = {
    ...model("claude", "model-y", "Model Y"),
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { id: "medium", label: "Medium", description: null },
      { id: "high", label: "High", description: null },
      { id: "low", label: "Low", description: null },
    ],
  };

  function loadedCatalog(): ComposerToolbarCatalog {
    return catalog({
      harnesses: [harness("claude", true)],
      modelsHarnessId: "claude",
      models: [MODEL_X, MODEL_Y],
      modelsLoaded: true,
    });
  }

  it("a setting store keeps its own effort when the committed pair is unchanged, ignoring the incoming reasoning", () => {
    const emitted: string[] = [];
    const settingStore = createStore({
      purpose: "setting",
      modelSlug: "model-x",
      reasoningFallback: "lowest",
      onSettingsChange: (settings) =>
        emitted.push(settings.reasoningEffort ?? ""),
    });
    settingStore.getState().setCatalog(loadedCatalog());
    settingStore.getState().setReasoning("low");
    emitted.length = 0;

    // The commit funnel's incoming "high" - as a stale composer-memory read
    // would carry - names the SAME (harness, model) pair already on show.
    settingStore.getState().applyComposerSelection({
      selection: { harnessId: "claude", modelSlug: "model-x", profileId: null },
      reasoning: "high",
      serviceTier: "",
    });

    expect(settingStore.getState().reasoning).toBe("low");
    expect(emitted).toEqual(["low"]);
  });

  it("a setting store resets to the new model's lowest advertised effort when the committed pair changes, ignoring the incoming reasoning", () => {
    const emitted: string[] = [];
    const settingStore = createStore({
      purpose: "setting",
      modelSlug: "model-x",
      reasoningFallback: "lowest",
      onSettingsChange: (settings) =>
        emitted.push(settings.reasoningEffort ?? ""),
    });
    settingStore.getState().setCatalog(loadedCatalog());
    settingStore.getState().setReasoning("low");
    emitted.length = 0;

    settingStore.getState().applyComposerSelection({
      selection: { harnessId: "claude", modelSlug: "model-y", profileId: null },
      reasoning: "high",
      serviceTier: "",
    });

    expect(settingStore.getState().reasoning).toBe("low");
    expect(emitted).toEqual(["low"]);
  });

  it("a run store always takes the incoming reasoning, pair unchanged or not", () => {
    const emitted: string[] = [];
    const runStore = createStore({
      purpose: "run",
      modelSlug: "model-x",
      reasoningFallback: "lowest",
      onSettingsChange: (settings) =>
        emitted.push(settings.reasoningEffort ?? ""),
    });
    runStore.getState().setCatalog(loadedCatalog());
    runStore.getState().setReasoning("low");
    emitted.length = 0;

    runStore.getState().applyComposerSelection({
      selection: { harnessId: "claude", modelSlug: "model-x", profileId: null },
      reasoning: "high",
      serviceTier: "",
    });
    expect(runStore.getState().reasoning).toBe("high");

    runStore.getState().applyComposerSelection({
      selection: { harnessId: "claude", modelSlug: "model-y", profileId: null },
      reasoning: "high",
      serviceTier: "",
    });
    expect(runStore.getState().reasoning).toBe("high");
    expect(emitted).toEqual(["high", "high"]);
  });
});
