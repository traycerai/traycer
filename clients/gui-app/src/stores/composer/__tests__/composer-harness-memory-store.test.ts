import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  COMPOSER_HARNESS_MEMORY_CAP,
  migrateComposerHarnessMemoryPersistedState,
  migrateComposerHarnessMemoryPersistedStateV3,
  selectLastProfileByHarness,
  useComposerHarnessMemoryStore,
} from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerHarnessMemoryKey } from "@/lib/persist";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

const STORAGE_KEY = composerHarnessMemoryKey(null);

// Two distinct hosts so a test can prove a read/write on one never leaks into
// the other, and that a host with no record of its own falls through to the
// frozen `legacy` bucket.
const HOST_A = "host-a";
const HOST_B = "host-b";

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
    useComposerHarnessMemoryStore.getState().record(HOST_A, CLAUDE_SETTINGS);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("remembers the last selected profile independently per harness, including ambient", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    memory.recordProfileSelection(HOST_A, "codex", "work-profile");
    memory.recordProfileSelection(HOST_A, "claude", "personal-profile");

    expect(memory.resolveLastProfile(HOST_A, "codex")).toBe("work-profile");
    expect(memory.resolveLastProfile(HOST_A, "claude")).toBe(
      "personal-profile",
    );

    memory.recordProfileSelection(HOST_A, "codex", null);
    expect(memory.resolveLastProfile(HOST_A, "codex")).toBeNull();
    expect(memory.resolveLastProfile(HOST_A, "cursor")).toBeNull();
    expect(
      useComposerHarnessMemoryStore.getState().byHost[HOST_A]
        .lastProfileByHarness,
    ).toEqual({
      codex: null,
      claude: "personal-profile",
    });
  });

  it("overwrites one bounded slot per harness instead of accumulating profile ids", () => {
    const memory = useComposerHarnessMemoryStore.getState();
    for (let index = 0; index < 100; index += 1) {
      memory.recordProfileSelection(HOST_A, "codex", `profile-${index}`);
    }

    expect(
      Object.keys(
        useComposerHarnessMemoryStore.getState().byHost[HOST_A]
          .lastProfileByHarness,
      ),
    ).toEqual(["codex"]);
    expect(memory.resolveLastProfile(HOST_A, "codex")).toBe("profile-99");
  });

  it("does not publish an identical profile selection twice", () => {
    let updates = 0;
    const unsubscribe = useComposerHarnessMemoryStore.subscribe(() => {
      updates += 1;
    });
    const memory = useComposerHarnessMemoryStore.getState();

    memory.recordProfileSelection(HOST_A, "codex", "work-profile");
    memory.recordProfileSelection(HOST_A, "codex", "work-profile");

    unsubscribe();
    expect(updates).toBe(1);
  });

  it("records a confirmed settings profile in the per-harness profile memory", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      ...CLAUDE_SETTINGS,
      profileId: "work-profile",
    });

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveLastProfile(HOST_A, "claude"),
    ).toBe("work-profile");
  });

  it("returns empty defaults for a harness with no record", () => {
    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "unknown-harness"),
    ).toEqual({
      modelSlug: "",
      reasoningEffort: null,
      serviceTier: null,
    });
  });

  it("falls back to globalLastRunSettings when the harness has no record", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, CLAUDE_SETTINGS, 1);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("does not fall back when globalLastRunSettings is for a different harness", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, CODEX_SETTINGS, 1);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toEqual({
      modelSlug: "",
      reasoningEffort: null,
      serviceTier: null,
    });
  });

  it("lets a real record override the globalLastRunSettings fallback", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, CLAUDE_SETTINGS, 1);
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      ...CLAUDE_SETTINGS,
      model: "opus-4.1",
      reasoningEffort: "low",
      serviceTier: null,
    });

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toEqual({
      modelSlug: "opus-4.1",
      reasoningEffort: "low",
      serviceTier: null,
    });
  });

  it("ignores an empty-model record and keeps the lazy fallback intact", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST_A, CLAUDE_SETTINGS, 1);
    useComposerHarnessMemoryStore
      .getState()
      .record(HOST_A, { ...CLAUDE_SETTINGS, model: "" });

    // The empty model is not stored in model memory...
    expect(
      useComposerHarnessMemoryStore.getState().byHost[HOST_A]
        .lastModelByHarness,
    ).toEqual({});
    // ...so it does not shadow the lazy globalLastRunSettings fallback.
    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  it("resolveModelSelection hits the exact (harness, model) record", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, CLAUDE_SETTINGS);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveModelSelection(HOST_A, "claude", "sonnet-4.5"),
    ).toEqual({ reasoningEffort: "high", serviceTier: "flex" });
  });

  it("resolveModelSelection misses with null defaults for an unknown pair", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, CLAUDE_SETTINGS);

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveModelSelection(HOST_A, "claude", "opus-4.1"),
    ).toEqual({ reasoningEffort: null, serviceTier: null });
  });

  it("restores the model slug with null effort/tier when the effort record is evicted", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, CLAUDE_SETTINGS);
    useComposerHarnessMemoryStore.setState((state) => ({
      byHost: {
        ...state.byHost,
        [HOST_A]: {
          ...state.byHost[HOST_A],
          effortByHarnessModel: {},
        },
      },
    }));

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
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
        .record(HOST_A, { ...CODEX_SETTINGS, model: `model-${index}` });
    }

    const entries =
      useComposerHarnessMemoryStore.getState().byHost[HOST_A]
        .effortByHarnessModel;
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
      // This arm is about the v1 -> v2 host-bucketing migration, not the
      // email -> userId re-scope, so there is no legacy key to adopt.
      legacyName: null,
    });
    await useComposerHarnessMemoryStore.persist.rehydrate();

    expect(useComposerHarnessMemoryStore.persist.getOptions().name).toBe(
      composerHarnessMemoryKey("alice@example.com"),
    );
    // v1 data with no host coordinate lands entirely in the read-only
    // `legacy` bucket; `byHost` stays empty (a migration cannot know which
    // host the flat data belonged to).
    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});
    expect(
      useComposerHarnessMemoryStore.getState().legacy.lastModelByHarness,
    ).toEqual({ claude: "sonnet-4.5" });
    // Pre-profile persisted blobs have no profile-memory field; the migration
    // normalizes it to an empty object.
    expect(
      useComposerHarnessMemoryStore.getState().legacy.lastProfileByHarness,
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
    expect(
      useComposerHarnessMemoryStore.getState().legacy.lastModelByHarness,
    ).toEqual({});
    expect(
      useComposerHarnessMemoryStore.getState().legacy.lastProfileByHarness,
    ).toEqual({});
  });

  it("keeps one last-model memory for a provider across profile changes", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      ...CLAUDE_SETTINGS,
      model: "sonnet-4.5",
      profileId: "work",
    });
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      ...CLAUDE_SETTINGS,
      model: "opus-4.1",
      profileId: "personal",
    });

    expect(
      useComposerHarnessMemoryStore.getState().byHost[HOST_A]
        .lastModelByHarness,
    ).toEqual({ claude: "opus-4.1" });
    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toMatchObject({ modelSlug: "opus-4.1" });
  });

  it("keeps one model effort/tier record across profile changes", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      ...CLAUDE_SETTINGS,
      profileId: null,
      reasoningEffort: "low",
    });
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      ...CLAUDE_SETTINGS,
      profileId: "work",
      reasoningEffort: "high",
    });

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveModelSelection(HOST_A, "claude", "sonnet-4.5"),
    ).toEqual({ reasoningEffort: "high", serviceTier: "flex" });
  });

  it("loads and migrates a pre-profile localStorage blob", async () => {
    // Simulates a user's real, already-serialized state from before profiles
    // existed: `lastModelByHarness` keyed by bare harnessId,
    // `effortByHarnessModel` keyed by the old space-joined `"harness model"`
    // format. These keys are already the v2 provider/model identity, so the
    // migration preserves them unchanged - and, since v3 now wraps v1/v2
    // output verbatim as `legacy`, a host with no record of its own still
    // resolves through it.
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
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
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
    expect(memory.resolveLastProfile(HOST_A, "claude")).toBe("work");
    expect(memory.legacy.lastModelByHarness).toEqual({ claude: "sonnet-4.5" });
    expect(memory.resolveHarnessSwitch(HOST_A, "claude")).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
    expect(memory.resolveModelSelection(HOST_A, "claude", "opus-4.1")).toEqual({
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
      useComposerHarnessMemoryStore
        .getState()
        .resolveHarnessSwitch(HOST_A, "claude"),
    ).toEqual({
      modelSlug: "sonnet-4.5",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
  });

  describe("v3 host-scoping migration", () => {
    it("migrateComposerHarnessMemoryPersistedStateV3 wraps the v1/v2 migration output as legacy with an empty byHost", () => {
      const persisted = {
        lastModelByHarness: { claude: "sonnet-4.5" },
        effortByHarnessModel: {
          "claude sonnet-4.5": {
            reasoningEffort: "high",
            serviceTier: "flex",
            updatedAt: 1,
          },
        },
      };

      const migrated = migrateComposerHarnessMemoryPersistedStateV3(persisted);

      expect(migrated).toEqual({
        byHost: {},
        legacy: migrateComposerHarnessMemoryPersistedState(persisted),
      });
      expect(migrated.legacy.lastModelByHarness).toEqual({
        claude: "sonnet-4.5",
      });
    });

    it("wraps non-record input into an empty legacy bucket rather than throwing", () => {
      expect(migrateComposerHarnessMemoryPersistedStateV3(null)).toEqual({
        byHost: {},
        legacy: {
          lastProfileByHarness: {},
          lastModelByHarness: {},
          effortByHarnessModel: {},
        },
      });
    });

    it("rehydrates v2 (post-profile, pre-host) persisted data into the legacy bucket with byHost empty", async () => {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state: {
            lastProfileByHarness: { claude: "work" },
            lastModelByHarness: { claude: "sonnet-4.5" },
            effortByHarnessModel: {
              "claude sonnet-4.5": {
                reasoningEffort: "high",
                serviceTier: "flex",
                updatedAt: 1,
              },
            },
          },
          version: 2,
        }),
      );

      await useComposerHarnessMemoryStore.persist.rehydrate();

      const state = useComposerHarnessMemoryStore.getState();
      expect(state.byHost).toEqual({});
      expect(state.legacy.lastProfileByHarness).toEqual({ claude: "work" });
      expect(state.legacy.lastModelByHarness).toEqual({
        claude: "sonnet-4.5",
      });
      expect(state.resolveHarnessSwitch(HOST_A, "claude")).toEqual({
        modelSlug: "sonnet-4.5",
        reasoningEffort: "high",
        serviceTier: "flex",
      });
    });
  });

  describe("per-host isolation", () => {
    it("a host with no record of its own falls through to legacy per-key", () => {
      useComposerHarnessMemoryStore.setState({
        legacy: {
          lastProfileByHarness: { claude: "legacy-profile" },
          lastModelByHarness: { claude: "legacy-model" },
          effortByHarnessModel: {
            "claude legacy-model": {
              reasoningEffort: "medium",
              serviceTier: "standard",
              updatedAt: 1,
            },
          },
        },
      });
      useComposerHarnessMemoryStore.getState().record(HOST_A, CLAUDE_SETTINGS);

      // Host A has its own record now and never sees legacy.
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveHarnessSwitch(HOST_A, "claude"),
      ).toEqual({
        modelSlug: "sonnet-4.5",
        reasoningEffort: "high",
        serviceTier: "flex",
      });
      // Host B has no record at all, so it falls through to legacy.
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveHarnessSwitch(HOST_B, "claude"),
      ).toEqual({
        modelSlug: "legacy-model",
        reasoningEffort: "medium",
        serviceTier: "standard",
      });
      // The selector overlays the same way: host A's own value wins, host B
      // falls back to legacy.
      const state = useComposerHarnessMemoryStore.getState();
      expect(selectLastProfileByHarness(state, HOST_A)).toEqual({
        claude: null,
      });
      expect(selectLastProfileByHarness(state, HOST_B)).toEqual({
        claude: "legacy-profile",
      });
    });

    it("a stored null profile in a host bucket does not fall through to a non-null legacy profile", () => {
      useComposerHarnessMemoryStore.setState({
        legacy: {
          lastProfileByHarness: { claude: "legacy-profile" },
          lastModelByHarness: {},
          effortByHarnessModel: {},
        },
      });
      useComposerHarnessMemoryStore
        .getState()
        .recordProfileSelection(HOST_A, "claude", null);

      // `hasOwn`, not `??`: the explicit `null` IS host A's remembered
      // ambient choice and must not fall through to the legacy value.
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveLastProfile(HOST_A, "claude"),
      ).toBeNull();
      // Host B never recorded anything, so it still falls through.
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveLastProfile(HOST_B, "claude"),
      ).toBe("legacy-profile");
    });

    it("drops record/recordProfileSelection writes when hostId is null", () => {
      useComposerHarnessMemoryStore.getState().record(null, CLAUDE_SETTINGS);
      useComposerHarnessMemoryStore
        .getState()
        .recordProfileSelection(null, "claude", "some-profile");

      expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveHarnessSwitch(null, "claude"),
      ).toEqual({
        modelSlug: "",
        reasoningEffort: null,
        serviceTier: null,
      });
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveLastProfile(null, "claude"),
      ).toBeNull();
    });

    it("resolveHarnessSwitch prefers the host's own last-run settings over the legacy model tier", () => {
      useComposerHarnessMemoryStore.setState({
        legacy: {
          lastProfileByHarness: {},
          lastModelByHarness: { claude: "legacy-model" },
          effortByHarnessModel: {
            "claude legacy-model": {
              reasoningEffort: "low",
              serviceTier: null,
              updatedAt: 1,
            },
          },
        },
      });
      useComposerRunSettingsStore
        .getState()
        .setGlobalRunSettings(HOST_A, CLAUDE_SETTINGS, 1);

      // No per-harness record on host A, but its own globalLastRunSettings
      // entry (same harness) wins over the legacy model tier below it.
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveHarnessSwitch(HOST_A, "claude"),
      ).toEqual({
        modelSlug: "sonnet-4.5",
        reasoningEffort: "high",
        serviceTier: "flex",
      });
      // A host with neither its own record nor its own run settings still
      // reaches the legacy model tier.
      expect(
        useComposerHarnessMemoryStore
          .getState()
          .resolveHarnessSwitch(HOST_B, "claude"),
      ).toEqual({
        modelSlug: "legacy-model",
        reasoningEffort: "low",
        serviceTier: null,
      });
    });
  });
});
