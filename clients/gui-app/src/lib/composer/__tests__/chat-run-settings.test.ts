import { describe, expect, it } from "vitest";

import {
  buildChatRunSettings,
  modelSupportsImageAttachments,
  permissionFromChatRunSettings,
  selectedModelRejectsImageAttachments,
} from "@/lib/composer/chat-run-settings";
import {
  findReasoningOptionsForModel,
  KIMI_K3_DEFAULT_REASONING_OPTIONS,
  type ModelOption,
} from "@/components/home/data/landing-options";

/**
 * Helper to construct a test `ModelOption` with metadata and optional property overrides.
 *
 * @param metadata - The metadata record for the model option.
 * @param overrides - Optional field overrides to merge into the default model option shape.
 * @returns A complete `ModelOption` object for testing.
 */
function model(
  metadata: Record<string, unknown>,
  overrides: Partial<ModelOption> | undefined = undefined,
): ModelOption {
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
    ...overrides,
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
      }),
    ).toEqual({
      harnessId: "codex",
      model: "",
      permissionMode: "full_access",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
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

  it("detects image-capable model metadata and harness capabilities", () => {
    expect(
      modelSupportsImageAttachments(
        model({ inputModalities: ["text", "image"] }),
      ),
    ).toBe(true);
    expect(modelSupportsImageAttachments(model({ supportsImages: true }))).toBe(
      true,
    );

    // K3 models on kimi, hermes, and omp harnesses support image attachments
    const kimiK3 = model({}, { harnessId: "kimi", slug: "k3-256k" });
    const hermesK3 = model(
      {},
      { harnessId: "hermes", slug: "kimi-coding:k3-256k" },
    );
    const ompK3 = model({}, { harnessId: "omp", slug: "kimi-code/k3-256k" });

    expect(modelSupportsImageAttachments(kimiK3)).toBe(true);
    expect(modelSupportsImageAttachments(hermesK3)).toBe(true);
    expect(modelSupportsImageAttachments(ompK3)).toBe(true);

    // Non-K3 model on kimi harness without image metadata stays text-only
    const kimiTextOnly = model({}, { harnessId: "kimi", slug: "kimi-text-v1" });
    expect(modelSupportsImageAttachments(kimiTextOnly)).toBe(false);

    // Unrelated generic models are text-only by default
    expect(selectedModelRejectsImageAttachments(model({}))).toBe(true);
    expect(selectedModelRejectsImageAttachments(null)).toBe(false);
  });

  it("provides fallback reasoning effort options for K3 models with missing metadata", () => {
    // K3 model on kimi harness with empty reasoning metadata receives fallbacks
    const kimiK3 = model({}, { harnessId: "kimi", slug: "k3-256k" });
    expect(findReasoningOptionsForModel(kimiK3)).toEqual(
      KIMI_K3_DEFAULT_REASONING_OPTIONS,
    );

    // K3 model on hermes harness receives fallbacks
    const hermesK3 = model(
      {},
      { harnessId: "hermes", slug: "kimi-coding:k3-256k" },
    );
    expect(findReasoningOptionsForModel(hermesK3)).toEqual(
      KIMI_K3_DEFAULT_REASONING_OPTIONS,
    );

    // Model with explicit reasoning metadata keeps its own options
    const explicitEffortOption = {
      id: "low",
      label: "Low",
      description: null,
    };
    const explicitModel = model(
      {},
      {
        harnessId: "kimi",
        slug: "k3-256k",
        supportedReasoningEfforts: [explicitEffortOption],
      },
    );
    expect(findReasoningOptionsForModel(explicitModel)).toEqual([
      explicitEffortOption,
    ]);

    // Non-K3 model with empty reasoning metadata returns empty array
    const nonK3Model = model({}, { harnessId: "codex", slug: "gpt-4o" });
    expect(findReasoningOptionsForModel(nonK3Model)).toEqual([]);

    // Null model returns empty array
    expect(findReasoningOptionsForModel(null)).toEqual([]);
  });
});
