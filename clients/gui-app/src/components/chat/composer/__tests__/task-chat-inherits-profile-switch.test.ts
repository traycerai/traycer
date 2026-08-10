import { describe, expect, it } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { taskChatInheritsProfileSwitch } from "../use-task-profile-rate-limit-switch";

function settings(overrides: Partial<ChatRunSettings>): ChatRunSettings {
  return {
    harnessId: "claude",
    model: "opus[1m]",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: "limited",
    ...overrides,
  };
}

const CRITERIA = {
  harnessId: "claude" as const,
  profileId: "limited" as const,
  selectedModelSlug: "opus[1m]",
};

describe("taskChatInheritsProfileSwitch", () => {
  it("includes a sibling on the same harness, profile, and model", () => {
    expect(taskChatInheritsProfileSwitch(settings({}), CRITERIA)).toBe(true);
  });

  it("excludes a sibling on the same profile but a different model", () => {
    // The destination is validated strictly-better only for the composer's
    // Opus selection; a Fable sibling must not ride that guarantee onto a
    // profile that may be equal or worse for Fable.
    expect(
      taskChatInheritsProfileSwitch(
        settings({ model: "claude-fable-5[1m]" }),
        CRITERIA,
      ),
    ).toBe(false);
  });

  it("excludes a sibling on a different profile", () => {
    expect(
      taskChatInheritsProfileSwitch(settings({ profileId: "other" }), CRITERIA),
    ).toBe(false);
  });

  it("excludes a sibling on a different harness", () => {
    expect(
      taskChatInheritsProfileSwitch(settings({ harnessId: "codex" }), CRITERIA),
    ).toBe(false);
  });

  it("treats a null persisted profileId as the ambient profile", () => {
    expect(
      taskChatInheritsProfileSwitch(settings({ profileId: null }), {
        ...CRITERIA,
        profileId: null,
      }),
    ).toBe(true);
  });

  it("matches no persisted sibling when the composer model is unresolved", () => {
    // settings.model is always a concrete slug, so a null selected slug can
    // never match - task-wide switching is withheld until the model resolves.
    expect(
      taskChatInheritsProfileSwitch(settings({}), {
        ...CRITERIA,
        selectedModelSlug: null,
      }),
    ).toBe(false);
  });
});
