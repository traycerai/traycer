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

/**
 * The per-chat Ultracode request is saved intent. The toolbar keeps it across
 * every Claude model and catalog state (offering, excluding, unknown, still
 * loading) and clears it only when another harness is chosen, never reviving
 * it on the way back. A surface that cannot carry the request yet (still
 * loading, reconnecting) neither drops nor rewrites it: the derived and emitted
 * tuple keep the saved intent, and only an explicit off or another harness
 * clears it. No memory or default seeds it.
 */

function model(
  harnessId: ProviderId,
  slug: string,
  metadata: Record<string, unknown>,
): ModelOption {
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
    metadata,
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

const OFFERING = model("claude", "claude-offering", { ultracodeOffered: true });
const EXCLUDING = model("claude", "claude-excluding", {
  ultracodeOffered: false,
});
const UNKNOWN = model("claude", "claude-unknown", {});
const CODEX = model("codex", "gpt-test", {});

function catalog(input: {
  readonly harnessId: ProviderId;
  readonly models: ReadonlyArray<ModelOption>;
  readonly modelsLoaded: boolean;
  readonly ultracodeCarried: boolean;
}): ComposerToolbarCatalog {
  return {
    hostId: null,
    harnesses: [harness("claude"), harness("codex")],
    modelsHarnessId: input.harnessId,
    models: input.models,
    modelsLoaded: input.modelsLoaded,
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: input.ultracodeCarried,
    keepsUnavailablePick: false,
  };
}

const CLAUDE_MODELS = [OFFERING, EXCLUDING, UNKNOWN];

function createStore(input: {
  readonly harnessId: ProviderId;
  readonly modelSlug: string;
  readonly ultracode: boolean;
  readonly ultracodeCarried: boolean;
  readonly emitted: ChatRunSettings[];
}): ComposerToolbarStore {
  const store = createComposerToolbarStore({
    purpose: "setting",
    reasoningFallback: "model-default",
    seedKey: "ultracode",
    values: {
      permission: "supervised",
      selection: {
        harnessId: input.harnessId,
        modelSlug: input.modelSlug,
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
      ultracode: input.ultracode,
    },
    onSettingsChange: (settings) => input.emitted.push(settings),
    tuiOnly: false,
    chatLineCarriesAutoMode: null,
    ultracodeCarried: input.ultracodeCarried,
    hostId: null,
  });
  store.getState().setCatalog(
    catalog({
      harnessId: input.harnessId,
      models: input.harnessId === "claude" ? CLAUDE_MODELS : [CODEX],
      modelsLoaded: true,
      ultracodeCarried: input.ultracodeCarried,
    }),
  );
  return store;
}

describe("composer toolbar Ultracode intent", () => {
  it("keeps true through offering, excluding and offering models and emits it each time", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "claude",
      modelSlug: OFFERING.slug,
      ultracode: false,
      ultracodeCarried: true,
      emitted,
    });

    store.getState().setUltracode(true);
    for (const next of [EXCLUDING, UNKNOWN, OFFERING]) {
      store.getState().setSelection({
        harnessId: "claude",
        modelSlug: next.slug,
        profileId: null,
      });
      expect(store.getState().values.ultracode).toBe(true);
      expect(store.getState().ultracode).toBe(true);
    }

    expect(emitted.map((s) => [s.model, s.ultracode])).toEqual([
      [OFFERING.slug, true],
      [EXCLUDING.slug, true],
      [UNKNOWN.slug, true],
      [OFFERING.slug, true],
    ]);
  });

  it("keeps true while the Claude catalog is loading or unknown, and a catalog push never mutates it", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "claude",
      modelSlug: UNKNOWN.slug,
      ultracode: true,
      ultracodeCarried: true,
      emitted,
    });

    store.getState().setCatalog(
      catalog({
        harnessId: "claude",
        models: [],
        modelsLoaded: false,
        ultracodeCarried: true,
      }),
    );
    expect(store.getState().values.ultracode).toBe(true);
    expect(store.getState().ultracode).toBe(true);

    store.getState().setCatalog(
      catalog({
        harnessId: "claude",
        models: [EXCLUDING],
        modelsLoaded: true,
        ultracodeCarried: true,
      }),
    );
    expect(store.getState().values.ultracode).toBe(true);
    expect(store.getState().ultracode).toBe(true);
  });

  it("keeps the saved request in the derived and emitted tuple while the surface does not carry it", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "claude",
      modelSlug: OFFERING.slug,
      ultracode: true,
      ultracodeCarried: false,
      emitted,
    });
    expect(store.getState().values.ultracode).toBe(true);
    expect(store.getState().ultracode).toBe(true);

    store.getState().setPermission("full_access");
    expect(emitted.at(-1)?.ultracode).toBe(true);

    store.getState().setCatalog(
      catalog({
        harnessId: "claude",
        models: CLAUDE_MODELS,
        modelsLoaded: true,
        ultracodeCarried: true,
      }),
    );
    expect(store.getState().values.ultracode).toBe(true);
    expect(store.getState().ultracode).toBe(true);
  });

  it("only an explicit off clears the request, on any carrier state", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "claude",
      modelSlug: OFFERING.slug,
      ultracode: true,
      ultracodeCarried: false,
      emitted,
    });

    store.getState().setUltracode(false);

    expect(store.getState().values.ultracode).toBe(false);
    expect(store.getState().ultracode).toBe(false);
    expect(emitted.at(-1)?.ultracode).toBe(false);
  });

  it("clears the request on another harness and does not revive it on return", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "claude",
      modelSlug: OFFERING.slug,
      ultracode: true,
      ultracodeCarried: true,
      emitted,
    });

    store.getState().applyComposerSelection({
      selection: { harnessId: "codex", modelSlug: CODEX.slug, profileId: null },
      reasoning: "",
      serviceTier: "",
    });
    expect(store.getState().values.ultracode).toBe(false);

    store.getState().applyComposerSelection({
      selection: {
        harnessId: "claude",
        modelSlug: OFFERING.slug,
        profileId: null,
      },
      reasoning: "",
      serviceTier: "",
    });
    expect(store.getState().values.ultracode).toBe(false);
    expect(store.getState().ultracode).toBe(false);
  });

  it("ignores a request to turn it on while another harness is selected", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "codex",
      modelSlug: CODEX.slug,
      ultracode: false,
      ultracodeCarried: true,
      emitted,
    });

    store.getState().setUltracode(true);

    expect(store.getState().values.ultracode).toBe(false);
    expect(emitted.at(-1)?.ultracode).toBe(false);
  });

  it("restores a saved request from a seed and a different seed replaces it", () => {
    const emitted: ChatRunSettings[] = [];
    const store = createStore({
      harnessId: "claude",
      modelSlug: OFFERING.slug,
      ultracode: false,
      ultracodeCarried: true,
      emitted,
    });
    const values = store.getState().values;

    store.getState().applySeed("restored-chat", { ...values, ultracode: true });
    expect(store.getState().ultracode).toBe(true);
    expect(emitted).toEqual([]);

    store.getState().applySeed("other-chat", { ...values, ultracode: false });
    expect(store.getState().ultracode).toBe(false);
  });
});
