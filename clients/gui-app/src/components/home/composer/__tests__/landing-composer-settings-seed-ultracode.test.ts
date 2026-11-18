import { describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { landingComposerSettingsSeedForDraft } from "@/components/home/composer/landing-composer-settings-seed";
import { parseChatRunSettings } from "@/stores/home/landing-draft-store";

/**
 * A landing composer starts every new chat with the request off: the global
 * last-run seed never carries it and a draft is restored without it, but the
 * draft the person is editing right now keeps what they just chose.
 */

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

describe("landingComposerSettingsSeedForDraft", () => {
  it("seeds a draftless composer from the last run with the request off", () => {
    expect(landingComposerSettingsSeedForDraft(null, null, REQUESTED)).toEqual({
      ...REQUESTED,
      ultracode: false,
    });
  });

  it("keeps the request the person chose on the draft being edited", () => {
    expect(
      landingComposerSettingsSeedForDraft("draft-1", REQUESTED, null),
    ).toEqual(REQUESTED);
  });

  it("seeds nothing when there is neither a draft nor a last run", () => {
    expect(
      landingComposerSettingsSeedForDraft(null, REQUESTED, null),
    ).toBeNull();
  });
});

describe("parseChatRunSettings", () => {
  it("restores a stored draft's settings with the request off", () => {
    expect(parseChatRunSettings(REQUESTED)).toEqual({
      ...REQUESTED,
      ultracode: false,
    });
  });

  it("restores a draft stored before the request existed as off", () => {
    const { ultracode: _absent, ...legacy } = REQUESTED;
    expect(parseChatRunSettings(legacy)?.ultracode).toBe(false);
  });

  it("restores nothing for a missing or invalid payload", () => {
    expect(parseChatRunSettings(null)).toBeNull();
    expect(parseChatRunSettings({ harnessId: "claude" })).toBeNull();
  });
});
