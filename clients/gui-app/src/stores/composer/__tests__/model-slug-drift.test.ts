import "../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import {
  findSelectedModel,
  type ModelOption,
} from "@/components/home/data/landing-options";
import {
  createComposerToolbarStore,
  type ComposerToolbarCatalog,
} from "@/stores/composer/composer-toolbar-store";

function model(
  slug: string,
  resolvedModel: string | null,
  label: string,
): ModelOption {
  return {
    harnessId: "claude",
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: resolvedModel === null ? {} : { resolvedModel },
  };
}

function catalog(models: ReadonlyArray<ModelOption>): ComposerToolbarCatalog {
  return {
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        enabled: true,
        available: true,
        error: null,
        modes: ["gui", "tui"],
        requiresApiKey: false,
        supportedPermissionModes: ["supervised", "full_access"],
        availabilityPending: false,
      },
    ],
    modelsHarnessId: "claude",
    models,
    modelsLoaded: true,
    tuiOnly: false,
  };
}

function createStore(
  modelSlug: string,
  onSettingsChange: ((model: string) => void) | null,
) {
  return createComposerToolbarStore({
    seedKey: `model-slug-${modelSlug}`,
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug, profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange:
      onSettingsChange === null
        ? null
        : (settings) => onSettingsChange(settings.model),
    tuiOnly: false,
  });
}

