import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelProviderMark } from "@/components/home/pickers/model-provider-icons";

/**
 * The bug class these guard against is upstream's, not a hypothetical: their
 * generated name list drifted from their generated sprite, so `llmgateway`
 * passed the "do we have it" check and then rendered nothing at all.
 */

/** The mark actually chosen for a row: the id itself, or `"generic"`. */
function markFor(id: string, configDeclaredCustom: boolean): string {
  const { container, unmount } = render(
    <ModelProviderMark id={id} configDeclaredCustom={configDeclaredCustom} />,
  );
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
      expect(markFor(id, false)).toBe(id);
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
      expect(markFor(id, false)).toBe(id);
    }
  });

  it("covers the plan and region variants the catalog actually ships", () => {
    // Checked against the real `models.dev` catalog (183 ids), not guessed: the
    // coding-plan and region suffixes are a large share of the tail, and each
    // one is a separate row a user sees.
    for (const id of [
      "togetherai",
      "zhipuai",
      "zhipuai-coding-plan",
      "siliconflow",
      "siliconflow-cn",
      "xiaomi",
      "xiaomi-token-plan-cn",
      "tencent-coding-plan",
      "stepfun-step-plan",
      "302ai",
      "watsonx",
      "snowflake-cortex",
    ]) {
      expect(markFor(id, false)).toBe(id);
    }
  });

  it("falls back for an unknown id instead of rendering nothing", () => {
    // Upstream's failure was an invisible icon, which reads as a broken row
    // rather than an unknown provider.
    expect(markFor("zzz-not-real", false)).toBe("generic");
  });

  it("gives a user-declared custom provider the generic mark", () => {
    // It has no brand, and borrowing one would put a real company's logo on
    // someone's private gateway.
    expect(markFor("my-gateway", true)).toBe("generic");
    expect(markFor("wafer.ai", true)).toBe("generic");
  });

  it("refuses a brand mark to a DECLARED row, even under a mapped id", () => {
    // `isConfigDeclaredCustom` judges a block by its `npm` and model map, never
    // its key - so a hand-written `provider.openai` block pointing at a private
    // endpoint is a legal custom declaration under a mapped id. Painting
    // OpenAI's mark on it is the impersonation the neutral fallback exists to
    // prevent, arriving through the one door the id cannot close.
    expect(markFor("openai", true)).toBe("generic");
    expect(markFor("anthropic", true)).toBe("generic");
    // And an ordinary row under the same id keeps its brand.
    expect(markFor("openai", false)).toBe("openai");
  });

  it("never MAPS a provider onto the fallback glyph", () => {
    // The fallback is sparkles, matching what users already read as "no logo"
    // in OpenCode - and the invariant that keeps it honest is that no real
    // provider is mapped to it. Upstream's sparkles IS Synthetic's logo, which
    // is why their unknown-provider case and that company's row are the same
    // picture; here these ids simply have no mark, and say so.
    for (const id of ["synthetic", "chutes", "requesty", "wandb"]) {
      expect(markFor(id, false)).toBe("generic");
    }
    // A mapped id must never answer "generic" - that would mean a brand was
    // pointed at the fallback glyph.
    for (const id of ["anthropic", "openai", "google", "xai"]) {
      expect(markFor(id, false)).not.toBe("generic");
    }
  });
});
