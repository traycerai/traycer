import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";
import { contentBlocksText } from "@/lib/chat/content-block-text";

describe("contentBlocksText", () => {
  it("falls back to the plain text for an ordinary text block", () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: "text",
        blockId: "text-1",
        status: "completed",
        timestamp: 1,
        text: "Hello there.",
        providerNotice: null,
      },
    ];

    expect(contentBlocksText(blocks)).toBe("Hello there.");
  });

  it("includes provider notice title, message, and detail label/value text", () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      {
        type: "text",
        blockId: "notice-1",
        status: "completed",
        timestamp: 1,
        text: "Codex switched from gpt-5 to gpt-5-safe.",
        providerNotice: {
          harnessId: "codex",
          noticeKind: "model_rerouted",
          tone: "warning",
          title: "Model changed",
          message: "Codex switched from gpt-5 to gpt-5-safe.",
          details: [{ label: "Reason", value: "highRiskCyberActivity" }],
          metadata: {
            type: "model_rerouted",
            fromModel: "gpt-5",
            toModel: "gpt-5-safe",
            reason: "highRiskCyberActivity",
          },
        },
      },
    ];

    const text = contentBlocksText(blocks);
    expect(text).toContain("Model changed");
    expect(text).toContain("Codex switched from gpt-5 to gpt-5-safe.");
    expect(text).toContain("Reason: highRiskCyberActivity");
  });
});