describe("composer toolbar model slug drift", () => {
  it("resolves forward drift through an unambiguous alias without rewriting the stored slug", () => {
    const emitted: string[] = [];
    const store = createStore("claude-fable-5", (modelSlug) => {
      emitted.push(modelSlug);
    });

    const decorated = model(
      "claude-fable-5[1m]",
      "claude-fable-5",
      "Fable 5 (1M)",
    );
    const models = [
      decorated,
      model("default", "claude-opus-5[1m]", "Default"),
    ];
    store.getState().setCatalog(catalog(models));

    // The pre-fix failure was healing to Default. The fix is NOT to heal to the
    // decorated row instead: the read resolves it, so the stored slug is left
    // exactly as the user pinned it.
    expect(store.getState().selection.modelSlug).toBe("claude-fable-5");
    expect(store.getState().values.selection.modelSlug).toBe("claude-fable-5");
    expect(store.getState().selection.modelSlug).not.toBe("default");
    expect(emitted).toEqual([]);
    expect(findSelectedModel(models, store.getState().selection)).toMatchObject(
      { slug: "claude-fable-5[1m]", label: "Fable 5 (1M)" },
    );
  });

  it("never converts a version pin into the floating row slug that aliases it", () => {
    const emitted: string[] = [];
    // `sonnet` publishes `claude-sonnet-5`, so the pin alias-matches exactly one
    // row. Persisting that row's slug would swap a pinned version for a pointer
    // that follows the account to the next Sonnet — the same floating-pointer
    // harm as the ambiguous case, arriving through the unambiguous door.
    const store = createStore("claude-sonnet-5", (modelSlug) => {
      emitted.push(modelSlug);
    });
    const models = [
      model("default", "claude-opus-5[1m]", "Default"),
      model("sonnet", "claude-sonnet-5", "Sonnet"),
    ];

    store.getState().setCatalog(catalog(models));

    expect(store.getState().values.selection.modelSlug).toBe("claude-sonnet-5");
    expect(store.getState().selection.modelSlug).not.toBe("sonnet");
    expect(emitted).toEqual([]);
    expect(findSelectedModel(models, store.getState().selection)).toMatchObject(
      { slug: "sonnet" },
    );
  });

  it("confirms a held alias against the catalog so settings are still recorded", () => {
    // Coverage and write-permission are different questions. Holding the slug
    // must not leave the selection in the same unconfirmed state as a dead one,
    // or every downstream memory write for it is silently skipped.
    const store = createStore("claude-opus-5[1m]", null);
    store
      .getState()
      .setCatalog(
        catalog([
          model("default", "claude-opus-5[1m]", "Default"),
          model("opus[1m]", "claude-opus-5[1m]", "Opus (1M)"),
        ]),
      );

    expect(store.getState().selectionCatalogConfirmed).toBe(true);
  });

  it("pins the known reverse-drift gap: old decorated slugs fall back to Default", () => {
    const emitted: string[] = [];
    const store = createStore("opus[1m]", (modelSlug) => {
      emitted.push(modelSlug);
    });

    store
      .getState()
      .setCatalog(
        catalog([
          model("default", "claude-opus-5[1m]", "Default"),
          model("opus", "claude-opus-5", "Opus"),
        ]),
      );

    // KNOWN, DELIBERATELY UNFIXED GAP: the old decorated form is in neither
    // the exact slug nor resolvedModel field, so the two-pass resolver misses.
    expect(store.getState().selection.modelSlug).toBe("default");
    expect(store.getState().values.selection.modelSlug).toBe("default");
    expect(emitted).toEqual(["default"]);
  });

  it("does not rewrite an ambiguous alias, while the read side still resolves a row", () => {
    const emitted: string[] = [];
    const store = createStore("claude-opus-5[1m]", (modelSlug) => {
      emitted.push(modelSlug);
    });
    const models = [
      model("default", "claude-opus-5[1m]", "Default"),
      model("opus[1m]", "claude-opus-5[1m]", "Opus (1M)"),
    ];

    store.getState().setCatalog(catalog(models));

    expect(store.getState().values.selection.modelSlug).toBe(
      "claude-opus-5[1m]",
    );
    expect(store.getState().selection.modelSlug).toBe("claude-opus-5[1m]");
    expect(emitted).toEqual([]);
    expect(findSelectedModel(models, store.getState().selection)).toMatchObject(
      { slug: "default", label: "Default" },
    );
  });

  it("lets an exact slug win over an alias match", () => {
    const exact = model("shared-id", "other-wire-id", "Exact row");
    const alias = model("alias-row", "shared-id", "Alias row");
    const store = createStore("shared-id", null);

    store.getState().setCatalog(catalog([alias, exact]));

    expect(store.getState().selection.modelSlug).toBe("shared-id");
    expect(store.getState().selectedModel).toBe(exact);
  });

  it("keeps a remembered slug while the catalog is loading", () => {
    // The catalog deliberately does NOT carry the remembered slug. With it
    // present, coverage returns first and the `catalogLoadedForHarness` guard
    // this test is named for never executes - it would pass with the guard
    // deleted. An unresolvable slug is held ONLY because the catalog is still
    // loading; "heals a genuinely delisted slug" below feeds an equally
    // unresolvable slug to a loaded catalog and gets Default, so the two pin
    // opposite directions of the same guard.
    const emitted: string[] = [];
    const store = createStore("remembered-slug", (modelSlug) => {
      emitted.push(modelSlug);
    });

    store.getState().setCatalog({
      ...catalog([model("default", null, "Default")]),
      modelsLoaded: false,
    });

    expect(store.getState().selection.modelSlug).toBe("remembered-slug");
    expect(store.getState().values.selection.modelSlug).toBe("remembered-slug");
    expect(emitted).toEqual([]);
  });

  it("resolves an empty slug to the preferred first model", () => {
    const store = createStore("", null);

    store
      .getState()
      .setCatalog(
        catalog([
          model("preferred", null, "Preferred"),
          model("other", null, "other"),
        ]),
      );

    expect(store.getState().selection.modelSlug).toBe("preferred");
    expect(store.getState().values.selection.modelSlug).toBe("");
  });

  it("heals a genuinely delisted slug to Default", () => {
    const emitted: string[] = [];
    const store = createStore("delisted-slug", (modelSlug) => {
      emitted.push(modelSlug);
    });

    store
      .getState()
      .setCatalog(
        catalog([
          model("default", null, "Default"),
          model("current", null, "current"),
        ]),
      );

    expect(store.getState().selection.modelSlug).toBe("default");
    expect(store.getState().values.selection.modelSlug).toBe("default");
    expect(emitted).toEqual(["default"]);
  });
});
