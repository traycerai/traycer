import "../../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { landingComposerSettingsSeedForDraft } from "@/components/home/composer/landing-composer-settings-seed";

const DRAFT_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "haiku",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const GLOBAL_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

describe("landingComposerSettingsSeedForDraft", () => {
  it("uses global settings only when there is no active draft", () => {
    expect(
      landingComposerSettingsSeedForDraft(
        null,
        DRAFT_SETTINGS,
        GLOBAL_SETTINGS,
      ),
    ).toEqual(GLOBAL_SETTINGS);
  });

  it("keeps an active draft with null settings from following global settings", () => {
    expect(
      landingComposerSettingsSeedForDraft("draft-empty", null, GLOBAL_SETTINGS),
    ).toBeNull();
  });

  it("uses copied draft settings over later global settings", () => {
    expect(
      landingComposerSettingsSeedForDraft(
        "draft-haiku",
        DRAFT_SETTINGS,
        GLOBAL_SETTINGS,
      ),
    ).toEqual(DRAFT_SETTINGS);
  });
});
