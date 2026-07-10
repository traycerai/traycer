import "../../../../__tests__/test-browser-apis";
import { beforeEach, describe, expect, it } from "vitest";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { commitSelection } from "@/stores/composer/commit-selection";
import { useComposerHarnessMemoryStore } from "@/stores/composer/composer-harness-memory-store";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerHarnessMemoryKey } from "@/lib/persist";

const STORAGE_KEY = composerHarnessMemoryKey(null);

function resetMemory(): void {
  window.localStorage.clear();
  useComposerHarnessMemoryStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerHarnessMemoryStore.getState().resetForTests();
  useComposerRunSettingsStore.getState().resetForTests();
}

// Mid-chat profile switching rides `commitSelection`, the same funnel a
// harness switch uses - this is the "turn-boundary switch" commit half of the
// multi-profile feature (the other half, forcing a fresh upstream session, is
// host-side in `prepareHarnessSessionForSend`).
describe("commitSelection - profile switch", () => {
  beforeEach(resetMemory);

  it("commits a different profile for the same harness/model without touching either", () => {
    const emitted: Array<{ harnessId: string; profileId: string | null }> = [];
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
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: (settings) =>
        emitted.push({
          harnessId: settings.harnessId,
          profileId: settings.profileId,
        }),
      tuiOnly: false,
    });

    commitSelection(store, "claude", "sonnet-4.5", "profile-b");

    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "sonnet-4.5",
      profileId: "profile-b",
    });
    expect(emitted.at(-1)).toEqual({
      harnessId: "claude",
      profileId: "profile-b",
    });
    expect(
      useComposerHarnessMemoryStore.getState().resolveLastProfile("claude"),
    ).toBe("profile-b");
  });

  it("restores the profile's own remembered model on a rail-entry profile switch", () => {
    // Seed memory: profile-a last ran sonnet-4.5, profile-b last ran opus-4.
    useComposerHarnessMemoryStore.getState().record({
      harnessId: "claude",
      model: "sonnet-4.5",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: "profile-a",
    });
    useComposerHarnessMemoryStore.getState().record({
      harnessId: "claude",
      model: "opus-4",
      permissionMode: "supervised",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "regular",
      profileId: "profile-b",
    });

    const emitted: Array<{ modelSlug: string; profileId: string | null }> = [];
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
        serviceTier: "",
        agentMode: "regular",
      },
      onSettingsChange: (settings) =>
        emitted.push({
          modelSlug: settings.model,
          profileId: settings.profileId,
        }),
      tuiOnly: false,
    });

    // Rail-entry click: modelSlug is null, so the harness-switch resolver
    // restores profile-b's own last model, not profile-a's.
    commitSelection(store, "claude", null, "profile-b");

    expect(store.getState().selection).toEqual({
      harnessId: "claude",
      modelSlug: "opus-4",
      profileId: "profile-b",
    });
    expect(emitted.at(-1)).toEqual({
      modelSlug: "opus-4",
      profileId: "profile-b",
    });
  });
});
