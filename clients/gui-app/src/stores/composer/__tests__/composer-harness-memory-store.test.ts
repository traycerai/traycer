import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  COMPOSER_HARNESS_MEMORY_CAP,
  useComposerHarnessMemoryStore,
} from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerHarnessMemoryKey } from "@/lib/persist";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

const STORAGE_KEY = composerHarnessMemoryKey(null);

const CLAUDE_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "full_access",
  reasoningEffort: "high",
  serviceTier: "flex",
  agentMode: "epic",
};

const CODEX_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
};

function resetStores(): void {
  window.localStorage.clear();
  useComposerHarnessMemoryStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
}

describe("composer harness memory store", () => {
  beforeEach(resetStores);
  afterEach(() => {
    vi.useRealTimers();
    resetStores();
  });

  it("records and resolves a harness switch round-trip", () => {
    useComposerHarnessMemoryStore.getState().record(CLAUDE_SETTINGS);

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("returns empty defaults for a harness with no record", () => {
    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch("unknown-harness"),
    ).toEqual({
      modelSlug: "",
      reasoningEffort: null,
      serviceTier: null,
    });
  });

  it("falls back to globalLastRunSettings when the harness has no record", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(CLAUDE_SETTINGS, 1);

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("does not fall back when globalLastRunSettings is for a different harness", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(CODEX_SETTINGS, 1);

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "",
      reasoningEffort: null,
      serviceTier: null,
    });
  });

  it("lets a real record override the globalLastRunSettings fallback", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(CLAUDE_SETTINGS, 1);
    useComposerHarnessMemoryStore.getState().record({
      ...CLAUDE_SETTINGS,
      model: "opus-4.1",
      reasoningEffort: "low",
      serviceTier: null,
    });

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "opus-4.1",
      reasoningEffort: "low",
      serviceTier: null,
    });
  });

  it("ignores an empty-model record and keeps the lazy fallback intact", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(CLAUDE_SETTINGS, 1);
    useComposerHarnessMemoryStore
      .getState()
      .record({ ...CLAUDE_SETTINGS, model: "" });

    // The empty-model write is a no-op: no record is stored...
    expect(useComposerHarnessMemoryStore.getState().lastModelByHarness).toEqual(
      {},
    );
    // ...so it does not shadow the lazy globalLastRunSettings fallback.
    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("resolveModelSelection hits the exact (harness, model) record", () => {
    useComposerHarnessMemoryStore.getState().record(CLAUDE_SETTINGS);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveModelSelection("claude", "sonnet-4.5"),
    ).toEqual({ reasoningEffort: "high", serviceTier: "flex" });
  });

  it("resolveModelSelection misses with null defaults for an unknown pair", () => {
    useComposerHarnessMemoryStore.getState().record(CLAUDE_SETTINGS);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveModelSelection("claude", "opus-4.1"),
    ).toEqual({ reasoningEffort: null, serviceTier: null });
  });

  it("restores the model slug with null effort/tier when the effort record is evicted", () => {
    useComposerHarnessMemoryStore.getState().record(CLAUDE_SETTINGS);
    useComposerHarnessMemoryStore.setState((state) => ({
      effortByHarnessModel: {},
      lastModelByHarness: state.lastModelByHarness,
    }));

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: null,
      serviceTier: null,
    });
  });

  it("caps the effort map to the newest entries by updatedAt", () => {
    vi.useFakeTimers();
    for (let index = 0; index < COMPOSER_HARNESS_MEMORY_CAP + 1; index += 1) {
      vi.setSystemTime(index);
      useComposerHarnessMemoryStore
        .getState()
        .record({ ...CODEX_SETTINGS, model: `model-${index}` });
    }

    const entries =
      useComposerHarnessMemoryStore.getState().effortByHarnessModel;
    expect(Object.keys(entries)).toHaveLength(COMPOSER_HARNESS_MEMORY_CAP);
    // The oldest record (updatedAt 0) is evicted; the newest survives.
    expect(Object.hasOwn(entries, "codex model-0")).toBe(false);
    expect(
      Object.hasOwn(entries, `codex model-${COMPOSER_HARNESS_MEMORY_CAP}`),
    ).toBe(true);
  });

  it("retargets and clears the memory bucket per email scope", async () => {
    window.localStorage.setItem(
      composerHarnessMemoryKey("alice@example.com"),
      JSON.stringify({
        state: {
          lastModelByHarness: { claude: "sonnet-4.5" },
          effortByHarnessModel: {
            "claude sonnet-4.5": {
              reasoningEffort: "high",
              serviceTier: "flex",
              updatedAt: 1,
            },
          },
        },
        version: 1,
      }),
    );

    retargetPersistedStore({
      store: useComposerHarnessMemoryStore,
      name: composerHarnessMemoryKey("alice@example.com"),
    });
    await useComposerHarnessMemoryStore.persist.rehydrate();

    expect(useComposerHarnessMemoryStore.persist.getOptions().name).toBe(
      composerHarnessMemoryKey("alice@example.com"),
    );
    expect(useComposerHarnessMemoryStore.getState().lastModelByHarness).toEqual(
      { claude: "sonnet-4.5" },
    );

    clearAndResetPersistedStore({
      store: useComposerHarnessMemoryStore,
      anonymousName: composerHarnessMemoryKey(null),
    });

    expect(
      window.localStorage.getItem(
        composerHarnessMemoryKey("alice@example.com"),
      ),
    ).toBeNull();
    expect(useComposerHarnessMemoryStore.persist.getOptions().name).toBe(
      composerHarnessMemoryKey(null),
    );
    expect(useComposerHarnessMemoryStore.getState().lastModelByHarness).toEqual(
      {},
    );
  });
});
