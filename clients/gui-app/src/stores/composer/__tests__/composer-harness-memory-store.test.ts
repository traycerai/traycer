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
  profileId: null,
};

const CODEX_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
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

  it("remembers the last selected profile independently per harness, including ambient", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    memory.recordProfileSelection("codex", "work-profile");
    memory.recordProfileSelection("claude", "personal-profile");

    expect(memory.resolveLastProfile("codex")).toBe("work-profile");
    expect(memory.resolveLastProfile("claude")).toBe("personal-profile");

    memory.recordProfileSelection("codex", null);
    expect(memory.resolveLastProfile("codex")).toBeNull();
    expect(memory.resolveLastProfile("cursor")).toBeNull();
    expect(
      useComposerHarnessMemoryStore.getState().lastProfileByHarness,
    ).toEqual({
      codex: null,
      claude: "personal-profile",
    });
  });

  it("overwrites one bounded slot per harness instead of accumulating profile ids", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    for (let index = 0; index < 100; index += 1) {
      memory.recordProfileSelection("codex", `profile-${index}`);
    }

    expect(
      Object.keys(
        useComposerHarnessMemoryStore.getState().lastProfileByHarness,
      ),
    ).toEqual(["codex"]);
    expect(memory.resolveLastProfile("codex")).toBe("profile-99");
  });

  it("does not publish an identical profile selection twice", () => {
    let updates = 0;
    const unsubscribe = useComposerHarnessMemoryStore.subscribe(() => {
      updates += 1;
    });
    const memory = useComposerHarnessMemoryStore.getState();

    memory.recordProfileSelection("codex", "work-profile");
    memory.recordProfileSelection("codex", "work-profile");

    unsubscribe();
    expect(updates).toBe(1);
  });

  it("records a confirmed settings profile in the per-harness profile memory", () => {
    useComposerHarnessMemoryStore.getState().record({
      ...CLAUDE_SETTINGS,
      profileId: "work-profile",
    });

    expect(
      useComposerHarnessMemoryStore.getState().resolveLastProfile("claude"),
    ).toBe("work-profile");
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

    // The empty model is not stored in model memory...
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
    // Pre-profile persisted blobs have no profile-memory field; Zustand's
    // merge preserves the store default instead of producing `undefined`.
    expect(
      useComposerHarnessMemoryStore.getState().lastProfileByHarness,
    ).toEqual({});

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
    expect(
      useComposerHarnessMemoryStore.getState().lastProfileByHarness,
    ).toEqual({});
  });

  it("keeps one last-model memory for a provider across profile changes", () => {
    useComposerHarnessMemoryStore
      .getState()
      .record({ ...CLAUDE_SETTINGS, model: "sonnet-4.5", profileId: "work" });
    useComposerHarnessMemoryStore.getState().record({
      ...CLAUDE_SETTINGS,
      model: "opus-4.1",
      profileId: "personal",
    });

    expect(useComposerHarnessMemoryStore.getState().lastModelByHarness).toEqual(
      { claude: "opus-4.1" },
    );
    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toMatchObject({ modelSlug: "opus-4.1" });
  });

  it("keeps one model effort/tier record across profile changes", () => {
    useComposerHarnessMemoryStore
      .getState()
      .record({ ...CLAUDE_SETTINGS, profileId: null, reasoningEffort: "low" });
    useComposerHarnessMemoryStore.getState().record({
      ...CLAUDE_SETTINGS,
      profileId: "work",
      reasoningEffort: "high",
    });

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveModelSelection("claude", "sonnet-4.5"),
    ).toEqual({ reasoningEffort: "high", serviceTier: "flex" });
  });

  it("loads and migrates a pre-profile localStorage blob", async () => {
    // Simulates a user's real, already-serialized state from before profiles
    // existed: `lastModelByHarness` keyed by bare harnessId,
    // `effortByHarnessModel` keyed by the old space-joined `"harness model"`
    // format. These keys are already the v2 provider/model identity, so the
    // migration preserves them unchanged.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          lastModelByHarness: { claude: "sonnet-4.5", codex: "gpt-5-codex" },
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

    await expect(
      useComposerHarnessMemoryStore.persist.rehydrate(),
    ).resolves.not.toThrow();

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("migrates profile-scoped v1 memory into independent profile and model states", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          lastProfileByHarness: { claude: "work" },
          lastModelByHarness: {
            '["claude","work"]': "opus-4.1",
            '["claude","personal"]': "sonnet-4.5",
          },
          effortByHarnessModel: {
            '["claude","work","opus-4.1"]': {
              reasoningEffort: "low",
              serviceTier: null,
              updatedAt: 1,
            },
            '["claude","personal","sonnet-4.5"]': {
              reasoningEffort: "high",
              serviceTier: "flex",
              updatedAt: 2,
            },
          },
        },
        version: 1,
      }),
    );

    await useComposerHarnessMemoryStore.persist.rehydrate();

    const memory = useComposerHarnessMemoryStore.getState();
    expect(memory.resolveLastProfile("claude")).toBe("work");
    expect(memory.lastModelByHarness).toEqual({ claude: "sonnet-4.5" });
    expect(memory.resolveHarnessSwitch("claude")).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
    expect(memory.resolveModelSelection("claude", "opus-4.1")).toEqual({
      reasoningEffort: "low",
      serviceTier: null,
    });
  });

  it("prefers the remembered profile's effort when v1 timestamps tie", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          lastProfileByHarness: { claude: "work" },
          lastModelByHarness: {
            '["claude","work"]': "sonnet-4.5",
            '["claude","personal"]': "sonnet-4.5",
          },
          effortByHarnessModel: {
            '["claude","work","sonnet-4.5"]': {
              reasoningEffort: "high",
              serviceTier: "flex",
              updatedAt: 1,
            },
            '["claude","personal","sonnet-4.5"]': {
              reasoningEffort: "low",
              serviceTier: null,
              updatedAt: 1,
            },
          },
        },
        version: 1,
      }),
    );

    await useComposerHarnessMemoryStore.persist.rehydrate();

    expect(
      useComposerHarnessMemoryStore.getState().resolveHarnessSwitch("claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });
});
