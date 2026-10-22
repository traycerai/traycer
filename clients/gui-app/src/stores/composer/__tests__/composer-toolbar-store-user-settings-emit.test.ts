/**
 * `onUserSettingsChange` is the composer's "the user changed the run settings"
 * signal (a non-empty draft follows it with a prestart). A harness switch whose
 * model is still unresolved defers its emit; the catalog load that resolves the
 * concrete model must flush that user edit to the user signal exactly once.
 */
import { describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type {
  HarnessOption,
  ModelOption,
  ProviderId,
} from "@/components/home/data/landing-options";
import {
  createComposerToolbarStore,
  type ComposerToolbarCatalog,
  type ComposerToolbarStore,
} from "@/stores/composer/composer-toolbar-store";

function model(harnessId: ProviderId, slug: string): ModelOption {
  return {
    harnessId,
    slug,
    label: slug,
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

function harness(id: ProviderId): HarnessOption {
  return {
    id,
    label: id,
    enabled: true,
    available: true,
    error: null,
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: ["supervised", "full_access"],
    nativeAutoJudge: false,
    availabilityPending: false,
  };
}

function catalog(
  modelsHarnessId: ProviderId,
  models: ReadonlyArray<ModelOption>,
  modelsLoaded: boolean,
): ComposerToolbarCatalog {
  return {
    hostId: null,
    harnesses: [harness("claude"), harness("codex")],
    modelsHarnessId,
    models,
    modelsLoaded,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
  };
}

interface Observed {
  readonly store: ComposerToolbarStore;
  readonly surface: ChatRunSettings[];
  readonly user: ChatRunSettings[];
}

function claudeToolbar(): Observed {
  const surface: ChatRunSettings[] = [];
  const user: ChatRunSettings[] = [];
  const store = createComposerToolbarStore({
    purpose: "run",
    reasoningFallback: "model-default",
    seedKey: "user-settings-emit",
    values: {
      permission: "supervised",
      selection: {
        harnessId: "claude",
        modelSlug: "claude-opus",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: (settings) => surface.push(settings),
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    hostId: null,
  });
  store.setState({ onUserSettingsChange: (settings) => user.push(settings) });
  store
    .getState()
    .setCatalog(catalog("claude", [model("claude", "claude-opus")], true));
  return { store, surface, user };
}

describe("onUserSettingsChange across a deferred harness switch", () => {
  it("fires exactly once, with the resolved model, when the catalog settles a harness switch made while the model was unresolved", () => {
    const { store, surface, user } = claudeToolbar();

    store.getState().applyComposerSelection({
      selection: { harnessId: "codex", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    });
    expect(store.getState().pendingSettingsEmit).toBe(true);
    expect(user).toEqual([]);

    store
      .getState()
      .setCatalog(catalog("codex", [model("codex", "gpt-5.5")], true));

    expect(store.getState().pendingSettingsEmit).toBe(false);
    expect(surface).toHaveLength(1);
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ harnessId: "codex", model: "gpt-5.5" });
    expect(user[0]).toEqual(surface[0]);
  });

  it("does not fire again when the same catalog later gains a model", () => {
    const { store, user } = claudeToolbar();
    store.getState().applyComposerSelection({
      selection: { harnessId: "codex", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    });
    store
      .getState()
      .setCatalog(catalog("codex", [model("codex", "gpt-5.5")], true));
    expect(user).toHaveLength(1);

    store
      .getState()
      .setCatalog(
        catalog(
          "codex",
          [model("codex", "gpt-5.5"), model("codex", "gpt-extra")],
          true,
        ),
      );

    expect(user).toHaveLength(1);
  });

  it("never fires for a catalog push that carries no deferred user edit", () => {
    const { store, user } = claudeToolbar();

    store
      .getState()
      .setCatalog(
        catalog(
          "claude",
          [model("claude", "claude-opus"), model("claude", "claude-extra")],
          true,
        ),
      );

    expect(store.getState().pendingSettingsEmit).toBe(false);
    expect(user).toEqual([]);
  });

  it("never fires for a programmatic reseed", () => {
    const { store, user } = claudeToolbar();

    store.getState().applySeed("another-seed", {
      permission: "supervised",
      selection: {
        harnessId: "codex",
        modelSlug: "gpt-5.5",
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    });

    expect(user).toEqual([]);
  });

  it("fires immediately for a user edit whose model is already resolved", () => {
    const { store, user } = claudeToolbar();

    store.getState().setPermission("full_access");

    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ model: "claude-opus" });
  });
});
