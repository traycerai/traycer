import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  COMPOSER_RUN_SETTINGS_EPIC_CAP,
  useComposerRunSettingsStore,
} from "@/stores/composer/composer-run-settings-store";
import { composerRunSettingsKey } from "@/lib/persist";

const STORAGE_KEY = composerRunSettingsKey(null);

const REGULAR_RUN_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "gpt-5-codex",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const EPIC_RUN_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet-4.5",
  permissionMode: "full_access",
  reasoningEffort: "high",
  serviceTier: "flex",
  agentMode: "epic",
  profileId: null,
};

function resetComposerRunSettingsStore(): void {
  window.localStorage.clear();
  useComposerRunSettingsStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerRunSettingsStore.getState().resetForTests();
}

function persistState(state: unknown): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state,
      version: 1,
    }),
  );
}

describe("composer run settings store", () => {
  beforeEach(resetComposerRunSettingsStore);
  afterEach(resetComposerRunSettingsStore);

  it("rehydrates persisted global settings via default hydration", async () => {
    persistState({
      globalLastRunSettings: REGULAR_RUN_SETTINGS,
      epicRunSettingsByEpicId: {},
    });

    await useComposerRunSettingsStore.persist.rehydrate();

    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toEqual(REGULAR_RUN_SETTINGS);
  });

  it("rehydrates persisted per-epic entries via default hydration", async () => {
    persistState({
      globalLastRunSettings: null,
      epicRunSettingsByEpicId: {
        "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
      },
    });

    await useComposerRunSettingsStore.persist.rehydrate();

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicId,
    ).toEqual({
      "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
    });
  });

  it("setGlobalRunSettings does not alter per-epic entries", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", EPIC_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(REGULAR_RUN_SETTINGS, 20);

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicId,
    ).toEqual({
      "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
    });
  });

  it("setGlobalRunSettings ignores unresolved model settings", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(REGULAR_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings({ ...EPIC_RUN_SETTINGS, model: "" }, 20);

    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toEqual(REGULAR_RUN_SETTINGS);
  });

  it("setEpicRunSettings does not alter global settings", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(REGULAR_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", EPIC_RUN_SETTINGS, 20);

    expect(
      useComposerRunSettingsStore.getState().globalLastRunSettings,
    ).toEqual(REGULAR_RUN_SETTINGS);
  });

  it("setEpicRunSettings ignores unresolved model settings", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", EPIC_RUN_SETTINGS, 10);

    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", { ...REGULAR_RUN_SETTINGS, model: "" }, 20);

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicId,
    ).toEqual({
      "epic-1": { settings: EPIC_RUN_SETTINGS, updatedAt: 10 },
    });
  });

  it("cap keeps only the newest 200 entries", () => {
    for (
      let index = 0;
      index < COMPOSER_RUN_SETTINGS_EPIC_CAP + 1;
      index += 1
    ) {
      useComposerRunSettingsStore
        .getState()
        .setEpicRunSettings(`epic-${index}`, REGULAR_RUN_SETTINGS, index);
    }

    const entries =
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicId;
    expect(Object.keys(entries)).toHaveLength(COMPOSER_RUN_SETTINGS_EPIC_CAP);
    expect(entries["epic-0"]).toBeUndefined();
    expect(entries[`epic-${COMPOSER_RUN_SETTINGS_EPIC_CAP}`]).toEqual({
      settings: REGULAR_RUN_SETTINGS,
      updatedAt: COMPOSER_RUN_SETTINGS_EPIC_CAP,
    });
  });

  it("clearEpicRunSettings removes only requested epic ids", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", REGULAR_RUN_SETTINGS, 10);
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-2", EPIC_RUN_SETTINGS, 20);

    useComposerRunSettingsStore.getState().clearEpicRunSettings(["epic-1"]);

    expect(
      useComposerRunSettingsStore.getState().epicRunSettingsByEpicId,
    ).toEqual({
      "epic-2": { settings: EPIC_RUN_SETTINGS, updatedAt: 20 },
    });
  });

  it("auth bucket helper returns anonymous and email-scoped keys", () => {
    expect(composerRunSettingsKey(null)).toBe(
      "traycer-gui-app:composer-run-settings:anon",
    );
    expect(composerRunSettingsKey("alice@example.com")).toBe(
      "traycer-gui-app:composer-run-settings:alice@example.com",
    );
  });
});
