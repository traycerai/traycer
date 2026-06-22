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
        selection: { harnessId: "codex", modelSlug: "gpt-test" },
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
    });

    expect(
      buildChatRunSettings({
        selection: { harnessId: "codex", modelSlug: "" },
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
    });

    expect(
      buildChatRunSettings({
        selection: { harnessId: "opencode", modelSlug: "opencode-live" },
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
