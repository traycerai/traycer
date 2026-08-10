import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelProviderMark } from "@/components/home/pickers/model-provider-icons";

/**
 * The bug class these guard against is upstream's, not a hypothetical: their
 * generated name list drifted from their generated sprite, so `llmgateway`
 * passed the "do we have it" check and then rendered nothing at all.
 */

/** The mark actually chosen for an id: the id itself, or `"generic"`. */
function markFor(id: string): string {
  const { container, unmount } = render(<ModelProviderMark id={id} />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error(`no svg rendered for ${id}`);
  const chosen = svg.getAttribute("data-model-provider-icon");
  unmount();
  return chosen ?? "";
}

describe("model provider icons", () => {
  it("resolves the ids a user is most likely to see", () => {
    for (const id of [
      "anthropic",
      "openai",
      "google",
      "google-vertex",
      "amazon-bedrock",
      "openrouter",
      "groq",
      "mistral",
      "deepseek",
      "xai",
      "github-copilot",
      "huggingface",
    ]) {
      expect(markFor(id)).toBe(id);
    }
  });

  it("maps plan and region variants onto the brand they belong to", () => {
    // `alibaba-coding-plan` is a billing arrangement, not another company.
    for (const id of [
      "alibaba-cn",
      "alibaba-coding-plan",
      "minimax-cn",
      "moonshotai-cn",
      "cloudflare-ai-gateway",
    ]) {
      expect(markFor(id)).toBe(id);
    }
  });

  it("falls back for an unknown id instead of rendering nothing", () => {
    // Upstream's failure was an invisible icon, which reads as a broken row
    // rather than an unknown provider.
    expect(markFor("zzz-not-real")).toBe("generic");
  });

  it("gives a user-declared custom provider the generic mark", () => {
    // It has no brand, and borrowing one would put a real company's logo on
    // someone's private gateway.
    expect(markFor("my-gateway")).toBe("generic");
    expect(markFor("wafer.ai")).toBe("generic");
  });

  it("never hands back a real brand as the fallback", () => {
    // The whole point of choosing our own: upstream's fallback IS Synthetic's
    // logo, so 14 named providers render as that company's mark.
    for (const id of ["synthetic", "chutes", "requesty", "wandb"]) {
      expect(markFor(id)).toBe("generic");
    }
  });
});
