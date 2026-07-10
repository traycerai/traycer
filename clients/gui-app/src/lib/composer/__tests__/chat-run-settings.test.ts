import { describe, expect, it } from "vitest";

import {
  buildChatRunSettings,
  modelSupportsImageAttachments,
  permissionFromChatRunSettings,
  selectedModelRejectsImageAttachments,
} from "@/lib/composer/chat-run-settings";
import type { ModelOption } from "@/components/home/data/landing-options";

function model(metadata: Record<string, unknown>): ModelOption {
  return {
    harnessId: "codex",
    slug: "gpt-test",
    label: "GPT Test",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata,
  };
}

describe("chat run settings", () => {
  it("maps GUI permissions to runtime permissions", () => {
    expect(
      buildChatRunSettings({
        selection: {
          harnessId: "codex",
          modelSlug: "gpt-test",
          profileId: null,
        },
        permission: "supervised",
        reasoning: "high",
        serviceTier: "",
        agentMode: "regular",
      }),
    ).toEqual({
      harnessId: "codex",
      model: "gpt-test",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    });

    expect(
      buildChatRunSettings({
        selection: { harnessId: "codex", modelSlug: "", profileId: null },
        permission: "full_access",
        reasoning: "",
        serviceTier: "",
        agentMode: "epic",
      }),
    ).toEqual({
      harnessId: "codex",
      model: "",
      permissionMode: "full_access",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "epic",
      profileId: null,
    });

    expect(
      buildChatRunSettings({
        selection: {
          harnessId: "opencode",
          modelSlug: "opencode-live",
          profileId: null,
        },
        permission: "auto_accept_edits",
        reasoning: "medium",
        serviceTier: "fast",
        agentMode: "regular",
      }),
    ).toEqual({
      harnessId: "opencode",
      model: "opencode-live",
      permissionMode: "auto_accept_edits",
      reasoningEffort: "medium",
      serviceTier: "fast",
      agentMode: "regular",
      profileId: null,
    });
  });

  it("maps runtime permissions back to GUI permissions", () => {
    expect(
      permissionFromChatRunSettings({
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      }),
    ).toBe("supervised");
    expect(
      permissionFromChatRunSettings({
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "auto_accept_edits",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      }),
    ).toBe("auto_accept_edits");
    expect(
      permissionFromChatRunSettings({
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "full_access",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      }),
    ).toBe("full_access");
  });

  it("detects image-capable model metadata", () => {
    expect(
      modelSupportsImageAttachments(
        model({ inputModalities: ["text", "image"] }),
      ),
    ).toBe(true);
    expect(modelSupportsImageAttachments(model({ supportsImages: true }))).toBe(
      true,
    );
    expect(selectedModelRejectsImageAttachments(model({}))).toBe(true);
    expect(selectedModelRejectsImageAttachments(null)).toBe(false);
  });
});
