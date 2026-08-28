import { beforeEach, describe, expect, it } from "vitest";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import {
  commitProfileSelection,
  commitSelection,
} from "@/stores/composer/commit-selection";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerHarnessMemoryKey } from "@/lib/persist";

const STORAGE_KEY = composerHarnessMemoryKey(null);

const HOST_A = "host-a";
const HOST_B = "host-b";

function resetMemory(): void {
  window.localStorage.clear();
  useComposerHarnessMemoryStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
}

describe("commitProfileSelection", () => {
  beforeEach(resetMemory);

  it("changes only the profile when provider memory contains different model settings", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      harnessId: "claude",
      model: "opus-4",
      permissionMode: "supervised",
      reasoningEffort: "low",
      serviceTier: "standard",
      agentMode: "regular",
      profileId: "profile-b",
    });

    const emitted: Array<{
      model: string;
      profileId: string | null;
      reasoningEffort: string | null;
      serviceTier: string | null;
    }> = [];
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: "profile-a",
        },
        reasoning: "high",
        serviceTier: "fast",
      },
      onSettingsChange: (settings) =>
        emitted.push({
          model: settings.model,
          profileId: settings.profileId,
          reasoningEffort: settings.reasoningEffort,
          serviceTier: settings.serviceTier,
        }),
      tuiOnly: false,
      hostId: HOST_A,
    });

    commitProfileSelection(store, "profile-b");

    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "sonnet-4.5",
      profileId: "profile-b",
    });
    expect(store.getState().reasoning).toBe("high");
    expect(store.getState().serviceTier).toBe("fast");
    expect(emitted.at(-1)).toEqual({
      model: "sonnet-4.5",
      profileId: "profile-b",
      reasoningEffort: "high",
      serviceTier: "fast",
    });
    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveLastProfile(HOST_A, "claude"),
    ).toBe("profile-b");
  });
});

describe("commitSelection - provider switch", () => {
  beforeEach(resetMemory);

  it("restores the provider's last model independently of its selected profile", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      harnessId: "claude",
      model: "opus-4",
      permissionMode: "supervised",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "regular",
      profileId: "profile-b",
    });
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      harnessId: "claude",
      model: "sonnet-4.5",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular",
      profileId: "profile-a",
    });

    const emitted: Array<{ modelSlug: string; profileId: string | null }> = [];
    const store = createComposerToolbarStore({
      seedKey: "seed-1",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "codex",
          modelSlug: "gpt-5.5",
          profileId: null,
        },
        reasoning: "high",
        serviceTier: "",
      },
      onSettingsChange: (settings) =>
        emitted.push({
          modelSlug: settings.model,
          profileId: settings.profileId,
        }),
      tuiOnly: false,
      hostId: HOST_A,
    });

    // Provider-rail click: modelSlug is null, so the provider switch restores
    // its last model/config while committing the independently chosen profile.
    commitSelection(store, "claude", null, "profile-b");

    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "sonnet-4.5",
      profileId: "profile-b",
    });
    expect(store.getState().reasoning).toBe("high");
    expect(store.getState().serviceTier).toBe("fast");
    expect(emitted.at(-1)).toEqual({
      modelSlug: "sonnet-4.5",
      profileId: "profile-b",
    });
  });
});

describe("commitSelection - host scoping", () => {
  beforeEach(resetMemory);

  it("reads and writes harness memory keyed by the toolbar store's catalog.hostId, not another host's", () => {
    useComposerHarnessMemoryStore.getState().record(HOST_A, {
      harnessId: "claude",
      model: "opus-4",
      permissionMode: "supervised",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    });

    const store = createComposerToolbarStore({
      seedKey: "seed-host-b",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "codex",
          modelSlug: "gpt-5.5",
          profileId: null,
        },
        reasoning: "high",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      hostId: HOST_B,
    });

    // Host B has no memory of its own, so the provider switch does NOT pick
    // up host A's remembered model.
    commitSelection(store, "claude", null, null);

    expect(store.getState().selection.modelSlug).toBe("");
  });

  it("commits and records against the store's own host, leaving other hosts untouched", () => {
    const store = createComposerToolbarStore({
      seedKey: "seed-host-a",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "codex",
          modelSlug: "gpt-5.5",
          profileId: null,
        },
        reasoning: "high",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      hostId: HOST_A,
    });

    commitSelection(store, "claude", "sonnet-4.5", "profile-a");

    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveLastProfile(HOST_A, "claude"),
    ).toBe("profile-a");
    expect(
      useComposerHarnessMemoryStore
        .getState()
        .resolveLastProfile(HOST_B, "claude"),
    ).toBeNull();
  });

  it("drops the memory write entirely when the store's catalog has no resolved host yet", () => {
    const store = createComposerToolbarStore({
      seedKey: "seed-null-host",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sonnet-4.5",
          profileId: null,
        },
        reasoning: "high",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      hostId: null,
    });

    commitSelection(store, "claude", "sonnet-4.5", "profile-a");

    expect(useComposerHarnessMemoryStore.getState().byHost).toEqual({});
  });
});
