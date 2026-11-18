import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { useComposerRunSettingsStore } from "@/stores/composer/composer-run-settings-store";
import { composerRunSettingsKey } from "@/lib/persist";

/**
 * The per-chat Ultracode request is the chat's own saved intent. The "last
 * run" and per-epic remembered settings that seed a new composer never carry
 * it: a new chat starts off, whatever the last chat asked for, whether the
 * value arrives through a write or through persisted storage.
 */

const STORAGE_KEY = composerRunSettingsKey(null);
const HOST = "host-a";

const REQUESTED: ChatRunSettings = {
  ultracode: true,
  harnessId: "claude",
  model: "claude-opus-4-7",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

function resetStore(): void {
  window.localStorage.clear();
  useComposerRunSettingsStore.persist.setOptions({ name: STORAGE_KEY });
  useComposerRunSettingsStore.getState().resetForTests();
}

describe("composer run settings store Ultracode", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("remembers a global last run as off even when the run asked for it", () => {
    useComposerRunSettingsStore
      .getState()
      .setGlobalRunSettings(HOST, REQUESTED, 1);

    expect(
      useComposerRunSettingsStore.getState().getGlobalRunSettings(HOST),
    ).toEqual({ ...REQUESTED, ultracode: false });
  });

  it("remembers an epic's settings as off even when the run asked for it", () => {
    useComposerRunSettingsStore
      .getState()
      .setEpicRunSettings("epic-1", HOST, REQUESTED, 1);

    expect(
      useComposerRunSettingsStore.getState().getEpicRunSettings("epic-1", HOST),
    ).toEqual({ ...REQUESTED, ultracode: false });
  });

  it("reads a persisted global setting that holds the request back as off", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          globalLastRunSettings: REQUESTED,
          epicRunSettingsByEpicId: {},
        },
        version: 1,
      }),
    );

    await useComposerRunSettingsStore.persist.rehydrate();

    expect(
      useComposerRunSettingsStore.getState().legacyGlobalLastRunSettings,
    ).toEqual({ ...REQUESTED, ultracode: false });
  });
});
