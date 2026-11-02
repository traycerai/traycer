import { describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { landingComposerSettingsSeedForDraft } from "@/components/home/composer/landing-composer-settings-seed";

const DRAFT_SETTINGS: ChatRunSettings = {
  ultracode: false,
  harnessId: "claude",
  model: "haiku",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const GLOBAL_SETTINGS: ChatRunSettings = {
  ultracode: false,
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

  it("falls back to the host's settings with the request off for an active draft that has none", () => {
    expect(
      landingComposerSettingsSeedForDraft("draft-empty", null, {
        ...GLOBAL_SETTINGS,
        ultracode: true,
      }),
    ).toEqual(GLOBAL_SETTINGS);
  });

  it("seeds nothing for an active draft with no settings on a host that has none", () => {
    expect(
      landingComposerSettingsSeedForDraft("draft-empty", null, null),
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
