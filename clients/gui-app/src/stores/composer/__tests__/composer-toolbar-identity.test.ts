/**
 * `ComposerToolbarStore.setIdentityId` / `applySeed` for the `identityId`
 * field: it rides the same commit funnel as every other toolbar edit
 * (`update()`), so it is gated by the same "don't emit an unresolved model"
 * rule the model-slug tests in this folder pin. See `composer-toolbar-store.ts`.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/components/home/data/landing-options";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  createComposerToolbarStore,
  type ComposerToolbarCatalog,
  type ComposerToolbarValues,
} from "@/stores/composer/composer-toolbar-store";

function model(slug: string, label: string): ModelOption {
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
    metadata: {},
  };
}

function catalog(
  models: ReadonlyArray<ModelOption>,
  modelsLoaded: boolean,
): ComposerToolbarCatalog {
  return {
    hostId: null,
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
        nativeAutoJudge: false,
        availabilityPending: false,
      },
    ],
    modelsHarnessId: "claude",
    models,
    modelsLoaded,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
  };
}

function values(
  overrides: Partial<ComposerToolbarValues>,
): ComposerToolbarValues {
  return {
    permission: "supervised",
    selection: { harnessId: "claude", modelSlug: "sonnet", profileId: null },
    reasoning: "",
    serviceTier: "",
    identityId: null,
    ...overrides,
  };
}

describe("composer toolbar store - identityId", () => {
  it("emits identityId once a catalog has resolved the model slug", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: values({}),
      onSettingsChange: (settings) => emitted.push(settings),
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    });
    store.getState().setCatalog(catalog([model("sonnet", "Sonnet")], true));
    expect(emitted).toEqual([]); // the catalog push alone must not emit

    store.getState().setIdentityId("idA");

    expect(store.getState().identityId).toBe("idA");
    expect(store.getState().values.identityId).toBe("idA");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].identityId).toBe("idA");
    expect(emitted[0].model).toBe("sonnet");
  });

  it("emits identityId: null when clearing a previously set identity", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: values({ identityId: "idA" }),
      onSettingsChange: (settings) => emitted.push(settings),
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    });
    store.getState().setCatalog(catalog([model("sonnet", "Sonnet")], true));
    expect(emitted).toEqual([]);

    store.getState().setIdentityId(null);

    expect(store.getState().identityId).toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].identityId).toBeNull();
  });

  it("defers an identity edit made while the model slug is unresolved, then flushes it once the catalog resolves", () => {
    const emitted: ChatRunSettings[] = [];
    // An empty raw model slug resolves to "" until a loaded catalog supplies a
    // default - the same "unresolved" state the model-slug-drift suite exercises.
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: values({
        selection: { harnessId: "claude", modelSlug: "", profileId: null },
      }),
      onSettingsChange: (settings) => emitted.push(settings),
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    });
    expect(store.getState().selection.modelSlug).toBe("");

    store.getState().setIdentityId("idA");

    expect(store.getState().identityId).toBe("idA");
    expect(store.getState().pendingSettingsEmit).toBe(true);
    expect(emitted).toEqual([]);

    store
      .getState()
      .setCatalog(catalog([model("preferred", "Preferred")], true));

    expect(store.getState().pendingSettingsEmit).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].identityId).toBe("idA");
    expect(emitted[0].model).toBe("preferred");
  });

  it("applySeed carries an identity into the store without emitting", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: values({}),
      onSettingsChange: (settings) => emitted.push(settings),
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    });

    store.getState().applySeed("seed-2", values({ identityId: "idB" }));

    expect(store.getState().seedKey).toBe("seed-2");
    expect(store.getState().identityId).toBe("idB");
    expect(store.getState().values.identityId).toBe("idB");
    expect(emitted).toEqual([]);
  });

  it("applySeed is a no-op on a matching seed key, leaving a user edit untouched", () => {
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: values({ identityId: "idA" }),
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    });
    store.getState().setCatalog(catalog([model("sonnet", "Sonnet")], true));
    store.getState().setIdentityId("idB");
    expect(store.getState().identityId).toBe("idB");

    store.getState().applySeed("seed-1", values({ identityId: "idA" }));

    expect(store.getState().identityId).toBe("idB");
  });
});
