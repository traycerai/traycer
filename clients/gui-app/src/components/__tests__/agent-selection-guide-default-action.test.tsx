import { describe, expect, it } from "vitest";
import { resolveAgentSelectionGuideDefaultAction } from "@/components/agent-selection-guide-default-action";

describe("resolveAgentSelectionGuideDefaultAction", () => {
  it("marks guides that already match the current default as current-default", () => {
    const action = resolveAgentSelectionGuideDefaultAction({
      value: "codex guide",
      generatedDefaultContent: "codex guide",
      recognizedDefaultContents: ["codex guide", "claude guide"],
      providersSettled: true,
      mode: "saved-guide",
    });

    expect(action.kind).toBe("current-default");
    expect(action.buttonLabel).toBe("Restore");
    expect(action.buttonTooltip).toBeNull();
  });

  it("shows update for saved guides that match a recognized older default", () => {
    const action = resolveAgentSelectionGuideDefaultAction({
      value: "claude guide",
      generatedDefaultContent: "codex guide",
      recognizedDefaultContents: ["codex guide", "claude guide"],
      providersSettled: true,
      mode: "saved-guide",
    });

    expect(action.kind).toBe("update");
    expect(action.buttonLabel).toBe("Update");
    expect(action.buttonTooltip).toBe(
      "Update this guide to the current provider defaults.",
    );
  });

  it("shows restore instead of update while onboarding owns a missing-file draft", () => {
    const action = resolveAgentSelectionGuideDefaultAction({
      value: "claude guide",
      generatedDefaultContent: "codex guide",
      recognizedDefaultContents: ["codex guide", "claude guide"],
      providersSettled: true,
      mode: "missing-guide-draft",
    });

    expect(action.kind).toBe("restore");
    expect(action.buttonLabel).toBe("Restore");
    expect(action.buttonTooltip).toBe(
      "Replace custom global instructions with the current provider defaults.",
    );
  });

  it("gates actions while provider defaults are still settling", () => {
    const action = resolveAgentSelectionGuideDefaultAction({
      value: "claude guide",
      generatedDefaultContent: "codex guide",
      recognizedDefaultContents: ["codex guide", "claude guide"],
      providersSettled: false,
      mode: "saved-guide",
    });

    expect(action.kind).toBe("checking");
    expect(action.buttonLabel).toBe("Checking");
    expect(action.buttonTooltip).toBeNull();
  });
});
